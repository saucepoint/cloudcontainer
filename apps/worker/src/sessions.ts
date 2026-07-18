import { toHex, utf8 } from "@codestation/contract";
import type { Bindings } from "./types.js";

const SESSION_TTL_SEC = 7 * 24 * 3600;
export const SESSION_COOKIE = "cs_session";

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(s));
  return toHex(new Uint8Array(digest));
}

export async function createSession(env: Bindings, userId: string): Promise<string> {
  const sid = randomToken();
  await env.SESSIONS.put(`sess:${sid}`, JSON.stringify({ userId, createdAt: Date.now() }), {
    expirationTtl: SESSION_TTL_SEC,
  });
  return sid;
}

export async function getSessionUserId(env: Bindings, sid: string): Promise<string | null> {
  const raw = await env.SESSIONS.get(`sess:${sid}`);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { userId: string }).userId;
  } catch {
    return null;
  }
}

/** KV delete + D1 revocation record (KV is eventually consistent; D1 is the truth for sensitive ops). */
export async function revokeSession(env: Bindings, sid: string): Promise<void> {
  await env.SESSIONS.delete(`sess:${sid}`);
  const hash = await sha256Hex(sid);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO session_revocations (sid_hash, revoked_at) VALUES (?, ?)",
  )
    .bind(hash, Date.now())
    .run();
}

/** Strongly-consistent revocation check for sensitive operations (account deletion etc.). */
export async function isSessionRevoked(env: Bindings, sid: string): Promise<boolean> {
  const hash = await sha256Hex(sid);
  const row = await env.DB.prepare("SELECT sid_hash FROM session_revocations WHERE sid_hash = ?")
    .bind(hash)
    .first();
  return row !== null;
}

export function sessionCookie(sid: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}
