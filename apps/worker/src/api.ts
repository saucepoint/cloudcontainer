import { Hono } from "hono";
import { AGENTS, toHex, type JobOp, type LlmKeys } from "@codestation/contract";
import { requireUnrevokedSession, requireUser } from "./auth.js";
import { sha256Hex } from "./sessions.js";
import {
  decryptLlmKeys,
  getCredentialsRow,
  upsertCredentials,
  validateCloudflareToken,
} from "./credentials.js";
import { githubConfigured, pushCredentialsToContainer } from "./github.js";
import {
  containerAgents,
  enqueueJob,
  getContainerForUser,
  getHost,
  latestJob,
  refreshJob,
  startProvision,
} from "./jobs.js";
import { allowedUserOps } from "./state.js";
import type { AppContext, Bindings, ContainerRow, JobRow } from "./types.js";

const SSH_KEY_RE = /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/;

function validPubkey(key: string): boolean {
  return SSH_KEY_RE.test(key.trim()) && key.trim().length < 4096;
}

/** `ssh -p <port> dev@<host>` for a placed container, or null if it has no host/port yet. */
async function sshCommandFor(env: Bindings, container: ContainerRow): Promise<string | null> {
  if (!container.host_id || !container.ssh_port) return null;
  const host = await getHost(env, container.host_id);
  return host ? `ssh -p ${container.ssh_port} dev@${host.ssh_hostname}` : null;
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
    container.status === "running" ? await sshCommandFor(env, container) : null;
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

export const apiRoutes = new Hono<AppContext>()

  // ------------------------------------------------------------------ provision
  .post("/api/provision", requireUser, async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as {
      agents?: string[];
      sshPubkey?: string;
      llmKeys?: Record<string, string>;
      cloudflareToken?: string;
    } | null;
    const requested = new Set(Array.isArray(body?.agents) ? body!.agents : []);
    // Normalize to canonical order; reject empty or unknown picks.
    const agents = AGENTS.filter((a) => requested.has(a));
    if (!body || agents.length === 0 || agents.length !== requested.size) {
      return c.json({ error: `pick at least one agent: ${AGENTS.join(", ")}` }, 400);
    }
    const existing = await getContainerForUser(c.env, user.id);
    if (existing) return c.json({ error: "container already exists" }, 409);

    const pubkey = body.sshPubkey?.trim();
    if (pubkey && !validPubkey(pubkey)) {
      return c.json({ error: "that does not look like an SSH public key" }, 400);
    }
    if (body.cloudflareToken) {
      const ok = await validateCloudflareToken(body.cloudflareToken).catch(() => false);
      if (!ok) return c.json({ error: "Cloudflare token failed validation" }, 400);
    }

    if (pubkey) {
      await c.env.DB.prepare(
        "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES (?, 'onboarding', ?, ?)",
      )
        .bind(user.id, pubkey, Date.now())
        .run();
    }
    const llmKeys = Object.fromEntries(
      Object.entries(body.llmKeys ?? {}).filter(([, v]) => typeof v === "string" && v.trim()),
    );
    if (Object.keys(llmKeys).length > 0 || body.cloudflareToken) {
      await upsertCredentials(c.env, user.id, {
        llmKeys,
        ...(body.cloudflareToken ? { cloudflareToken: body.cloudflareToken } : {}),
      });
    }

    const container = await startProvision(c.env, user, { agents });
    const job = await latestJob(c.env, container.id);
    return c.json({ container: await containerView(c.env, container, job) }, 202);
  })

  // ------------------------------------------------------------------ status poll
  .get("/api/container", requireUser, async (c) => {
    const user = c.get("user");
    const container = await getContainerForUser(c.env, user.id);
    if (!container) return c.json({ container: null });
    let job = await latestJob(c.env, container.id);
    if (job && (job.status === "queued" || job.status === "running")) {
      job = await refreshJob(c.env, job);
    }
    const fresh = (await getContainerForUser(c.env, user.id)) ?? container;
    // Destroy completed -> row is gone.
    if (!fresh) return c.json({ container: null });
    return c.json({ container: await containerView(c.env, fresh, job) });
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
    const rows = await c.env.DB.prepare(
      "SELECT id, label, pubkey, created_at FROM ssh_keys WHERE user_id = ?",
    )
      .bind(c.get("user").id)
      .all();
    return c.json({ keys: rows.results });
  })
  .post("/api/keys", requireUser, async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      pubkey?: string;
      label?: string;
    } | null;
    const pubkey = body?.pubkey?.trim();
    if (!pubkey || !validPubkey(pubkey)) {
      return c.json({ error: "invalid SSH public key" }, 400);
    }
    await c.env.DB.prepare(
      "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(c.get("user").id, (body?.label ?? "").slice(0, 64), pubkey, Date.now())
      .run();
    await syncKeys(c.env, c.get("user").id);
    return c.json({ ok: true });
  })
  .delete("/api/keys/:id", requireUser, async (c) => {
    await c.env.DB.prepare("DELETE FROM ssh_keys WHERE id = ? AND user_id = ?")
      .bind(Number(c.req.param("id")), c.get("user").id)
      .run();
    await syncKeys(c.env, c.get("user").id);
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ credentials
  .get("/api/credentials", requireUser, async (c) => {
    const row = await getCredentialsRow(c.env, c.get("user").id);
    const llm = decryptLlmKeys(c.env, row);
    // Presence only — never the values.
    return c.json({
      llm: Object.fromEntries(Object.keys(llm).map((k) => [k, true])),
      cloudflare: Boolean(row?.cloudflare_token),
      github: row?.github_login ?? (row?.github_token ? "connected" : null),
      githubAvailable: githubConfigured(c.env),
    });
  })
  .post("/api/credentials", requireUser, async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      llmKeys?: Record<string, string>;
      cloudflareToken?: string;
    } | null;
    if (!body) return c.json({ error: "bad request" }, 400);
    if (body.cloudflareToken) {
      const ok = await validateCloudflareToken(body.cloudflareToken).catch(() => false);
      if (!ok) return c.json({ error: "Cloudflare token failed validation" }, 400);
    }
    const llmKeys: LlmKeys = {};
    for (const [k, v] of Object.entries(body.llmKeys ?? {})) {
      if (typeof v === "string") (llmKeys as Record<string, string>)[k] = v.trim();
    }
    await upsertCredentials(c.env, c.get("user").id, {
      llmKeys: llmKeys as Record<string, string>,
      ...(body.cloudflareToken !== undefined ? { cloudflareToken: body.cloudflareToken } : {}),
    });
    // Applies live — key rotation must not wait for a reboot (§5 U5).
    await pushCredentialsToContainer(c.env, c.get("user").id);
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ enrollment (no-key path, U4)
  .post("/api/enrollment", requireUser, async (c) => {
    const user = c.get("user");
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = toHex(tokenBytes);
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO enrollment_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind(await sha256Hex(token), user.id, now + 3600 * 1000)
      .run();
    return c.json({ token, expiresInSec: 3600, endpoint: `${c.env.BASE_URL}/api/enroll` });
  })
  // Public: a local agent redeems the one-time token to register a pubkey.
  .post("/api/enroll", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      token?: string;
      pubkey?: string;
    } | null;
    if (!body?.token || !body.pubkey || !validPubkey(body.pubkey)) {
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
    // Single-use: guard against a concurrent redeem racing this request.
    const marked = await c.env.DB.prepare(
      "UPDATE enrollment_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
    )
      .bind(Date.now(), hash)
      .run();
    if (!marked.meta.changes) return c.json({ error: "invalid or expired token" }, 403);

    await c.env.DB.prepare(
      "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES (?, 'enrolled', ?, ?)",
    )
      .bind(row.user_id, body.pubkey.trim(), Date.now())
      .run();
    await syncKeys(c.env, row.user_id);

    const container = await getContainerForUser(c.env, row.user_id);
    const sshCommand = container ? await sshCommandFor(c.env, container) : null;
    return c.json({ ok: true, sshCommand });
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
    await c.env.SESSIONS.delete(`sess:${c.get("sessionId")}`);
    return c.json({ ok: true });
  });

async function syncKeys(env: AppContext["Bindings"], userId: string): Promise<void> {
  const container = await getContainerForUser(env, userId);
  if (!container?.host_id) return;
  if (container.status !== "running" && container.status !== "stopped") return;
  const host = await getHost(env, container.host_id);
  if (!host) return;
  await enqueueJob(env, "sync-keys", container, host);
}
