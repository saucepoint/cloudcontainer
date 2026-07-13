import { Hono } from "hono";
import {
  AGENTS,
  GithubRepoNameSchema,
  INPUT_LIMITS,
  LLM_PROVIDER_LABELS,
  LLM_PROVIDERS,
  OAUTH_ONLY_LLM_PROVIDERS,
  toHex,
  type JobOp,
  type LlmKeys,
  type LlmProvider,
} from "@codestation/contract";
import {
  requireCredentialSetup,
  requireUnrevokedSession,
  requireUser,
} from "./auth.js";
import { revokeSession, sha256Hex } from "./sessions.js";
import {
  decryptLlmKeys,
  getCredentialsRow,
  upsertCredentials,
  validateCloudflareToken,
} from "./credentials.js";
import {
  fetchGithubRepositories,
  githubAccessToken,
  githubConfigured,
  pushCredentialsToContainer,
} from "./github.js";
import {
  containerAgents,
  enqueueJob,
  enqueueJobForUser,
  getContainerForUser,
  getHost,
  latestJob,
  refreshJob,
  startProvision,
} from "./jobs.js";
import { readJsonBody } from "./http.js";
import { allowedUserOps } from "./state.js";
import type { AppContext, Bindings, ContainerRow, JobRow } from "./types.js";

const SSH_KEY_RE = /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/;
const ENROLLMENT_TOKEN_TTL_SEC = 3600;
const SSH_SETUP_NOT_READY_ERROR =
  "Wait for your server to finish building before changing SSH keys or creating an SSH setup prompt.";
const OAUTH_ONLY_PROVIDER_SET: ReadonlySet<LlmProvider> = new Set(OAUTH_ONLY_LLM_PROVIDERS);

function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

export function validPubkey(key: string): boolean {
  return SSH_KEY_RE.test(key.trim()) && key.trim().length < INPUT_LIMITS.sshKeyBytes;
}

/** SSH key changes need a ready container so they can be applied immediately. */
async function sshSetupReady(env: Bindings, userId: string): Promise<boolean> {
  return (await getContainerForUser(env, userId))?.status === "running";
}

async function insertSshKey(
  env: Bindings,
  userId: string,
  label: string,
  pubkey: string,
): Promise<"inserted" | "duplicate" | "limit"> {
  const normalized = pubkey.trim();
  const existing = await env.DB.prepare(
    "SELECT id FROM ssh_keys WHERE user_id = ? AND pubkey = ? LIMIT 1",
  )
    .bind(userId, normalized)
    .first();
  if (existing) return "duplicate";
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM ssh_keys WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= INPUT_LIMITS.sshKeysPerAccount) return "limit";
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO ssh_keys (user_id, label, pubkey, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(userId, label.slice(0, 64), normalized, Date.now())
    .run();
  return inserted.meta.changes ? "inserted" : "duplicate";
}

interface CredentialInput {
  llmKeys?: Record<string, unknown>;
  cloudflareToken?: unknown;
  wranglerOauth?: unknown;
}

interface NormalizedCredentialInput {
  llmKeys: Record<string, string>;
  cloudflareToken?: string;
  wranglerOauth?: "";
}

/** Validate credential names, types, and sizes before encrypting user input. */
function normalizeCredentialInput(
  input: CredentialInput,
): { value: NormalizedCredentialInput } | { error: string } {
  if (
    input.llmKeys !== undefined &&
    (!input.llmKeys || typeof input.llmKeys !== "object" || Array.isArray(input.llmKeys))
  ) {
    return { error: "llmKeys must be an object" };
  }

  const llmKeys: Record<string, string> = {};
  for (const [provider, raw] of Object.entries(input.llmKeys ?? {})) {
    if (!isLlmProvider(provider)) {
      return { error: `unknown model provider: ${provider || "(empty)"}` };
    }
    if (typeof raw !== "string") return { error: `credential for ${provider} must be text` };
    const value = raw.trim();
    // OAuth-only credentials enter through their sign-in flows; only the
    // empty string (disconnect) is accepted here.
    if (value && OAUTH_ONLY_PROVIDER_SET.has(provider)) {
      return {
        error: `${LLM_PROVIDER_LABELS[provider]} connects via its sign-in button, not a pasted value`,
      };
    }
    if (value.length > INPUT_LIMITS.tokenBytes) {
      return { error: `credential for ${provider} is too large` };
    }
    llmKeys[provider] = value;
  }

  if (input.cloudflareToken !== undefined && typeof input.cloudflareToken !== "string") {
    return { error: "Cloudflare token must be text" };
  }
  const cloudflareToken =
    typeof input.cloudflareToken === "string" ? input.cloudflareToken.trim() : undefined;
  if (cloudflareToken && cloudflareToken.length > INPUT_LIMITS.cloudflareTokenBytes) {
    return { error: "Cloudflare token is too large" };
  }
  // The wrangler sign-in connects via /api/wrangler/oauth; only disconnection
  // (empty string) is accepted here.
  if (input.wranglerOauth !== undefined && input.wranglerOauth !== "") {
    return { error: "Cloudflare wrangler connects via its sign-in button, not a pasted value" };
  }
  return {
    value: {
      llmKeys,
      ...(cloudflareToken !== undefined ? { cloudflareToken } : {}),
      ...(input.wranglerOauth !== undefined ? { wranglerOauth: "" as const } : {}),
    },
  };
}

