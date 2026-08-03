import { Hono } from "hono";
import {
  AGENTS,
  GithubReposSchema,
  toHex,
  type JobOp,
} from "@workbench/contract";
import {
  requireCredentialSetup,
  requireUser,
} from "./auth.js";
import {
  deleteStoredCredentials,
  upsertCredentials,
  validateCloudflareToken,
  validateConvexToken,
  validateSupabaseToken,
} from "./credentials.js";
import { normalizeCredentialInput, type CredentialInput } from "./credential-input.js";
import { containerView, credentialsView, currentContainerView } from "./container-view.js";
import {
  githubAccessToken,
  pushCredentialsToContainer,
  verifyGithubRepositories,
} from "./github.js";
import {
  ContainerPlacementConflictError,
  enqueueJob,
  enqueueJobForUser,
  getContainerForUser,
  getHost,
  HostJobAdmissionError,
  latestJob,
  latestLifecycleJob,
  LifecycleJobConflictError,
} from "./jobs.js";
import { ProvisioningNotAllowedError, startProvision } from "./placement.js";
import { readJsonBody } from "./http.js";
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationsForUser,
  unreadNotificationCount,
} from "./notifications.js";
import { allowedUserOps } from "./state.js";
import {
  insertSshKey,
  sshCommandFor,
  sshKeysView,
  sshSetupReady,
  validPubkey,
} from "./ssh.js";
import type { AppContext, ContainerRow } from "./types.js";

const ENROLLMENT_TOKEN_TTL_SEC = 3600;
const SSH_SETUP_NOT_READY_ERROR =
  "Wait for your workbench to finish building before changing SSH keys or creating an SSH setup prompt.";

interface DeveloperTokens {
  cloudflareToken?: string;
  supabaseToken?: string;
  convexToken?: string;
}

async function validateDeveloperTokens(
  tokens: DeveloperTokens,
  provisioning: boolean,
): Promise<{ error: string; status: 400 | 503 } | null> {
  const checks = [
    ["Cloudflare", tokens.cloudflareToken, validateCloudflareToken],
    ["Supabase", tokens.supabaseToken, validateSupabaseToken],
    ["Convex", tokens.convexToken, validateConvexToken],
  ] as const;
  const results = await Promise.all(
    checks.map(async ([provider, token, validate]) => {
      if (!token) return null;
      try {
        return (await validate(token))
          ? null
          : { error: `${provider} token failed validation`, status: 400 as const };
      } catch {
        const launchHint = provisioning ? `; remove the token to launch now` : "";
        return {
          error: `${provider} validation is temporarily unavailable${launchHint}`,
          status: 503 as const,
        };
      }
    }),
  );
  return results.find((result) => result !== null) ?? null;
}

