/**
 * Subscription sign-ins beyond ChatGPT (which lives in codexauth.ts):
 *
 * - Claude (Anthropic Pro/Max): the `claude setup-token` PKCE flow. The user
 *   approves at claude.ai and pastes back the displayed "CODE#STATE" string;
 *   the Worker exchanges it for the long-lived sk-ant-oat01 token that the
 *   container exports as CLAUDE_CODE_OAUTH_TOKEN.
 * - GitHub Copilot: GitHub's device-code flow with the Copilot client id the
 *   editor integrations share. The resulting OAuth token is what OpenCode's
 *   github-copilot provider stores as its "refresh" credential.
 * - Cloudflare wrangler: wrangler's own PKCE client. Its only registered
 *   redirect is http://localhost:8976/oauth/callback, so after approving the
 *   user pastes the (unreachable) localhost URL from the address bar and the
 *   Worker completes the code exchange. Tokens land in the container as
 *   wrangler's config/default.toml; wrangler refreshes them itself from there.
 *
 * All three reuse public, secret-less client ids exactly as the corresponding
 * CLIs do (same approach as the Codex flow; see codexauth.ts for rationale).
 * Attempts are single-use rows in oauth_states, bound to the signing-in user.
 */
import { Hono } from "hono";
import { type WranglerOauth, WranglerOauthSchema } from "@codestation/contract";
import { requireUser } from "./auth.js";
import { upsertCredentials } from "./credentials.js";
import { pushCredentialsToContainer } from "./github.js";
import { checkOauthState, deleteOauthState, putOauthState } from "./oauthstate.js";
import type { AppContext } from "./types.js";

const ATTEMPT_TTL_MS = 15 * 60 * 1000;

// -- Claude (claude setup-token flow) -----------------------------------------

/** Claude Code's public (PKCE, secret-less) OAuth client. */
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** setup-token scopes: yields the long-lived token, not the 8-hour session. */
const CLAUDE_SCOPES = "user:inference user:profile";

// -- GitHub Copilot (device-code flow) ----------------------------------------

/** The GitHub App client id Copilot editor integrations authenticate with. */
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

// -- Cloudflare wrangler (PKCE flow) ------------------------------------------

/** wrangler's public (PKCE, secret-less) OAuth client. */
const WRANGLER_CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const WRANGLER_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const WRANGLER_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
/** The only redirect wrangler's client has registered — never actually served. */
const WRANGLER_REDIRECT_URI = "http://localhost:8976/oauth/callback";
/** wrangler login's default scopes plus offline_access for the refresh token. */
const WRANGLER_SCOPES = [
  "account:read",
  "user:read",
  "workers:write",
  "workers_kv:write",
  "workers_routes:write",
  "workers_scripts:write",
  "workers_tail:read",
  "d1:write",
  "pages:write",
  "zone:read",
  "ssl_certs:write",
  "ai:write",
  "queues:write",
  "pipelines:write",
  "offline_access",
];

// -- PKCE helpers ---------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 43-char random PKCE verifier, doubling as the OAuth `state` (the pattern
 * the Claude CLI uses): the finish request carries the state back, which is
 * exactly the verifier the exchange needs, so nothing beyond the attempt row
 * has to be stored.
 */
function newVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Parse a JSON request body; null (never a throw) on malformed input. */
async function readJson<T>(c: { req: { json(): Promise<unknown> } }): Promise<T | null> {
  return (await c.req.json().catch(() => null)) as T | null;
}

function logFailure(event: string, err: unknown): void {
  // Log the failure kind only, never token material (§10).
  console.log(JSON.stringify({ event, error: String(err) }));
}

