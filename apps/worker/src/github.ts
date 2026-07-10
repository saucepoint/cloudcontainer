/**
 * GitHub App user authorization (§9). The user-to-server token is short-lived
 * (~8 h); the reconciler refreshes it control-plane-side before expiry using
 * the refresh token, which never leaves the control plane. Hosts only ever
 * receive the short-lived token via `refresh-credentials` jobs.
 */
import { Hono } from "hono";
import { encryptJsonAtRest, toHex } from "@codestation/contract";
import { requireUser } from "./auth.js";
import { enqueueJobForUser } from "./jobs.js";
import type { AppContext, Bindings } from "./types.js";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
}

export function githubConfigured(env: Bindings): boolean {
  return Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET);
}

/** POST to GitHub's token endpoint: `{ code }` for the OAuth callback, `{ grant_type, refresh_token }` for refresh. */
export async function exchangeGithubTokens(
  env: Bindings,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      ...params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`github token endpoint ${res.status}`);
  return (await res.json()) as TokenResponse;
}

async function fetchGithubLogin(token: string): Promise<string | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "codestation",
      accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { login?: string };
  return json.login ?? null;
}

export async function storeGithubTokens(
  env: Bindings,
  userId: string,
  tokens: TokenResponse,
): Promise<void> {
  if (!tokens.access_token) throw new Error("github token response missing access_token");
  const key = env.CREDENTIAL_MASTER_KEY;
  const expiresAt = Date.now() + (tokens.expires_in ?? 8 * 3600) * 1000;
  const login = await fetchGithubLogin(tokens.access_token);
  await env.DB.prepare(
    `INSERT INTO credentials_encrypted (user_id, github_token, github_refresh_token, github_expires_at, github_login, rotated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id) DO UPDATE SET
       github_token = ?2,
       github_refresh_token = COALESCE(?3, github_refresh_token),
       github_expires_at = ?4, github_login = COALESCE(?5, github_login), rotated_at = ?6`,
  )
    .bind(
      userId,
      encryptJsonAtRest(tokens.access_token, key),
      tokens.refresh_token ? encryptJsonAtRest(tokens.refresh_token, key) : null,
      expiresAt,
      login,
      Date.now(),
    )
    .run();
}

/** Push refreshed credentials into the user's container, if there is one. */
export async function pushCredentialsToContainer(env: Bindings, userId: string): Promise<void> {
  await enqueueJobForUser(env, userId, "refresh-credentials");
}

export const githubRoutes = new Hono<AppContext>()
  .get("/auth/github", requireUser, async (c) => {
    if (!githubConfigured(c.env)) return c.text("GitHub App not configured", 404);
    const stateBytes = new Uint8Array(16);
    crypto.getRandomValues(stateBytes);
    const state = toHex(stateBytes);
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO oauth_states (state, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
      .bind(state, c.get("user").id, now, now + 10 * 60 * 1000)
      .run();
    const params = new URLSearchParams({
      client_id: c.env.GITHUB_APP_CLIENT_ID,
      redirect_uri: `${c.env.BASE_URL}/auth/github/callback`,
      state,
    });
    return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
  })
  .get("/auth/github/callback", requireUser, async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("Invalid GitHub callback", 400);
    const row = await c.env.DB.prepare(
      "SELECT user_id, expires_at FROM oauth_states WHERE state = ?",
    )
      .bind(state)
      .first<{ user_id: string; expires_at: number }>();
    await c.env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
    if (!row || row.expires_at < Date.now() || row.user_id !== c.get("user").id) {
      return c.text("Expired or invalid state", 400);
    }
    try {
      const tokens = await exchangeGithubTokens(c.env, { code });
      if (tokens.error) throw new Error(`github oauth error: ${tokens.error}`);
      await storeGithubTokens(c.env, row.user_id, tokens);
      await pushCredentialsToContainer(c.env, row.user_id);
    } catch (err) {
      // Log the credential *kind* only, never values (§10 secrets hygiene).
      console.log(JSON.stringify({ event: "github_connect_failed", error: String(err) }));
      return c.text("GitHub authorization failed. Please retry from the dashboard.", 502);
    }
    return c.redirect("/dashboard");
  });
