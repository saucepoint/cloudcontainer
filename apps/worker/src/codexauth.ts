/**
 * "Sign in with ChatGPT" for Codex subscriptions (§5 wizard / §9). Drives
 * OpenAI's device-code flow control-plane-side: the dashboard shows a one-time
 * code, the user approves it at auth.openai.com from any browser, and the
 * Worker exchanges the resulting authorization code for tokens and stores them
 * as the `codex_subscription_token` auth.json blob — the exact shim path a
 * pasted ~/.codex/auth.json takes, so sealing, live refresh, and rebuilds all
 * behave identically.
 *
 * OpenAI offers no third-party OAuth registration for ChatGPT-plan auth; this
 * reuses the Codex CLI's public PKCE client id (as OpenCode does). If OpenAI
 * ever blocks it, the pasted-auth.json path under "Advanced options" remains.
 * Flow details mirror codex-rs/login/src/device_code_auth.rs: the poll
 * response carries the PKCE verifier, so no verifier state is held here.
 */
import { Hono } from "hono";
import { requireUser } from "./auth.js";
import { upsertCredentials } from "./credentials.js";
import { pushCredentialsToContainer } from "./github.js";
import type { AppContext, Bindings } from "./types.js";

const OPENAI_ISSUER = "https://auth.openai.com";
/** The Codex CLI's public (PKCE, secret-less) OAuth client. */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** OpenAI expires the user code after 15 minutes. */
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_SEC = 5;

export interface DeviceAuthStart {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSec: number;
  expiresInSec: number;
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "authorized"; authJson: string };

/** Ask OpenAI for a one-time user code the person approves in their browser. */
export async function requestDeviceCode(): Promise<DeviceAuthStart> {
  const res = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`openai usercode endpoint ${res.status}`);
  const json = (await res.json()) as {
    device_auth_id?: string;
    user_code?: string;
    usercode?: string;
    interval?: string | number;
  };
  const userCode = json.user_code ?? json.usercode;
  if (!json.device_auth_id || !userCode) throw new Error("openai usercode response malformed");
  const interval = Number(json.interval);
  return {
    deviceAuthId: json.device_auth_id,
    userCode,
    verificationUrl: `${OPENAI_ISSUER}/codex/device`,
    intervalSec: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_SEC,
    expiresInSec: DEVICE_AUTH_TTL_MS / 1000,
  };
}

/**
 * One poll attempt. 403/404 mean "user hasn't approved yet" (per the Codex
 * CLI); success yields an authorization code plus the server-minted PKCE pair,
 * which we immediately exchange for tokens.
 */
export async function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string,
): Promise<DevicePollResult> {
  const res = await fetch(`${OPENAI_ISSUER}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 404) return { status: "pending" };
  if (!res.ok) throw new Error(`openai device token endpoint ${res.status}`);
  const code = (await res.json()) as {
    authorization_code?: string;
    code_verifier?: string;
  };
  if (!code.authorization_code || !code.code_verifier) {
    throw new Error("openai device token response malformed");
  }

  const tokenRes = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code.authorization_code,
      redirect_uri: `${OPENAI_ISSUER}/deviceauth/callback`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: code.code_verifier,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) throw new Error(`openai token endpoint ${tokenRes.status}`);
  const { id_token, access_token, refresh_token } = (await tokenRes.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };
  if (!id_token || !access_token || !refresh_token) {
    throw new Error("openai token response malformed");
  }
  return {
    status: "authorized",
    authJson: buildCodexAuthJson({ id_token, access_token, refresh_token }),
  };
}

/** Claims under the id_token's "https://api.openai.com/auth" namespace. */
function jwtAuthClaims(idToken: string): Record<string, unknown> {
  try {
    const payload = idToken.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64)) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    return auth && typeof auth === "object" ? (auth as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Assemble the file the Codex CLI would have written itself (AuthDotJson in
 * codex-rs): the daemon injects this verbatim at ~/.codex/auth.json and the
 * in-container CLI owns token refresh from then on.
 */
export function buildCodexAuthJson(tokens: {
  id_token: string;
  access_token: string;
  refresh_token: string;
}): string {
  const accountId = jwtAuthClaims(tokens.id_token)["chatgpt_account_id"];
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: typeof accountId === "string" ? accountId : null,
    },
    last_refresh: new Date().toISOString(),
  });
}

/** Parse a JSON request body; null (never a throw) on malformed input. */
async function readJson<T>(c: { req: { json(): Promise<unknown> } }): Promise<T | null> {
  return (await c.req.json().catch(() => null)) as T | null;
}

const stateKey = (deviceAuthId: string) => `codex:${deviceAuthId}`;

async function deleteState(env: Bindings, deviceAuthId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?")
    .bind(stateKey(deviceAuthId))
    .run();
}

export const codexAuthRoutes = new Hono<AppContext>()

  .post("/api/codex/device", requireUser, async (c) => {
    let start: DeviceAuthStart;
    try {
      start = await requestDeviceCode();
    } catch (err) {
      // Log the failure kind only, never token material (§10).
      console.log(JSON.stringify({ event: "codex_device_start_failed", error: String(err) }));
      return c.json({ error: "could not reach OpenAI — try again or paste auth.json" }, 502);
    }
    // Bind the attempt to this user so nobody else can poll it into their account.
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO oauth_states (state, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind(stateKey(start.deviceAuthId), c.get("user").id, now, now + DEVICE_AUTH_TTL_MS)
      .run();
    return c.json(start);
  })

  .post("/api/codex/device/poll", requireUser, async (c) => {
    const body = await readJson<{ deviceAuthId?: string; userCode?: string }>(c);
    if (!body?.deviceAuthId || !body.userCode) return c.json({ error: "bad request" }, 400);
    const row = await c.env.DB.prepare(
      "SELECT user_id, expires_at FROM oauth_states WHERE state = ?",
    )
      .bind(stateKey(body.deviceAuthId))
      .first<{ user_id: string; expires_at: number }>();
    if (!row || row.user_id !== c.get("user").id || row.expires_at < Date.now()) {
      return c.json({ error: "unknown or expired sign-in attempt — start over" }, 403);
    }

    let result: DevicePollResult;
    try {
      result = await pollDeviceAuth(body.deviceAuthId, body.userCode);
    } catch (err) {
      await deleteState(c.env, body.deviceAuthId);
      console.log(JSON.stringify({ event: "codex_device_poll_failed", error: String(err) }));
      return c.json({ error: "ChatGPT sign-in failed — try again or paste auth.json" }, 502);
    }
    if (result.status === "pending") return c.json({ status: "pending" });

    await deleteState(c.env, body.deviceAuthId);
    await upsertCredentials(c.env, c.get("user").id, {
      llmKeys: { codex_subscription_token: result.authJson },
    });
    // Applies live, same as any credential rotation (§5 U5).
    await pushCredentialsToContainer(c.env, c.get("user").id);
    return c.json({ status: "connected" });
  });