export const subscriptionRoutes = new Hono<AppContext>()

  // ---------------------------------------------------------------- Claude
  .post("/api/claude/oauth/start", requireUser, async (c) => {
    const verifier = newVerifier();
    await putOauthState(c.env, `claude:${verifier}`, c.get("user").id, ATTEMPT_TTL_MS);
    const params = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_CLIENT_ID,
      response_type: "code",
      redirect_uri: CLAUDE_REDIRECT_URI,
      scope: CLAUDE_SCOPES,
      code_challenge: await s256Challenge(verifier),
      code_challenge_method: "S256",
      state: verifier,
    });
    return c.json({
      authorizeUrl: `${CLAUDE_AUTHORIZE_URL}?${params}`,
      expiresInSec: ATTEMPT_TTL_MS / 1000,
    });
  })

  .post("/api/claude/oauth/finish", requireUser, async (c) => {
    const body = await readJson<{ code?: string }>(c);
    const pasted = typeof body?.code === "string" ? body.code.trim() : "";
    const [code, state] = pasted.split("#");
    if (!code || !state || pasted.length > 2048) {
      return c.json({ error: "paste the full code, including the part after #" }, 400);
    }
    const stateKey = `claude:${state}`;
    if (!(await checkOauthState(c.env, stateKey, c.get("user").id))) {
      return c.json({ error: "unknown or expired sign-in attempt — start over" }, 403);
    }
    await deleteOauthState(c.env, stateKey); // single-use, even if the exchange fails

    let accessToken: string;
    try {
      const res = await fetch(CLAUDE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          state,
          client_id: CLAUDE_CLIENT_ID,
          redirect_uri: CLAUDE_REDIRECT_URI,
          code_verifier: state,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`anthropic token endpoint ${res.status}`);
      const json = (await res.json()) as { access_token?: string };
      if (!json.access_token) throw new Error("anthropic token response malformed");
      accessToken = json.access_token;
    } catch (err) {
      logFailure("claude_oauth_finish_failed", err);
      return c.json({ error: "Claude sign-in failed — start over and try again" }, 502);
    }

    await upsertCredentials(c.env, c.get("user").id, {
      llmKeys: { claude_subscription_token: accessToken },
    });
    await pushCredentialsToContainer(c.env, c.get("user").id);
    return c.json({ status: "connected" });
  })

  // ---------------------------------------------------------------- Copilot
  .post("/api/copilot/device", requireUser, async (c) => {
    let start: { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number };
    try {
      const res = await fetch(GITHUB_DEVICE_CODE_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`github device code endpoint ${res.status}`);
      start = (await res.json()) as typeof start;
      if (!start.device_code || !start.user_code || !start.verification_uri) {
        throw new Error("github device code response malformed");
      }
    } catch (err) {
      logFailure("copilot_device_start_failed", err);
      return c.json({ error: "could not reach GitHub — try again in a minute" }, 502);
    }
    const expiresInSec = start.expires_in ?? ATTEMPT_TTL_MS / 1000;
    await putOauthState(
      c.env,
      `copilot:${start.device_code}`,
      c.get("user").id,
      expiresInSec * 1000,
    );
    return c.json({
      deviceCode: start.device_code,
      userCode: start.user_code,
      verificationUrl: start.verification_uri,
      intervalSec: start.interval && start.interval > 0 ? start.interval : 5,
      expiresInSec,
    });
  })

  .post("/api/copilot/device/poll", requireUser, async (c) => {
    const body = await readJson<{ deviceCode?: string }>(c);
    if (typeof body?.deviceCode !== "string" || !body.deviceCode || body.deviceCode.length > 256) {
      return c.json({ error: "bad request" }, 400);
    }
    const stateKey = `copilot:${body.deviceCode}`;
    if (!(await checkOauthState(c.env, stateKey, c.get("user").id))) {
      return c.json({ error: "unknown or expired sign-in attempt — start over" }, 403);
    }

    let poll: { access_token?: string; error?: string };
    try {
      const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: COPILOT_CLIENT_ID,
          device_code: body.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`github access token endpoint ${res.status}`);
      poll = (await res.json()) as typeof poll;
    } catch (err) {
      await deleteOauthState(c.env, stateKey);
      logFailure("copilot_device_poll_failed", err);
      return c.json({ error: "GitHub sign-in failed — start over and try again" }, 502);
    }
    if (poll.error === "authorization_pending" || poll.error === "slow_down") {
      return c.json({ status: "pending" });
    }
    await deleteOauthState(c.env, stateKey);
    if (!poll.access_token) {
      logFailure("copilot_device_poll_failed", poll.error ?? "no access_token");
      return c.json({ error: "GitHub sign-in failed — start over and try again" }, 502);
    }

    await upsertCredentials(c.env, c.get("user").id, {
      llmKeys: { github_copilot: poll.access_token },
    });
    await pushCredentialsToContainer(c.env, c.get("user").id);
    return c.json({ status: "connected" });
  })

  // ---------------------------------------------------------------- wrangler
  .post("/api/wrangler/oauth/start", requireUser, async (c) => {
    const verifier = newVerifier();
    await putOauthState(c.env, `wrangler:${verifier}`, c.get("user").id, ATTEMPT_TTL_MS);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: WRANGLER_CLIENT_ID,
      redirect_uri: WRANGLER_REDIRECT_URI,
      scope: WRANGLER_SCOPES.join(" "),
      state: verifier,
      code_challenge: await s256Challenge(verifier),
      code_challenge_method: "S256",
    });
    return c.json({
      authorizeUrl: `${WRANGLER_AUTHORIZE_URL}?${params}`,
      expiresInSec: ATTEMPT_TTL_MS / 1000,
    });
  })

  .post("/api/wrangler/oauth/finish", requireUser, async (c) => {
    const body = await readJson<{ callbackUrl?: string }>(c);
    const raw = typeof body?.callbackUrl === "string" ? body.callbackUrl.trim() : "";
    let code = "";
    let state = "";
    try {
      const url = new URL(raw);
      if (url.hostname !== "localhost" || url.pathname !== "/oauth/callback") throw new Error();
      code = url.searchParams.get("code") ?? "";
      state = url.searchParams.get("state") ?? "";
    } catch {
      return c.json(
        { error: "paste the full localhost address from your browser's address bar" },
        400,
      );
    }
    if (!code || !state || raw.length > 4096) {
      return c.json({ error: "that address has no sign-in code — approve access first" }, 400);
    }
    const stateKey = `wrangler:${state}`;
    if (!(await checkOauthState(c.env, stateKey, c.get("user").id))) {
      return c.json({ error: "unknown or expired sign-in attempt — start over" }, 403);
    }
    await deleteOauthState(c.env, stateKey); // single-use, even if the exchange fails

    let wranglerOauth: WranglerOauth;
    try {
      const res = await fetch(WRANGLER_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: WRANGLER_REDIRECT_URI,
          client_id: WRANGLER_CLIENT_ID,
          code_verifier: state,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`cloudflare token endpoint ${res.status}`);
      const json = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!json.access_token || !json.refresh_token) {
        throw new Error("cloudflare token response malformed");
      }
      wranglerOauth = WranglerOauthSchema.parse({
        oauth_token: json.access_token,
        refresh_token: json.refresh_token,
        expiration_time: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
        scopes: (json.scope ? json.scope.split(" ") : WRANGLER_SCOPES).filter(
          (s) => s !== "offline_access",
        ),
      });
    } catch (err) {
      logFailure("wrangler_oauth_finish_failed", err);
      return c.json({ error: "Cloudflare sign-in failed — start over and try again" }, 502);
    }

    await upsertCredentials(c.env, c.get("user").id, {
      wranglerOauth: JSON.stringify(wranglerOauth),
    });
    await pushCredentialsToContainer(c.env, c.get("user").id);
    return c.json({ status: "connected" });
  });