/** `ssh -p <port> dev@<host>` for a placed container, or null if it has no host/port yet. */
async function sshCommandFor(env: Bindings, container: ContainerRow): Promise<string | null> {
  if (!container.host_id || !container.ssh_port) return null;
  const host = await getHost(env, container.host_id);
  return host ? `ssh -p ${container.ssh_port} dev@${host.ssh_hostname}` : null;
}

/** Do not expose a container's SSH endpoint until the user has a key that can use it. */
async function hasSshKey(env: Bindings, userId: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare("SELECT 1 FROM ssh_keys WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first(),
  );
}

interface ContainerView {
  id: string;
  status: string;
  statusDetail: string | null;
  agents: string[];
  tier: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  sshCommand: string | null;
  hostKeyFingerprints: string[];
  createdAt: number;
  job: { id: string; op: JobOp; status: string; error: string | null } | null;
  allowedOps: JobOp[];
}

async function containerView(
  env: Bindings,
  container: ContainerRow,
  job: JobRow | null,
): Promise<ContainerView> {
  const sshCommand =
    container.status === "running" && (await hasSshKey(env, container.user_id))
      ? await sshCommandFor(env, container)
      : null;
  return {
    id: container.id,
    status: container.status,
    statusDetail: container.status_detail,
    agents: containerAgents(container),
    tier: container.tier,
    cpu: container.cpu,
    ramMb: container.ram_mb,
    diskGb: container.disk_gb,
    sshCommand,
    hostKeyFingerprints: container.host_key_fingerprints
      ? (JSON.parse(container.host_key_fingerprints) as string[])
      : [],
    createdAt: container.created_at,
    job: job ? { id: job.id, op: job.op, status: job.status, error: job.error } : null,
    allowedOps: allowedUserOps(container.status),
  };
}

async function currentContainerView(env: Bindings, userId: string): Promise<ContainerView | null> {
  const container = await getContainerForUser(env, userId);
  if (!container) return null;
  let job = await latestJob(env, container.id);
  if (job && (job.status === "queued" || job.status === "running")) {
    job = await refreshJob(env, job);
  }
  // A completed destroy removes the row while its job is being refreshed.
  const fresh = await getContainerForUser(env, userId);
  return fresh ? containerView(env, fresh, job) : null;
}

async function sshKeysView(env: Bindings, userId: string) {
  const rows = await env.DB.prepare(
    "SELECT id, label, pubkey, created_at FROM ssh_keys WHERE user_id = ? ORDER BY created_at, id",
  )
    .bind(userId)
    .all();
  return rows.results;
}

async function credentialsView(env: Bindings, userId: string) {
  const row = await getCredentialsRow(env, userId);
  const llm = decryptLlmKeys(env, row);
  // Presence only — credential values never leave the control plane.
  return {
    llm: Object.fromEntries(Object.keys(llm).map((key) => [key, true])),
    cloudflare: Boolean(row?.cloudflare_token),
    wrangler: Boolean(row?.wrangler_oauth),
    github: row?.github_login ?? (row?.github_token ? "connected" : null),
    githubAvailable: githubConfigured(env),
  };
}

