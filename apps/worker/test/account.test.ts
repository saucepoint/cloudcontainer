import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { accountRoutes } from "../src/account.js";
import { adminRoutes } from "../src/admin.js";
import { hashInviteCode } from "../src/invites.js";
import type { AppContext, Bindings } from "../src/types.js";
import { createTestSession, makeEnv, seedUser, stubFetch } from "./helpers/env.js";

function app() {
  return new Hono<AppContext>().route("/", accountRoutes).route("/", adminRoutes);
}

function json(value: unknown, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(value),
  };
}

async function issueInvite(env: Bindings): Promise<string> {
  const response = await app().request("/api/admin/invites", {
    method: "POST",
    headers: { authorization: "Bearer admin-secret" },
  }, env);
  expect(response.status).toBe(201);
  return ((await response.json()) as { code: string }).code;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account verification", () => {
  it("issues only signed, short-lived passkey registration contexts", async () => {
    const { env } = makeEnv();
    const response = await app().request("/account/passkey/context", {}, env);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { context: string }).context).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("returns the canonical IDKit request shape from the configured signing key", async () => {
    const { env } = makeEnv({
      WORLD_ID_APP_ID: "app_test",
      WORLD_ID_RP_ID: "rp_test",
      WORLD_ID_ACTION: "verify-account",
      WORLD_ID_SIGNING_KEY: `0x${"11".repeat(32)}`,
    });
    const user = await seedUser(env);
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
      .bind(user.id).run();

    const response = await app().request(
      "/api/account/world-id/request",
      { method: "POST", headers: { cookie: await createTestSession(env, user.id) } },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      app_id: "app_test",
      action: "verify-account",
      environment: "production",
      allow_legacy_proofs: true,
      signal: user.id,
      rp_context: {
        rp_id: "rp_test",
        nonce: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redeems an invite for the authenticated account without making the invite a login credential", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const user = await seedUser(env);
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
      .bind(user.id).run();
    const cookie = await createTestSession(env, user.id);
    const code = await issueInvite(env);
    const response = await app().request(
      "/api/account/invite/verify",
      json({ code }, cookie),
      env,
    );
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT verification_method FROM users WHERE id = ?")
      .bind(user.id).first()).toEqual({ verification_method: "invite" });
    expect(await env.DB.prepare("SELECT code_hash, user_id FROM invite_redemptions").first())
      .toEqual({ code_hash: await hashInviteCode(code, "admin-secret"), user_id: user.id });
  });

  it("enforces one-time invite redemption", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const code = await issueInvite(env);
    const first = await seedUser(env, "first");
    const second = await seedUser(env, "second");
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL").run();
    expect((await app().request("/api/account/invite/verify", json({ code }, await createTestSession(env, first.id)), env)).status).toBe(200);
    expect((await app().request("/api/account/invite/verify", json({ code }, await createTestSession(env, second.id)), env)).status).toBe(409);
  });

  it("binds World ID proofs to the signed-in user and stores the verified nullifier once", async () => {
    const { env } = makeEnv({
      WORLD_ID_APP_ID: "app_test",
      WORLD_ID_RP_ID: "rp_test",
      WORLD_ID_ACTION: "verify-account",
      WORLD_ID_SIGNING_KEY: `0x${"11".repeat(32)}`,
    });
    const user = await seedUser(env);
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
      .bind(user.id).run();
    const cookie = await createTestSession(env, user.id);
    const { hashSignal } = await import("@worldcoin/idkit-core");
    const proof = {
      protocol_version: "4.0",
      nonce: crypto.randomUUID(),
      action: "verify-account",
      responses: [{ signal_hash: hashSignal(user.id) }],
    };
    const rawProof = JSON.stringify(proof);
    const forwardedProofs: string[] = [];
    const verifierUserAgents: Array<string | null> = [];
    const fetchMock = stubFetch((url, init) => {
      if (url.pathname !== "/api/v4/verify/rp_test") return null;
      forwardedProofs.push(String(init.body));
      verifierUserAgents.push(new Headers(init.headers).get("user-agent"));
      return Response.json({
        success: true,
        results: [{ success: true, nullifier: "0x01" }],
      });
    });
    const response = await app().request(
      "/api/account/world-id/verify",
      json(proof, cookie),
      env,
    );
    expect(response.status).toBe(200);
    expect(forwardedProofs[0]).toBe(rawProof);
    expect(verifierUserAgents).toEqual(["usebench.dev/1.0"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT nullifier_decimal, user_id FROM world_id_nullifiers").first())
      .toEqual({ nullifier_decimal: "1", user_id: user.id });

    const second = await seedUser(env, "second");
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
      .bind(second.id).run();
    const reused = await app().request(
      "/api/account/world-id/verify",
      json({
        ...proof,
        responses: [{ signal_hash: hashSignal(second.id) }],
      }, await createTestSession(env, second.id)),
      env,
    );
    expect(reused.status).toBe(409);
    expect(await env.DB.prepare("SELECT verified_at FROM users WHERE id = ?")
      .bind(second.id).first()).toEqual({ verified_at: null });
  });

  it("rejects a World ID proof bound to another account before contacting World ID", async () => {
    const { env } = makeEnv({
      WORLD_ID_APP_ID: "app_test",
      WORLD_ID_RP_ID: "rp_test",
      WORLD_ID_ACTION: "verify-account",
      WORLD_ID_SIGNING_KEY: `0x${"11".repeat(32)}`,
    });
    const user = await seedUser(env);
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
      .bind(user.id).run();
    const fetchMock = stubFetch();
    const response = await app().request(
      "/api/account/world-id/verify",
      json({
        protocol_version: "4.0",
        action: "verify-account",
        environment: "production",
        responses: [{ signal_hash: "0x0" }],
      }, await createTestSession(env, user.id)),
      env,
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a status-specific code when the verifier rejects without one", async () => {
    const { env } = makeEnv({
      WORLD_ID_APP_ID: "app_test",
      WORLD_ID_RP_ID: "rp_test",
      WORLD_ID_ACTION: "verify-account",
      WORLD_ID_SIGNING_KEY: `0x${"11".repeat(32)}`,
    });
    const user = await seedUser(env);
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
      .bind(user.id).run();
    const { hashSignal } = await import("@worldcoin/idkit-core");
    stubFetch((url) => url.pathname === "/api/v4/verify/rp_test"
      ? Response.json({ success: false, detail: "rejected" }, { status: 400 })
      : null);

    const response = await app().request(
      "/api/account/world-id/verify",
      json({
        protocol_version: "4.0",
        nonce: crypto.randomUUID(),
        action: "verify-account",
        environment: "production",
        responses: [{ signal_hash: hashSignal(user.id) }],
      }, await createTestSession(env, user.id)),
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "World ID could not verify this proof.",
      code: "verifier_http_400",
    });
  });

  it("does not expose a client-failure telemetry route", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const response = await app().request(
      "/api/account/world-id/failure",
      json({ code: "invalid_rp_signature" }, await createTestSession(env, user.id)),
      env,
    );

    expect(response.status).toBe(404);
  });
});
