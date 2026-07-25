import { hashSignal, signRequest } from "@worldcoin/idkit-core";
import { Hono } from "hono";
import { requireAccount, postLoginPath } from "./auth.js";
import { issuePasskeyRegistrationContext } from "./better-auth.js";
import { readJsonBody } from "./http.js";
import { hashInviteCode, normalizeInviteCode } from "./invites.js";
import { VerificationPage } from "./pages/views.js";
import type { AppContext } from "./types.js";

interface WorldIdVerifyResponse {
  success?: unknown;
  action?: unknown;
  results?: Array<{
    success?: unknown;
    nullifier?: unknown;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function worldIdConfigured(env: AppContext["Bindings"]): boolean {
  return Boolean(
    env.WORLD_ID_APP_ID
    && env.WORLD_ID_RP_ID
    && env.WORLD_ID_ACTION
    && env.WORLD_ID_SIGNING_KEY,
  );
}

function worldIdSignalMatches(proof: Record<string, unknown>, userId: string): boolean {
  if (!Array.isArray(proof.responses) || proof.responses.length === 0) return false;
  const expected = hashSignal(userId).toLowerCase();
  return proof.responses.every((response) =>
    isRecord(response)
    && typeof response.signal_hash === "string"
    && response.signal_hash.toLowerCase() === expected,
  );
}

function nullifierDecimal(value: string): string | null {
  if (!/^0x[0-9a-f]{1,64}$/i.test(value)) return null;
  try {
    return BigInt(value).toString(10);
  } catch {
    return null;
  }
}

export const accountRoutes = new Hono<AppContext>()
  .get("/account/passkey/context", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ context: await issuePasskeyRegistrationContext(c.env) });
  })
  .get("/account/continue", requireAccount, async (c) =>
    c.redirect(await postLoginPath(c.env, c.get("user").id)))
  .get("/verify", requireAccount, async (c) => {
    if (c.get("user").verified_at) {
      return c.redirect(await postLoginPath(c.env, c.get("user").id));
    }
    return c.html(String(VerificationPage({ worldIdAvailable: worldIdConfigured(c.env) })));
  })
  .post("/api/account/invite/verify", requireAccount, async (c) => {
    const user = c.get("user");
    if (user.verified_at) return c.json({ redirect: await postLoginPath(c.env, user.id) });
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
        return c.json({ redirect: await postLoginPath(c.env, user.id) });
      }
    } catch {
      return c.json({ error: "That invite code is invalid or has already been used." }, 409);
    }
    return c.json({ redirect: "/onboarding" });
  })
  .post("/api/account/world-id/request", requireAccount, async (c) => {
    if (!worldIdConfigured(c.env)) return c.json({ error: "World ID verification is unavailable." }, 503);
    const signed = signRequest({
      signingKeyHex: c.env.WORLD_ID_SIGNING_KEY!,
      action: c.env.WORLD_ID_ACTION!,
    });
    c.header("cache-control", "no-store");
    return c.json({
      appId: c.env.WORLD_ID_APP_ID,
      action: c.env.WORLD_ID_ACTION,
      environment: c.env.WORLD_ID_ENVIRONMENT === "staging" ? "staging" : "production",
      signal: c.get("user").id,
      rpContext: {
        rp_id: c.env.WORLD_ID_RP_ID,
        nonce: signed.nonce,
        created_at: signed.createdAt,
        expires_at: signed.expiresAt,
        signature: signed.sig,
      },
    });
  })
  .post("/api/account/world-id/verify", requireAccount, async (c) => {
    if (!worldIdConfigured(c.env)) return c.json({ error: "World ID verification is unavailable." }, 503);
    const user = c.get("user");
    if (user.verified_at) return c.json({ redirect: await postLoginPath(c.env, user.id) });
    const body = await readJsonBody<{ proof?: unknown }>(c);
    if (!body || !isRecord(body.proof)) return c.json({ error: "World ID proof is missing." }, 400);
    if (body.proof.action !== c.env.WORLD_ID_ACTION || !worldIdSignalMatches(body.proof, user.id)) {
      return c.json({ error: "World ID proof does not match this account." }, 400);
    }

    let response: Response;
    try {
      response = await fetch(
        `https://developer.world.org/api/v4/verify/${encodeURIComponent(c.env.WORLD_ID_RP_ID!)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body.proof),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      return c.json({ error: "World ID verification could not be reached. Try again." }, 502);
    }
    const verified = await response.json().catch(() => null) as WorldIdVerifyResponse | null;
    if (
      !response.ok
      || verified?.success !== true
      || (typeof verified.action === "string" && verified.action !== c.env.WORLD_ID_ACTION)
    ) {
      return c.json({ error: "World ID could not verify this proof." }, 400);
    }
    const nullifier = verified.results
      ?.filter((result) => result.success === true && typeof result.nullifier === "string")
      .map((result) => nullifierDecimal(result.nullifier as string))
      .find((value): value is string => value !== null);
    if (!nullifier) return c.json({ error: "World ID returned no uniqueness proof." }, 400);

    const now = Date.now();
    try {
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO world_id_nullifiers
             (action, nullifier_decimal, user_id, verified_at)
           SELECT ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM users WHERE id = ? AND verified_at IS NULL
           )`,
        ).bind(c.env.WORLD_ID_ACTION, nullifier, user.id, now, user.id),
        c.env.DB.prepare(
          `UPDATE users SET verified_at = ?, verification_method = 'world_id', updated_at = ?
           WHERE id = ? AND verified_at IS NULL`,
        ).bind(now, now, user.id),
      ]) as Array<{ meta: { changes?: number } }>;
      if (!results[0]?.meta.changes) {
        return c.json({ redirect: await postLoginPath(c.env, user.id) });
      }
    } catch {
      return c.json({ error: "This World ID has already verified an account." }, 409);
    }
    return c.json({ redirect: "/onboarding" });
  });
