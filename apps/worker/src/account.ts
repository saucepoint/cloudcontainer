import { Hono } from "hono";
import { requireAccount, postLoginPath } from "./auth.js";
import { issuePasskeyRegistrationContext } from "./better-auth.js";
import { readJsonBody } from "./http.js";
import { hashInviteCode, normalizeInviteCode } from "./invites.js";
import { VerificationPage } from "./pages/views.js";
import type { AppContext } from "./types.js";
import {
  createWorldIdRequest,
  verifyWorldIdProof,
  worldIdConfigured,
  WorldIdVerificationError,
} from "./world-id.js";

export const accountRoutes = new Hono<AppContext>()
  .get("/account/passkey/context", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ context: await issuePasskeyRegistrationContext(c.env) });
  })
  .get("/account/continue", requireAccount, async (c) =>
    c.redirect(postLoginPath()))
  .get("/verify", requireAccount, async (c) => {
    if (c.get("user").verified_at) return c.redirect("/dashboard");
    return c.html(String(VerificationPage({
      worldIdAvailable: worldIdConfigured(c.env),
    })));
  })
  .post("/api/account/invite/verify", requireAccount, async (c) => {
    const user = c.get("user");
    if (user.verified_at) return c.json({ redirect: postLoginPath() });
    const body = await readJsonBody<{ code?: unknown }>(c);
    const code = typeof body?.code === "string" ? normalizeInviteCode(body.code) : null;
    if (!code) return c.json({ error: "Enter your eight-character invite code." }, 400);
    if (!c.env.INVITE_ADMIN_SECRET) return c.json({ error: "Invite verification is unavailable." }, 503);
    const codeHash = await hashInviteCode(code, c.env.INVITE_ADMIN_SECRET);
    const exists = await c.env.DB.prepare("SELECT code_hash FROM invite_codes WHERE code_hash = ?")
      .bind(codeHash)
      .first();
    if (!exists) return c.json({ error: "That invite code is invalid or has already been used." }, 403);
    const now = Date.now();
    try {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO invite_redemptions (code_hash, user_id, redeemed_at)
           SELECT ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM users WHERE id = ? AND verified_at IS NULL
           )`,
        ).bind(codeHash, user.id, now, user.id),
        c.env.DB.prepare(
          `UPDATE users SET verified_at = ?, verification_method = 'invite', updated_at = ?
           WHERE id = ? AND verified_at IS NULL`,
        ).bind(now, now, user.id),
      ]) as Array<{ meta: { changes?: number } }>;
      if (!results[0]?.meta.changes) {
        return c.json({ redirect: postLoginPath() });
      }
    } catch {
      return c.json({ error: "That invite code is invalid or has already been used." }, 409);
    }
    return c.json({ redirect: "/dashboard" });
  })
  .post("/api/account/world-id/request", requireAccount, async (c) => {
    const request = createWorldIdRequest(c.env, c.get("user").id);
    if (!request) return c.json({ error: "World ID verification is unavailable." }, 503);
    c.header("cache-control", "no-store");
    return c.json(request);
  })
  .post("/api/account/world-id/verify", requireAccount, async (c) => {
    const user = c.get("user");
    if (user.verified_at) return c.json({ redirect: postLoginPath() });
    const rawProof = await c.req.text();
    let nullifier: string;
    try {
      nullifier = await verifyWorldIdProof(c.env, user.id, rawProof);
    } catch (error) {
      if (error instanceof WorldIdVerificationError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      throw error;
    }

    const now = Date.now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO world_id_nullifiers
           (action, nullifier_decimal, user_id, verified_at)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM users WHERE id = ? AND verified_at IS NULL
         )
         ON CONFLICT(action, nullifier_decimal) DO NOTHING`,
      ).bind(c.env.WORLD_ID_ACTION, nullifier, user.id, now, user.id),
      c.env.DB.prepare(
        `UPDATE users SET verified_at = ?, verification_method = 'world_id', updated_at = ?
         WHERE id = ? AND verified_at IS NULL
           AND EXISTS (
             SELECT 1 FROM world_id_nullifiers
             WHERE action = ? AND nullifier_decimal = ? AND user_id = ?
           )`,
      ).bind(now, now, user.id, c.env.WORLD_ID_ACTION, nullifier, user.id),
    ]) as Array<{ meta: { changes?: number } }>;
    if (results[1]?.meta.changes) return c.json({ redirect: "/dashboard" });

    const refreshed = await c.env.DB.prepare("SELECT verified_at FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ verified_at: number | null }>();
    if (refreshed?.verified_at) return c.json({ redirect: "/dashboard" });
    return c.json({ error: "This World ID has already verified an account." }, 409);
  });