const deleteCredentials = async (c: Parameters<typeof requireUser>[0]) => {
  const userId = c.get("user").id;
  await deleteStoredCredentials(c.env, userId);
  // Send an empty snapshot to a running workbench so the host does not retain
  // credentials that have already been removed from D1.
  await pushCredentialsToContainer(c.env, userId);
  return c.json({ ok: true });
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
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
      supabaseToken?: unknown;
      convexToken?: unknown;
      githubRepos?: unknown;
    }>(c);
    const requested = new Set(body && Array.isArray(body.agents) ? body.agents : []);
    // Normalize to canonical order; reject empty or unknown picks.
    const agents = AGENTS.filter((a) => requested.has(a));
    if (!body || agents.length === 0 || agents.length !== requested.size) {
      return c.json({ error: `pick at least one agent: ${AGENTS.join(", ")}` }, 400);
    }
    const existing = await getContainerForUser(c.env, user.id);
    if (existing) return c.json({ error: "A workbench already exists for this account." }, 409);

    if (body.sshPubkey !== undefined && typeof body.sshPubkey !== "string") {
      return c.json({ error: "SSH public key must be text" }, 400);
    }
    const pubkey = body.sshPubkey?.trim();
    if (pubkey && !validPubkey(pubkey)) {
      return c.json({ error: "that does not look like an SSH public key" }, 400);
    }
    const normalized = normalizeCredentialInput(body);
    if ("error" in normalized) return c.json({ error: normalized.error }, 400);
    const validationIssue = await validateDeveloperTokens(normalized.value, true);
    if (validationIssue) return c.json({ error: validationIssue.error }, validationIssue.status);

    if (body.githubRepos !== undefined && !Array.isArray(body.githubRepos)) {
      return c.json({ error: "GitHub repositories must be a list" }, 400);
    }
    const parsedGithubRepos = GithubReposSchema.safeParse([...new Set(body.githubRepos ?? [])]);
    if (!parsedGithubRepos.success) {
      return c.json({ error: "invalid GitHub repository selection" }, 400);
    }
    const githubRepos = parsedGithubRepos.data;
    if (githubRepos.length > 0) {
      try {
        const token = await githubAccessToken(c.env, user.id);
        if (!token) return c.json({ error: "connect GitHub before selecting repositories" }, 409);
        const accessible = await verifyGithubRepositories(token, githubRepos);
        const unavailable = githubRepos.find((repo) => !accessible.has(repo));
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
    if (
      Object.keys(llmKeys).length > 0 ||
      normalized.value.cloudflareToken ||
      normalized.value.supabaseToken ||
      normalized.value.convexToken
    ) {
      await upsertCredentials(c.env, user.id, {
        llmKeys,
        ...(normalized.value.cloudflareToken
          ? { cloudflareToken: normalized.value.cloudflareToken }
          : {}),
        ...(normalized.value.supabaseToken
          ? { supabaseToken: normalized.value.supabaseToken }
          : {}),
        ...(normalized.value.convexToken
          ? { convexToken: normalized.value.convexToken }
          : {}),
      });
    }

    let container: ContainerRow;
    try {
      container = await startProvision(c.env, user, {
        agents,
        githubRepos,
      });
    } catch (error) {
      if (error instanceof ProvisioningNotAllowedError) {
        return c.json({ error: "This account is not currently eligible to provision a workbench." }, 409);
      }
      throw error;
    }
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
    const [container, keys] = await Promise.all([
      currentContainerView(c.env, userId),
      sshKeysView(c.env, userId),
    ]);
    return c.json({ container, keys });
  })

  // ---------------------------------------------------------- notifications
  .get("/api/notifications", requireUser, async (c) => {
    const userId = c.get("user").id;
    const [notifications, unreadCount] = await Promise.all([
      notificationsForUser(c.env, userId),
      unreadNotificationCount(c.env, userId),
    ]);
    c.header("cache-control", "no-store");
    return c.json({ notifications, unreadCount });
  })
  .post("/api/notifications/:id/read", requireUser, async (c) => {
    await markNotificationRead(c.env, c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/api/notifications/read-all", requireUser, async (c) => {
    await markAllNotificationsRead(c.env, c.get("user").id);
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ actions
  .post("/api/container/:op", requireUser, async (c) => {
    const user = c.get("user");
    const op = c.req.param("op");
    const container = await getContainerForUser(c.env, user.id);
    if (!container) return c.json({ error: "No workbench exists for this account." }, 404);

    if (op === "retry") {
      if (container.status !== "error") return c.json({ error: "nothing to retry" }, 400);
      if (!container.host_id) return c.json({ error: "no host assigned" }, 409);
      const host = await getHost(c.env, container.host_id);
      if (!host) return c.json({ error: "host unavailable" }, 503);
      const failed = await latestLifecycleJob(c.env, container.id);
      const retryOp: JobOp = failed?.status === "failed" ? failed.op : "provision";
      try {
        const job = await enqueueJob(c.env, retryOp, container, host);
        return c.json({ job: { id: job.id, status: job.status } }, 202);
      } catch (error) {
        if (error instanceof HostJobAdmissionError) {
          return c.json({ error: "This host is temporarily unavailable for maintenance." }, 409);
        }
        if (error instanceof LifecycleJobConflictError) {
          return c.json({ error: error.message }, 409);
        }
        if (error instanceof ContainerPlacementConflictError) {
          return c.json({ error: error.message }, 409);
        }
        throw error;
      }
    }

    const validOps: JobOp[] = ["start", "stop", "rebuild", "destroy"];
    if (!validOps.includes(op as JobOp)) return c.json({ error: "unknown action" }, 400);
    if (!allowedUserOps(container.status).includes(op as JobOp)) {
      return c.json({ error: `cannot ${op} while ${container.status}` }, 409);
    }
    if (!container.host_id) return c.json({ error: "no host assigned" }, 409);
    const host = await getHost(c.env, container.host_id);
    if (!host) return c.json({ error: "host unavailable" }, 503);
    try {
      const job = await enqueueJob(c.env, op as JobOp, container, host);
      return c.json({ job: { id: job.id, status: job.status } }, 202);
    } catch (error) {
      if (error instanceof HostJobAdmissionError) {
        return c.json({ error: "This host is temporarily unavailable for maintenance." }, 409);
      }
      if (error instanceof LifecycleJobConflictError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof ContainerPlacementConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
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
  .delete("/api/credentials", requireUser, deleteCredentials)
  // Keep a POST form for clients that do not issue DELETE requests.
  .post("/api/credentials/delete", requireUser, deleteCredentials)
  .post("/api/credentials", requireUser, requireCredentialSetup, async (c) => {
    const body = await readJsonBody<CredentialInput>(c);
    if (!body) return c.json({ error: "bad request" }, 400);
    const normalized = normalizeCredentialInput(body);
    if ("error" in normalized) return c.json({ error: normalized.error }, 400);
    const validationIssue = await validateDeveloperTokens(normalized.value, false);
    if (validationIssue) return c.json({ error: validationIssue.error }, validationIssue.status);
    await upsertCredentials(c.env, c.get("user").id, {
      llmKeys: normalized.value.llmKeys,
      ...(normalized.value.cloudflareToken !== undefined
        ? { cloudflareToken: normalized.value.cloudflareToken }
        : {}),
      ...(normalized.value.supabaseToken !== undefined
        ? { supabaseToken: normalized.value.supabaseToken }
        : {}),
      ...(normalized.value.convexToken !== undefined
        ? { convexToken: normalized.value.convexToken }
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
  .post("/api/account/delete", requireUser, async (c) => {
    const user = c.get("user");
    const container = await getContainerForUser(c.env, user.id);
    if (container?.host_id) {
      return c.json({ error: "destroy your workbench before deleting your account" }, 409);
    }
    // The conditional container claim and every purge share one transaction.
    // If admission or provisioning wins first, the container remains and each
    // guarded cleanup is a no-op; a later failure rolls the whole purge back.
    const results = (await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM containers WHERE user_id = ? AND host_id IS NULL
         AND status IN ('waitlisted','error')`,
      ).bind(user.id),
      c.env.DB.prepare(
        `DELETE FROM credentials_encrypted WHERE user_id = ?
         AND NOT EXISTS (SELECT 1 FROM containers WHERE user_id = ?)`,
      ).bind(user.id, user.id),
      c.env.DB.prepare(
        `DELETE FROM ssh_keys WHERE user_id = ?
         AND NOT EXISTS (SELECT 1 FROM containers WHERE user_id = ?)`,
      ).bind(user.id, user.id),
      c.env.DB.prepare(
        `DELETE FROM enrollment_tokens WHERE user_id = ?
         AND NOT EXISTS (SELECT 1 FROM containers WHERE user_id = ?)`,
      ).bind(user.id, user.id),
      c.env.DB.prepare(
        `DELETE FROM oauth_states WHERE user_id = ?
         AND NOT EXISTS (SELECT 1 FROM containers WHERE user_id = ?)`,
      ).bind(user.id, user.id),
      c.env.DB.prepare(
        `DELETE FROM waitlist WHERE user_id = ?
         AND NOT EXISTS (SELECT 1 FROM containers WHERE user_id = ?)`,
      ).bind(user.id, user.id),
      c.env.DB.prepare(
        `DELETE FROM users WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM containers WHERE user_id = ?)`,
      ).bind(user.id, user.id),
    ])) as Array<{ meta: { changes?: number } }>;
    if (!results.at(-1)?.meta.changes) {
      return c.json({ error: "destroy your workbench before deleting your account" }, 409);
    }
    // The user deletion cascades Better Auth sessions, identities, passkeys,
    // while World ID nullifiers and invite redemptions retain their proof/code
    // so neither eligibility mechanism can be reused for another account.
    return c.json({ ok: true });
  });
