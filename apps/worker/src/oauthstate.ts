/**
 * One-time sign-in attempt state shared by every control-plane OAuth flow
 * (ChatGPT device code, Claude PKCE, GitHub Copilot device code, Cloudflare
 * wrangler PKCE). Rows live in the oauth_states table keyed "<flow>:<id>" and
 * are bound to the user who started the attempt, so nobody else can complete
 * it into their own account.
 */
import type { Bindings } from "./types.js";

export async function putOauthState(
  env: Bindings,
  key: string,
  userId: string,
  ttlMs: number,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO oauth_states (state, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(key, userId, now, now + ttlMs)
    .run();
}

/** True when the attempt exists, has not expired, and belongs to `userId`. */
export async function checkOauthState(
  env: Bindings,
  key: string,
  userId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT user_id, expires_at FROM oauth_states WHERE state = ?",
  )
    .bind(key)
    .first<{ user_id: string; expires_at: number }>();
  return Boolean(row && row.user_id === userId && row.expires_at >= Date.now());
}

export async function deleteOauthState(env: Bindings, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(key).run();
}
