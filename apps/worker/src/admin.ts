import { Hono } from "hono";
import type { AppContext, Bindings } from "./types.js";
import { utf8 } from "@workbench/contract";
import { hashInviteCode, randomInviteCode } from "./invites.js";

async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", utf8(provided)),
    crypto.subtle.digest("SHA-256", utf8(expected)),
  ]);
  const { timingSafeEqual } = crypto.subtle;
  if (typeof timingSafeEqual === "function") {
    return timingSafeEqual.call(crypto.subtle, providedHash, expectedHash);
  }

  // Node's WebCrypto test runtime does not expose Cloudflare's timingSafeEqual.
  // Both inputs are fixed-length hashes and the fallback never exits early.
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

async function createInvite(env: Bindings, secret: string): Promise<string> {
  // A collision is fantastically unlikely, but the unique hash remains the
  // source of truth and generation retries instead of returning a dead code.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomInviteCode();
    try {
      await env.DB.prepare(
        "INSERT INTO invite_codes (code_hash, created_at) VALUES (?, ?)",
      )
        .bind(await hashInviteCode(code, secret), Date.now())
        .run();
      return code;
    } catch {
      // Retry only with a fresh code; never reveal whether a hash collided.
    }
  }
  throw new Error("could not allocate a unique invite code");
}

export const adminRoutes = new Hono<AppContext>().post("/api/admin/invites", async (c) => {
  if (!c.env.INVITE_ADMIN_SECRET) return c.notFound();
  const provided = bearerToken(c.req.header("authorization"));
  if (!(await secretMatches(provided, c.env.INVITE_ADMIN_SECRET))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const code = await createInvite(c.env, c.env.INVITE_ADMIN_SECRET);
  c.header("cache-control", "no-store");
  return c.json({ code }, 201);
});
