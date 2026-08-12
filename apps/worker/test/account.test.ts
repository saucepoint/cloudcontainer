import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { accountRoutes } from "../src/account.js";
import { adminRoutes } from "../src/admin.js";
import { hashInviteCode } from "../src/invites.js";
import { putWorkbenchConfiguration } from "../src/workbench-configuration.js";
import type { AppContext, Bindings } from "../src/types.js";
import { createTestSession, makeEnv, seedUser, stubFetch } from "./helpers/env.js";

const WORLD_ID_CONFIG = {
  WORLD_ID_APP_ID: "app_test",
  WORLD_ID_RP_ID: "rp_test",
  WORLD_ID_ACTION: "verify-account-1",
  WORLD_ID_SIGNING_KEY: `0x${"11".repeat(32)}`,
} satisfies Partial<Bindings>;

const STAGING_WORLD_ID_CONFIG = {
  ...WORLD_ID_CONFIG,
  WORLD_ID_ACTION: "verify-account-staging",
  WORLD_ID_ENVIRONMENT: "production",
} satisfies Partial<Bindings>;

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

async function unverifiedAccount(env: Bindings, id = "user-1") {
  const user = await seedUser(env, id);
  await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
    .bind(user.id).run();
  return { user, cookie: await createTestSession(env, user.id) };
}

function worldIdProof(userId: string) {
  return {
    protocol_version: "4.0",
    nonce: crypto.randomUUID(),
    action: "verify-account-1",
    environment: "production",
    responses: [{ signal_hash: hashSignal(userId) }],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account verification", () => {
  it("continues new sessions to configuration and configured sessions to the dashboard", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const cookie = await createTestSession(env, user.id);

    const setup = await app().request("/account/continue", { headers: { cookie } }, env);
    expect(setup.status).toBe(302);
    expect(setup.headers.get("location")).toBe("/configure");

    await putWorkbenchConfiguration(env, user.id, { agents: ["claude"], githubRepos: [] });
    const dashboard = await app().request("/account/continue", { headers: { cookie } }, env);
    expect(dashboard.status).toBe(302);
    expect(dashboard.headers.get("location")).toBe("/dashboard");
  });

  it("issues only signed, short-lived passkey registration contexts", async () => {
    const { env } = makeEnv();
    const response = await app().request("/account/passkey/context", {}, env);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { context: string }).context).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("returns the canonical IDKit request shape from the configured signing key", async () => {
    const { env } = makeEnv(WORLD_ID_CONFIG);
    const { user, cookie } = await unverifiedAccount(env);

    const response = await app().request(
      "/api/account/world-id/request",
      { method: "POST", headers: { cookie } },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      app_id: "app_test",
      action: "verify-account-1",
      environment: "production",
      allow_legacy_proofs: false,
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
    const { user, cookie } = await unverifiedAccount(env);
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
    const first = await unverifiedAccount(env, "first");
    const second = await unverifiedAccount(env, "second");

    expect((await app().request("/api/account/invite/verify", json({ code }, first.cookie), env)).status)
      .toBe(200);
    expect((await app().request("/api/account/invite/verify", json({ code }, second.cookie), env)).status)
      .toBe(409);
  });

  it("binds World ID proofs to the signed-in user and stores the verified nullifier once", async () => {
    const { env } = makeEnv(WORLD_ID_CONFIG);
    const { user, cookie } = await unverifiedAccount(env);
    const proof = worldIdProof(user.id);
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

    const second = await unverifiedAccount(env, "second");
    const reused = await app().request(
      "/api/account/world-id/verify",
      json(worldIdProof(second.user.id), second.cookie),
      env,
    );
    expect(reused.status).toBe(409);
    expect(await env.DB.prepare("SELECT verified_at FROM users WHERE id = ?")
      .bind(second.user.id).first()).toEqual({ verified_at: null });
  });

  it("rejects legacy World ID proofs before contacting the verifier", async () => {
    const { env } = makeEnv(WORLD_ID_CONFIG);
    const { user, cookie } = await unverifiedAccount(env);
    const fetchMock = stubFetch();
    const response = await app().request(
      "/api/account/world-id/verify",
      json({ ...worldIdProof(user.id), protocol_version: "3.0" }, cookie),
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_version" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a World ID proof bound to another account before contacting World ID", async () => {
    const { env } = makeEnv(WORLD_ID_CONFIG);
    const { cookie } = await unverifiedAccount(env);
    const fetchMock = stubFetch();
    const response = await app().request(
      "/api/account/world-id/verify",
      json({
        ...worldIdProof("another-user"),
        responses: [{ signal_hash: "0x0" }],
      }, cookie),
      env,
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a status-specific code when the verifier rejects without one", async () => {
    const { env } = makeEnv(WORLD_ID_CONFIG);
    const { user, cookie } = await unverifiedAccount(env);
    stubFetch((url) => url.pathname === "/api/v4/verify/rp_test"
      ? Response.json({ success: false, detail: "rejected" }, { status: 400 })
      : null);

    const response = await app().request(
      "/api/account/world-id/verify",
      json(worldIdProof(user.id), cookie),
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "World ID could not verify this proof.",
      code: "verifier_http_400",
    });
  });

  it("supports the staging action while reusing the production World ID environment", async () => {
    const { env } = makeEnv(STAGING_WORLD_ID_CONFIG);
    const { user, cookie } = await unverifiedAccount(env);

    const response = await app().request(
      "/api/account/world-id/request",
      { method: "POST", headers: { cookie } },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      app_id: "app_test",
      action: "verify-account-staging",
      environment: "production",
      signal: user.id,
    });
  });

  it("maps a World ID verifier outage to a gateway error", async () => {
    const { env } = makeEnv(WORLD_ID_CONFIG);
    const { user, cookie } = await unverifiedAccount(env);
    stubFetch((url) => url.pathname === "/api/v4/verify/rp_test"
      ? Response.json({ success: false }, { status: 503 })
      : null);

    const response = await app().request(
      "/api/account/world-id/verify",
      json(worldIdProof(user.id), cookie),
      env,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "verifier_http_503" });
  });

  it("does not disguise database failures as reused World ID nullifiers", async () => {
    const { env } = makeEnv(WORLD_ID_CONFIG);
    const { user, cookie } = await unverifiedAccount(env);
    await env.DB.prepare(
      `CREATE TRIGGER reject_world_id_storage
       BEFORE INSERT ON world_id_nullifiers
       BEGIN SELECT RAISE(ABORT, 'world id storage unavailable'); END`,
    ).run();
    stubFetch((url) => url.pathname === "/api/v4/verify/rp_test"
      ? Response.json({
          success: true,
          results: [{ success: true, nullifier: "0x01" }],
        })
      : null);

    const response = await app().request(
      "/api/account/world-id/verify",
      json(worldIdProof(user.id), cookie),
      env,
    );

    expect(response.status).toBe(500);
    expect(await env.DB.prepare("SELECT verified_at FROM users WHERE id = ?")
      .bind(user.id).first()).toEqual({ verified_at: null });
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
