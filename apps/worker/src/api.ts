import { Hono } from "hono";
import {
  AGENTS,
  GithubReposSchema,
  INPUT_LIMITS,
  toHex,
  type JobOp,
  type Tier,
} from "@workbench/contract";
import { billingStatusForUser } from "./billing-routes.js";
import {
  requireAccount,
  requireCredentialSetup,
} from "./auth.js";
import {
  CREDENTIAL_CATEGORIES,
  deleteStoredCredentialCategory,
  deleteStoredCredentials,
  upsertCredentials,
  validateCloudflareToken,
  validateConvexToken,
  validateSupabaseToken,
} from "./credentials.js";
import { normalizeCredentialInput, type CredentialInput } from "./credential-input.js";
import { containerView, credentialsView, currentContainerView } from "./container-view.js";
import {
  fetchGithubPublicSshKeys,
  githubAccessToken,
  pushCredentialsToContainer,
  validGithubUsername,
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
import { accountAccessForUser } from "./entitlements.js";
import { cancelUnreservedPlanTransition } from "./plan-transitions.js";
import { readJsonBody } from "./http.js";
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationsForUser,
  unreadNotificationCount,
} from "./notifications.js";
import { allowedUserOps } from "./state.js";
import {
  SETUP_DRAFT_CATEGORIES,
  clearSetupDraftCategory,
  deleteSetupDraft,
  getSetupDraft,
  normalizeSetupDraftInput,
  putSetupDraft,
} from "./setup-draft.js";
import {
  insertSshKey,
  normalizeSshKeyLabel,
  SSH_KEY_LABEL_MAX_LENGTH,
  sshCommandFor,
  sshKeysView,
  sshSetupReady,
  validPubkey,
} from "./ssh.js";
import type { AppContext, ContainerRow } from "./types.js";
import {
  getWorkbenchConfiguration,
  putWorkbenchConfiguration,
} from "./workbench-configuration.js";

const ENROLLMENT_TOKEN_TTL_SEC = 3600;
const SSH_SETUP_NOT_READY_ERROR =
  "Wait for your workbench to finish building before changing SSH keys or creating an SSH setup prompt.";

interface DeveloperTokens {
  cloudflareToken?: string;
  supabaseToken?: string;
  convexToken?: string;
}

function isCredentialCategory(value: string): value is (typeof CREDENTIAL_CATEGORIES)[number] {
  return (CREDENTIAL_CATEGORIES as readonly string[]).includes(value);
}