export const apiRoutes = new Hono<AppContext>()

  // ------------------------------------------------------------------ provision
  .post("/api/provision", requireUser, async (c) => {
    const user = c.get("user");
    const body = await readJsonBody<{
      agents?: string[];
      sshPubkey?: string;
      llmKeys?: Record<string, unknown>;
      cloudflareToken?: unknown;
      githubRepos?: unknown;
    }>(c);
    const requested = new Set(Array.isArray(body?.agents) ? body!.agents : []);
    // Normalize to canonical order; reject empty or unknown picks.
    const agents = AGENTS.filter((a) => requested.has(a));
    if (!body || agents.length === 0 || agents.length !== requested.size) {
      return c.json({ error: `pick at least one agent: ${AGENTS.join(", ")}` }, 400);
    }
    const existing = await getContainerForUser(c.env, user.id);
    if (existing) return c.json({ error: "container already exists" }, 409);

    if (body.sshPubkey !== undefined && typeof body.sshPubkey !== "string") {
      return c.json({ error: "SSH public key must be text" }, 400);
    }
    const pubkey = body.sshPubkey?.trim();
    if (pubkey && !validPubkey(pubkey)) {
      return c.json({ error: "that does not look like an SSH public key" }, 400);
    }
    const normalized = normalizeCredentialInput(body);
    if ("error" in normalized) return c.json({ error: normalized.error }, 400);
    if (normalized.value.cloudflareToken) {
      let ok: boolean;
      try {
        ok = await validateCloudflareToken(normalized.value.cloudflareToken);
      } catch {
        return c.json(
          { error: "Cloudflare validation is temporarily unavailable; remove the token to launch now" },
          503,
        );
      }
      if (!ok) return c.json({ error: "Cloudflare token failed validation" }, 400);
    }

    if (body.githubRepos !== undefined && !Array.isArray(body.githubRepos)) {
      return c.json({ error: "GitHub repositories must be a list" }, 400);
    }
    const githubRepos = [...new Set(body.githubRepos ?? [])];
    if (
      githubRepos.length > INPUT_LIMITS.githubReposPerProvision ||
      githubRepos.some((repo) => !GithubRepoNameSchema.safeParse(repo).success)
    ) {
      return c.json({ error: "invalid GitHub repository selection" }, 400);
    }
    if (githubRepos.length > 0) {
      try {
        const token = await githubAccessToken(c.env, user.id);
        if (!token) return c.json({ error: "connect GitHub before selecting repositories" }, 409);
        const accessible = new Set(
          (await fetchGithubRepositories(token)).map((repo) => repo.fullName),
        );
        const unavailable = githubRepos.find((repo) => !accessible.has(repo as string));
        if (unavailable) {
          return c.json({ error: `GitHub repository is no longer available: ${unavailable}` }, 400);
        }
      } catch {
        return c.json({ error: "Could not verify GitHub repositories; retry in a moment" }, 503);
      }
    }

    if (pubkey) {
      const inserted = await insertSshKey(c.env, user.id, "onboarding", pubkey);
      if (inserted === "limit") return c.json({ error: "SSH key limit reached" }, 409);
    }
    const llmKeys = Object.fromEntries(
      Object.entries(normalized.value.llmKeys).filter(([, value]) => value),
    );
    if (Object.keys(llmKeys).length > 0 || normalized.value.cloudflareToken) {
      await upsertCredentials(c.env, user.id, {
        llmKeys,
        ...(normalized.value.cloudflareToken
          ? { cloudflareToken: normalized.value.cloudflareToken }
          : {}),
      });
    }

    const container = await startProvision(c.env, user, {
      agents,
      githubRepos: githubRepos as string[],
    });
    const job = await latestJob(c.env, container.id);
    return c.json({ container: await containerView(c.env, container, job) }, 202);
  })

  // ------------------------------------------------------------------ status poll
  .get("/api/container", requireUser, async (c) => {
    return c.json({ container: await currentContainerView(c.env, c.get("user").id) });
  })

  // One authenticated round trip for the dashboard's initial, mostly-static state.
  .get("/api/dashboard", requireUser, async (c) => {
    const userId = c.get("user").id;
    const [container, credentials, keys] = await Promise.all([
      currentContainerView(c.env, userId),
      credentialsView(c.env, userId),
      sshKeysView(c.env, userId),
    ]);
    return c.json({ container, credentials, keys });
  })

  // ------------------------------------------------------------------ actions
  .post("/api/container/:op", requireUser, async (c) => {
    const user = c.get("user");
    const op = c.req.param("op");
    const container = await getContainerForUser(c.env, user.id);
    if (!container) return c.json({ error: "no container" }, 404);

    if (op === "retry") {
      if (container.status !== "error") return c.json({ error: "nothing to retry" }, 400);
      if (!container.host_id) return c.json({ error: "no host assigned" }, 409);
      const host = await getHost(c.env, container.host_id);
      if (!host) return c.json({ error: "host unavailable" }, 503);
      const failed = await latestJob(c.env, container.id);
      const retryOp: JobOp = failed && failed.status === "failed" ? failed.op : "provision";
      const job = await enqueueJob(c.env, retryOp, container, host);
      return c.json({ job: { id: job.id, status: job.status } }, 202);
    }

    const validOps: JobOp[] = ["start", "stop", "rebuild", "destroy"];
    if (!validOps.includes(op as JobOp)) return c.json({ error: "unknown action" }, 400);
    if (!allowedUserOps(container.status).includes(op as JobOp)) {
      return c.json({ error: `cannot ${op} while ${container.status}` }, 409);
    }
    if (!container.host_id) return c.json({ error: "no host assigned" }, 409);
    const host = await getHost(c.env, container.host_id);
    if (!host) return c.json({ error: "host unavailable" }, 503);
    const job = await enqueueJob(c.env, op as JobOp, container, host);
    return c.json({ job: { id: job.id, status: job.status } }, 202);
  })

  // ------------------------------------------------------------------ ssh keys
  .get("/api/keys", requireUser, async (c) => {
    return c.json({ keys: await sshKeysView(c.env, c.get("user").id) });
  })
  .post("/api/keys", requireUser, async (c) => {
    if (!(await sshSetupReady(c.env, c.get("user").id))) {
      return c.json({ error: SSH_SETUP_NOT_READY_ERROR }, 409);
    }
    const body = await readJsonBody<{ pubkey?: string; label?: string }>(c);
    if (body?.label !== undefined && typeof body.label !== "string") {
      return c.json({ error: "key label must be text" }, 400);
    }
    const pubkey = typeof body?.pubkey === "string" ? body.pubkey.trim() : undefined;
    if (!pubkey || !validPubkey(pubkey)) {
      return c.json({ error: "invalid SSH public key" }, 400);
    }
    const inserted = await insertSshKey(c.env, c.get("user").id, body?.label ?? "", pubkey);
    if (inserted === "limit") return c.json({ error: "SSH key limit reached" }, 409);
    await enqueueJobForUser(c.env, c.get("user").id, "sync-keys");
    return c.json({ ok: true, duplicate: inserted === "duplicate" });
  })
  .delete("/api/keys/:id", requireUser, async (c) => {
    if (!(await sshSetupReady(c.env, c.get("user").id))) {
      return c.json({ error: SSH_SETUP_NOT_READY_ERROR }, 409);
    }
    await c.env.DB.prepare("DELETE FROM ssh_keys WHERE id = ? AND user_id = ?")
      .bind(Number(c.req.param("id")), c.get("user").id)
      .run();
    await enqueueJobForUser(c.env, c.get("user").id, "sync-keys");
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ credentials
  .get("/api/credentials", requireUser, async (c) => {
    return c.json(await credentialsView(c.env, c.get("user").id));
  })
  .post("/api/credentials", requireUser, requireCredentialSetup, async (c) => {
    const body = await readJsonBody<CredentialInput>(c);
    if (!body) return c.json({ error: "bad request" }, 400);
    const normalized = normalizeCredentialInput(body);
    if ("error" in normalized) return c.json({ error: normalized.error }, 400);
    if (normalized.value.cloudflareToken) {
      let ok: boolean;
      try {
        ok = await validateCloudflareToken(normalized.value.cloudflareToken);
      } catch {
        return c.json({ error: "Cloudflare validation is temporarily unavailable" }, 503);
      }
      if (!ok) return c.json({ error: "Cloudflare token failed validation" }, 400);
    }
    await upsertCredentials(c.env, c.get("user").id, {
      llmKeys: normalized.value.llmKeys as LlmKeys,
      ...(normalized.value.cloudflareToken !== undefined
        ? { cloudflareToken: normalized.value.cloudflareToken }
        : {}),
      ...(normalized.value.wranglerOauth !== undefined
        ? { wranglerOauth: normalized.value.wranglerOauth }
        : {}),
    });
    // Credential setup is only available before provisioning; the provision
    // request carries the stored values to the initial container build.
    await pushCredentialsToContainer(c.env, c.get("user").id);
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ enrollment (no-key path, U4)
  .post("/api/enrollment", requireUser, async (c) => {
    const user = c.get("user");
    if (!(await sshSetupReady(c.env, user.id))) {
      return c.json({ error: SSH_SETUP_NOT_READY_ERROR }, 409);
    }
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = toHex(tokenBytes);
    await c.env.DB.prepare(
      "INSERT INTO enrollment_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind(await sha256Hex(token), user.id, Date.now() + ENROLLMENT_TOKEN_TTL_SEC * 1000)
      .run();
    return c.json({
      token,
      expiresInSec: ENROLLMENT_TOKEN_TTL_SEC,
      endpoint: `${c.env.BASE_URL}/api/enroll`,
    });
  })
  // Public: a local agent redeems the one-time token to register a pubkey.
  .post("/api/enroll", async (c) => {
    const body = await readJsonBody<{ token?: string; pubkey?: string }>(c);
    if (
      typeof body?.token !== "string" ||
      !body.token ||
      typeof body.pubkey !== "string" ||
      !validPubkey(body.pubkey)
    ) {
      return c.json({ error: "token and a valid SSH public key are required" }, 400);
    }
    const hash = await sha256Hex(body.token);
    const row = await c.env.DB.prepare(
      "SELECT user_id, expires_at, used_at FROM enrollment_tokens WHERE token_hash = ?",
    )
      .bind(hash)
      .first<{ user_id: string; expires_at: number; used_at: number | null }>();
    if (!row || row.used_at || row.expires_at < Date.now()) {
      return c.json({ error: "invalid or expired token" }, 403);
    }
    if (!(await sshSetupReady(c.env, row.user_id))) {
      return c.json({ error: SSH_SETUP_NOT_READY_ERROR }, 409);
    }
    // Single-use: guard against a concurrent redeem racing this request.
    const marked = await c.env.DB.prepare(
      "UPDATE enrollment_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
    )
      .bind(Date.now(), hash)
      .run();
    if (!marked.meta.changes) return c.json({ error: "invalid or expired token" }, 403);

    const inserted = await insertSshKey(c.env, row.user_id, "enrolled", body.pubkey);
    if (inserted === "limit") return c.json({ error: "SSH key limit reached" }, 409);
    await enqueueJobForUser(c.env, row.user_id, "sync-keys");

    const container = await getContainerForUser(c.env, row.user_id);
    const sshCommand = container ? await sshCommandFor(c.env, container) : null;
    return c.json({ ok: true, duplicate: inserted === "duplicate", sshCommand });
  })

  // ------------------------------------------------------------------ account deletion (U8)
  .post("/api/account/delete", requireUser, requireUnrevokedSession, async (c) => {
    const user = c.get("user");
    const container = await getContainerForUser(c.env, user.id);
    if (container?.host_id) {
      return c.json({ error: "destroy your container before deleting your account" }, 409);
    }
    if (container) {
      // Waitlisted row with no host — nothing exists on a host, safe to drop.
      await c.env.DB.prepare("DELETE FROM containers WHERE id = ?").bind(container.id).run();
    }
    // Purge credentials and keys; the user row goes last. If the account was
    // banned, the nullifier HMAC in banned_nullifiers persists by design.
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM credentials_encrypted WHERE user_id = ?").bind(user.id),
      c.env.DB.prepare("DELETE FROM ssh_keys WHERE user_id = ?").bind(user.id),
      c.env.DB.prepare("DELETE FROM enrollment_tokens WHERE user_id = ?").bind(user.id),
      c.env.DB.prepare("DELETE FROM oauth_states WHERE user_id = ?").bind(user.id),
      c.env.DB.prepare("DELETE FROM waitlist WHERE user_id = ?").bind(user.id),
      c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
    await revokeSession(c.env, c.get("sessionId"));
    return c.json({ ok: true });
  });
