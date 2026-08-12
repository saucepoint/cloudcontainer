import { Hono } from "hono";
import { githubConfigured } from "./github.js";
import { getContainerForUser } from "./jobs.js";
import { CliAuthPage } from "./pages/views.js";
import { postLoginPath, requireAccount } from "./auth.js";
import { effectiveEntitlementForUser } from "./entitlements.js";
import { signedSessionCookie, createAuth } from "./better-auth.js";
import { readJsonBody } from "./http.js";
import { worldIdConfigured } from "./world-id.js";
import type { AppContext } from "./types.js";

const ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const CODE_TTL_MS = 5 * 60 * 1_000;
const PROVIDERS = ["google", "github"] as const;
type CliAuthProvider = (typeof PROVIDERS)[number];

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return toHex(value);
}

function provider(value: unknown): CliAuthProvider | null {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value)
    ? value as CliAuthProvider
    : null;
}

function validLoopbackCallback(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && Boolean(url.port)
      && !url.username
      && !url.password
      && url.pathname === "/callback"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function validState(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 256
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function providerConfigured(env: AppContext["Bindings"], value: CliAuthProvider): boolean {
  return value === "google"
    ? Boolean(env.AUTH_GOOGLE_CLIENT_ID && env.AUTH_GOOGLE_CLIENT_SECRET)
    : Boolean(env.AUTH_GITHUB_CLIENT_ID && env.AUTH_GITHUB_CLIENT_SECRET);
}

function invalidAttempt(c: Parameters<typeof requireAccount>[0]) {
  return c.text("This CLI sign-in link is invalid or expired. Start `npx usebench` again.", 400);
}

export const cliAuthRoutes = new Hono<AppContext>()
  .post("/api/cli/auth/start", async (c) => {
    const body = await readJsonBody<{
      provider?: unknown;
      callbackUri?: unknown;
      state?: unknown;
    }>(c);
    const selectedProvider = provider(body?.provider);
    if (!selectedProvider || !validLoopbackCallback(body?.callbackUri) || !validState(body?.state)) {
      return c.json({ error: "invalid CLI sign-in request" }, 400);
    }
    if (!providerConfigured(c.env, selectedProvider)) {
      return c.json({ error: `${selectedProvider} sign-in is not configured` }, 503);
    }

    const attemptId = randomToken();
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO cli_auth_attempts
         (id, provider, callback_uri, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      attemptId,
      selectedProvider,
      body.callbackUri,
      body.state,
      now,
      now + ATTEMPT_TTL_MS,
    ).run();

    const browserUrl = new URL("/cli/auth", c.env.BASE_URL);
    browserUrl.searchParams.set("attempt", attemptId);
    return c.json({ browserUrl: browserUrl.toString(), expiresInSec: ATTEMPT_TTL_MS / 1_000 });
  })
  .get("/cli/auth", async (c) => {
    const attemptId = c.req.query("attempt");
    if (!attemptId || !/^[a-f0-9]{64}$/.test(attemptId)) return invalidAttempt(c);
    const attempt = await c.env.DB.prepare(
      "SELECT provider, expires_at FROM cli_auth_attempts WHERE id = ?",
    ).bind(attemptId).first<{ provider: CliAuthProvider; expires_at: number }>();
    if (!attempt || attempt.expires_at < Date.now() || !provider(attempt.provider)) {
      return invalidAttempt(c);
    }
    c.header("cache-control", "no-store");
    return c.html(<CliAuthPage attempt={attemptId} provider={attempt.provider} />);
  })
  .get("/cli/auth/callback", requireAccount, async (c) => {
    const attemptId = c.req.query("attempt");
    if (!attemptId || !/^[a-f0-9]{64}$/.test(attemptId)) return invalidAttempt(c);
    const attempt = await c.env.DB.prepare(
      "SELECT callback_uri, state, expires_at FROM cli_auth_attempts WHERE id = ?",
    ).bind(attemptId).first<{ callback_uri: string; state: string; expires_at: number }>();
    if (!attempt || attempt.expires_at < Date.now() || !validLoopbackCallback(attempt.callback_uri)) {
      return invalidAttempt(c);
    }

    const code = randomToken();
    const codeHash = await sha256Hex(code);
    const now = Date.now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE cli_auth_attempts
         SET completed_at = ?
         WHERE id = ? AND completed_at IS NULL AND expires_at >= ?`,
      ).bind(now, attemptId, now),
      c.env.DB.prepare(
        `INSERT INTO cli_auth_codes
           (code_hash, attempt_id, user_id, created_at, expires_at)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM cli_auth_attempts
           WHERE id = ? AND completed_at = ?
         )`,
      ).bind(codeHash, attemptId, c.get("user").id, now, now + CODE_TTL_MS, attemptId, now),
    ]) as Array<{ meta: { changes?: number } }>;
    if (!results[0]?.meta.changes || !results[1]?.meta.changes) return invalidAttempt(c);

    const callback = new URL(attempt.callback_uri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", attempt.state);
    return c.redirect(callback.toString(), 302);
  })
  .post("/api/cli/auth/exchange", async (c) => {
    const body = await readJsonBody<{ code?: unknown }>(c);
    if (typeof body?.code !== "string" || !/^[a-f0-9]{64}$/.test(body.code)) {
      return c.json({ error: "invalid or expired CLI sign-in code" }, 403);
    }
    const codeHash = await sha256Hex(body.code);
    const now = Date.now();
    const row = await c.env.DB.prepare(
      `SELECT user_id, expires_at, used_at
       FROM cli_auth_codes WHERE code_hash = ?`,
    ).bind(codeHash).first<{ user_id: string; expires_at: number; used_at: number | null }>();
    if (!row || row.used_at || row.expires_at < now) {
      return c.json({ error: "invalid or expired CLI sign-in code" }, 403);
    }
    const marked = await c.env.DB.prepare(
      `UPDATE cli_auth_codes SET used_at = ?
       WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?`,
    ).bind(now, codeHash, now).run();
    if (!marked.meta.changes) return c.json({ error: "invalid or expired CLI sign-in code" }, 403);

    const user = await c.env.DB.prepare(
      "SELECT id, status FROM users WHERE id = ?",
    ).bind(row.user_id).first<{ id: string; status: string }>();
    if (!user || user.status !== "active") return c.json({ error: "account unavailable" }, 403);

    const session = await (await createAuth(c.env, c.req.url).$context)
      .internalAdapter.createSession(user.id);
    if (!session) return c.json({ error: "could not create CLI session" }, 500);
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "set-cookie": await signedSessionCookie(c.env, session.token, c.req.url),
      },
    });
  })
  .get("/api/cli/session", requireAccount, async (c) => {
    const user = c.get("user");
    const [container, entitlement, redirect] = await Promise.all([
      getContainerForUser(c.env, user.id),
      effectiveEntitlementForUser(c.env, user),
      postLoginPath(c.env, user.id),
    ]);
    return c.json({
      verified: Boolean(user.verified_at),
      eligible: entitlement.eligible,
      worldIdAvailable: worldIdConfigured(c.env),
      githubAvailable: githubConfigured(c.env),
      hasWorkbench: Boolean(container),
      redirect,
    });
  });