function isSetupDraftCategory(value: string): value is (typeof SETUP_DRAFT_CATEGORIES)[number] {
  return (SETUP_DRAFT_CATEGORIES as readonly string[]).includes(value);
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

const deleteCredentials = async (c: Parameters<typeof requireAccount>[0]) => {
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

  // ------------------------------------------------------------ setup draft
  // Drafts contain only non-secret selections and expire after one day. The
  // credential flows continue to persist their encrypted values separately.
  .get("/api/setup-draft", requireAccount, requireCredentialSetup, async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ draft: await getSetupDraft(c.env, c.get("user").id) });
  })
  .put("/api/setup-draft", requireAccount, requireCredentialSetup, async (c) => {
    const body = await readJsonBody<unknown>(c);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "bad request" }, 400);
    }
    const normalized = normalizeSetupDraftInput(body);
    if ("error" in normalized) return c.json({ error: normalized.error }, 400);
    c.header("cache-control", "no-store");
    return c.json({
      draft: await putSetupDraft(c.env, c.get("user").id, normalized.value),
    });
  })
  .delete("/api/setup-draft", requireAccount, requireCredentialSetup, async (c) => {
    await deleteSetupDraft(c.env, c.get("user").id);
    return c.json({ ok: true });
  })
  .delete("/api/setup-draft/:category", requireAccount, requireCredentialSetup, async (c) => {
    const category = c.req.param("category");
    if (!isSetupDraftCategory(category)) return c.json({ error: "unknown setup draft category" }, 400);
    const draft = await clearSetupDraftCategory(c.env, c.get("user").id, category);
    return c.json({ ok: true, draft });
  })

  // ------------------------------------------------------- saved configuration
  .get("/api/configuration", requireAccount, requireCredentialSetup, async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ configuration: await getWorkbenchConfiguration(c.env, c.get("user").id) });
  })
  .put("/api/configuration", requireAccount, requireCredentialSetup, async (c) => {
    const user = c.get("user");
    const body = await readJsonBody<{
      agents?: string[];
      sshPubkey?: string;
      sshKeyLabel?: string;
      sshKeys?: unknown;
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
    if (body.sshPubkey !== undefined && typeof body.sshPubkey !== "string") {
      return c.json({ error: "SSH public key must be text" }, 400);
    }
    if (body.sshKeyLabel !== undefined && typeof body.sshKeyLabel !== "string") {
      return c.json({ error: "SSH key name must be text" }, 400);
    }
    if (
      typeof body.sshKeyLabel === "string" &&
      body.sshKeyLabel.trim().length > SSH_KEY_LABEL_MAX_LENGTH
    ) {
      return c.json({ error: `SSH key name must be ${SSH_KEY_LABEL_MAX_LENGTH} characters or fewer` }, 400);
    }
    const pubkey = body.sshPubkey?.trim();
    if (pubkey && !validPubkey(pubkey)) {
      return c.json({ error: "that does not look like an SSH public key" }, 400);
    }
    const normalized = normalizeCredentialInput(body);
    if ("error" in normalized) return c.json({ error: normalized.error }, 400);
    const validationIssue = await validateDeveloperTokens(normalized.value, false);
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
        const accessible = await verifyGithubRepositories(token, githubRepos);
        const unavailable = githubRepos.find((repo) => !accessible.has(repo));
        if (unavailable) {
          return token
            ? c.json({ error: `GitHub repository is no longer available: ${unavailable}` }, 400)
            : c.json({ error: "connect GitHub to access private repositories" }, 409);
        }
      } catch {
        return c.json({ error: "Could not verify GitHub repositories; retry in a moment" }, 503);
      }
    }

    const requestedKeys = pubkey ? [{ pubkey, label: body.sshKeyLabel ?? "" }] : [];
    if (body.sshKeys !== undefined && !Array.isArray(body.sshKeys)) {
      return c.json({ error: "SSH keys must be a list" }, 400);
    }
    if (Array.isArray(body.sshKeys)) {
      for (const key of body.sshKeys) {
        if (
          !key || typeof key !== "object" ||
          typeof (key as { pubkey?: unknown }).pubkey !== "string" ||
          ((key as { label?: unknown }).label !== undefined && typeof (key as { label?: unknown }).label !== "string")
        ) {
          return c.json({ error: "SSH keys must contain public keys and optional names" }, 400);
        }
        requestedKeys.push({
          pubkey: (key as { pubkey: string }).pubkey.trim(),
          label: (key as { label?: string }).label ?? "",
        });
      }
    }
    const uniqueKeys = [...new Map(requestedKeys.map((key) => [key.pubkey, key])).values()];
    for (const key of uniqueKeys) {
      if (!key.pubkey || !validPubkey(key.pubkey)) {
        return c.json({ error: "invalid SSH public key" }, 400);
      }
      if (key.label.trim().length > SSH_KEY_LABEL_MAX_LENGTH) {
        return c.json({ error: `SSH key name must be ${SSH_KEY_LABEL_MAX_LENGTH} characters or fewer` }, 400);
      }
    }
    if (uniqueKeys.length > 0) {
      const existingKeys = await c.env.DB.prepare(
        "SELECT pubkey FROM ssh_keys WHERE user_id = ?",
      ).bind(user.id).all<{ pubkey: string }>();
      const existing = new Set(existingKeys.results.map((key) => key.pubkey));
      const newKeys = uniqueKeys.filter((key) => !existing.has(key.pubkey));
      const count = await c.env.DB.prepare(
        "SELECT COUNT(*) AS count FROM ssh_keys WHERE user_id = ?",
      ).bind(user.id).first<{ count: number }>();
      if ((count?.count ?? 0) + newKeys.length > INPUT_LIMITS.sshKeysPerAccount) {
        return c.json({ error: "SSH key limit reached" }, 409);
      }
      for (const key of uniqueKeys) {
        const inserted = await insertSshKey(c.env, user.id, normalizeSshKeyLabel(key.label), key.pubkey);
        if (inserted === "limit") return c.json({ error: "SSH key limit reached" }, 409);
      }
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

    const configuration = await putWorkbenchConfiguration(c.env, user.id, { agents, githubRepos });
    await deleteSetupDraft(c.env, user.id);
    return c.json({ configuration });
  })

  // -------------------------------------------------------------- deployment
  .post("/api/deploy", requireAccount, async (c) => {
    const user = c.get("user");
    const body = await readJsonBody<{ tier?: unknown }>(c);
    if (!body || (body.tier !== "free" && body.tier !== "paid")) {
      return c.json({ error: "Choose the Free or Premium instance." }, 400);
    }
    const tier = body.tier as Tier;
    const existing = await getContainerForUser(c.env, user.id);
    if (existing) return c.json({ error: "A workbench already exists for this account." }, 409);
    const configuration = await getWorkbenchConfiguration(c.env, user.id);
    if (!configuration) {
      return c.json({
        error: "Save your workbench configuration before creating an instance.",
        redirect: "/configure",
      }, 409);
    }
    const access = await accountAccessForUser(c.env, user);
    if (tier === "free" && !access.verified) {
      return c.json({
        error: "Verify your account before creating a Free instance.",
        redirect: "/verify",
      }, 403);
    }
    if (tier === "paid" && !access.premium) {
      return c.json({
        error: "Start a Premium subscription before creating a Premium instance.",
        redirect: "/account#billing",
      }, 403);
    }
    let container: ContainerRow;
    try {
      container = await startProvision(c.env, user, configuration, tier);
    } catch (error) {
      if (error instanceof ProvisioningNotAllowedError) {
        return c.json({ error: "Your account state changed. Refresh the dashboard and try again." }, 409);
      }
      throw error;
    }
    const job = await latestJob(c.env, container.id);
    return c.json({ container: await containerView(c.env, container, job) }, 202);
  })

  // ------------------------------------------------------------------ status poll
  .get("/api/container", requireAccount, async (c) => {
    return c.json({ container: await currentContainerView(c.env, c.get("user").id) });
  })

  // One authenticated round trip for the dashboard's initial, mostly-static state.
  .get("/api/dashboard", requireAccount, async (c) => {
    const user = c.get("user");
    const userId = user.id;
    const [container, configuration, keys, credentials, billing, account] = await Promise.all([
      currentContainerView(c.env, userId),
      getWorkbenchConfiguration(c.env, userId),
      sshKeysView(c.env, userId),
      credentialsView(c.env, userId),
      billingStatusForUser(c.env, user),
      accountAccessForUser(c.env, user),
    ]);
    return c.json({ container, configuration, keys, credentials, billing, account });
  })

  // ---------------------------------------------------------- notifications
  .get("/api/notifications", requireAccount, async (c) => {
    const userId = c.get("user").id;
    const [notifications, unreadCount] = await Promise.all([
      notificationsForUser(c.env, userId),
      unreadNotificationCount(c.env, userId),
    ]);
    c.header("cache-control", "no-store");
    return c.json({ notifications, unreadCount });
  })
  .post("/api/notifications/:id/read", requireAccount, async (c) => {
    await markNotificationRead(c.env, c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/api/notifications/read-all", requireAccount, async (c) => {
    await markAllNotificationsRead(c.env, c.get("user").id);
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ actions
  .post("/api/container/cancel", requireAccount, async (c) => {
    const userId = c.get("user").id;
    const results = (await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM containers
         WHERE user_id = ? AND status = 'waitlisted' AND host_id IS NULL`,
      ).bind(userId),
      c.env.DB.prepare(
        "DELETE FROM waitlist WHERE user_id = ? AND changes() = 1",
      ).bind(userId),
    ])) as Array<{ meta: { changes?: number } }>;
    if (results[0]?.meta.changes) return c.json({ ok: true });

    const container = await getContainerForUser(c.env, userId);
    if (!container) return c.json({ error: "No workbench exists for this account." }, 404);
    return c.json({ error: "Placement has already started; it cannot be withdrawn now." }, 409);
  })
  .post("/api/container/:op", requireAccount, async (c) => {
    const user = c.get("user");
    const op = c.req.param("op");
    let container = await getContainerForUser(c.env, user.id);
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
    if (op === "destroy" && container.status === "upgrade_pending") {
      if (!(await cancelUnreservedPlanTransition(c.env, container.id))) {
        return c.json({
          error: "The resource change has reached the host. Retry deletion after it settles.",
        }, 409);
      }
      container = (await getContainerForUser(c.env, user.id)) ?? container;
    }
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
  .get("/api/keys", requireAccount, async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ keys: await sshKeysView(c.env, c.get("user").id) });
  })
  .get("/api/keys/github", requireAccount, async (c) => {
    c.header("cache-control", "no-store");
    const username = c.req.query("username")?.trim() ?? "";
    if (!validGithubUsername(username)) return c.json({ error: "enter a valid GitHub username" }, 400);
    try {
      const keys = await fetchGithubPublicSshKeys(username);
      return c.json({ username, keys });
    } catch {
      return c.json({ error: "Could not load that GitHub user's public SSH keys" }, 502);
    }
  })
  .post("/api/keys", requireAccount, async (c) => {
    if (!(await sshSetupReady(c.env, c.get("user").id))) {
      return c.json({ error: SSH_SETUP_NOT_READY_ERROR }, 409);
    }
    const body = await readJsonBody<{ pubkey?: string; label?: string }>(c);
    if (body?.label !== undefined && typeof body.label !== "string") {
      return c.json({ error: "key label must be text" }, 400);
    }
    if (typeof body?.label === "string" && body.label.trim().length > SSH_KEY_LABEL_MAX_LENGTH) {
      return c.json({ error: `key name must be ${SSH_KEY_LABEL_MAX_LENGTH} characters or fewer` }, 400);
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
  .post("/api/keys/import/github", requireAccount, async (c) => {
    const userId = c.get("user").id;
    if (!(await sshSetupReady(c.env, userId))) {
      return c.json({ error: SSH_SETUP_NOT_READY_ERROR }, 409);
    }
    const body = await readJsonBody<{ username?: unknown; label?: unknown }>(c);
    if (typeof body?.username !== "string" || !validGithubUsername(body.username)) {
      return c.json({ error: "enter a valid GitHub username" }, 400);
    }
    if (body.label !== undefined && typeof body.label !== "string") {
      return c.json({ error: "key name must be text" }, 400);
    }
    if (typeof body.label === "string" && body.label.trim().length > SSH_KEY_LABEL_MAX_LENGTH) {
      return c.json({ error: `key name must be ${SSH_KEY_LABEL_MAX_LENGTH} characters or fewer` }, 400);
    }
    let githubKeys;
    try {
      githubKeys = await fetchGithubPublicSshKeys(body.username);
    } catch {
      return c.json({ error: "Could not load that GitHub user's public SSH keys" }, 502);
    }
    const existingRows = await c.env.DB.prepare(
      "SELECT pubkey FROM ssh_keys WHERE user_id = ?",
    ).bind(userId).all<{ pubkey: string }>();
    const existing = new Set(existingRows.results.map((key) => key.pubkey));
    const incoming = githubKeys.filter((key, index, all) =>
      !existing.has(key.pubkey) && all.findIndex((candidate) => candidate.pubkey === key.pubkey) === index,
    );
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM ssh_keys WHERE user_id = ?",
    ).bind(userId).first<{ count: number }>();
    if ((count?.count ?? 0) + incoming.length > INPUT_LIMITS.sshKeysPerAccount) {
      return c.json({ error: "Importing these keys would exceed your SSH key limit" }, 409);
    }
    const requestedLabel = typeof body.label === "string" ? normalizeSshKeyLabel(body.label) : "";
    let imported = 0;
    for (const [index, key] of githubKeys.entries()) {
      const label = requestedLabel
        ? githubKeys.length > 1 ? `${requestedLabel} ${index + 1}` : requestedLabel
        : key.label;
      if ((await insertSshKey(c.env, userId, label, key.pubkey)) === "inserted") imported++;
    }
    if (imported > 0) await enqueueJobForUser(c.env, userId, "sync-keys");
    return c.json({
      ok: true,
      found: githubKeys.length,
      imported,
      duplicates: githubKeys.length - imported,
      keys: await sshKeysView(c.env, userId),
    });
  })
  .patch("/api/keys/:id", requireAccount, async (c) => {
    const userId = c.get("user").id;
    if (!(await sshSetupReady(c.env, userId))) {
      return c.json({ error: SSH_SETUP_NOT_READY_ERROR }, 409);
    }
    const body = await readJsonBody<{ label?: unknown }>(c);
    if (typeof body?.label !== "string") return c.json({ error: "key name must be text" }, 400);
    if (body.label.trim().length > SSH_KEY_LABEL_MAX_LENGTH) {
      return c.json({ error: `key name must be ${SSH_KEY_LABEL_MAX_LENGTH} characters or fewer` }, 400);
    }
    const updated = await c.env.DB.prepare(
      "UPDATE ssh_keys SET label = ? WHERE id = ? AND user_id = ?",
    ).bind(normalizeSshKeyLabel(body.label), Number(c.req.param("id")), userId).run();
    if (!updated.meta.changes) return c.json({ error: "SSH key not found" }, 404);
    return c.json({ ok: true, keys: await sshKeysView(c.env, userId) });
  })
  .delete("/api/keys/:id", requireAccount, async (c) => {
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
  .get("/api/credentials", requireAccount, async (c) => {
    return c.json(await credentialsView(c.env, c.get("user").id));
  })
  .delete("/api/credentials", requireAccount, deleteCredentials)
  .delete("/api/credentials/:category", requireAccount, requireCredentialSetup, async (c) => {
    const category = c.req.param("category");
    if (!isCredentialCategory(category)) return c.json({ error: "unknown credential category" }, 400);
    await deleteStoredCredentialCategory(c.env, c.get("user").id, category);
    return c.json({ ok: true });
  })
  // Keep a POST form for clients that do not issue DELETE requests.
  .post("/api/credentials/delete", requireAccount, deleteCredentials)
  .post("/api/credentials", requireAccount, requireCredentialSetup, async (c) => {
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
  .post("/api/enrollment", requireAccount, async (c) => {
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
  .post("/api/account/delete", requireAccount, async (c) => {
    const user = c.get("user");
    const billingAccount = await c.env.DB.prepare(
      "SELECT 1 FROM stripe_customers WHERE user_id = ?",
    ).bind(user.id).first();
    if (billingAccount) {
      return c.json({
        error: "Billing accounts require support-assisted deletion so subscription and invoice records are retained correctly.",
      }, 409);
    }
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
