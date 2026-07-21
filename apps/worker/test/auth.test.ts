/**
 * Auth flow tests via /auth/dev (the World ID bypass), which exercises the
 * same findOrCreateUser path as a verified session proof: signup uniqueness,
 * banned-nullifier enforcement (AC1), and login/logout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { hmacNullifier } from "@workbench/contract";
import { authRoutes } from "../src/auth.js";
import type { AppContext, UserRow } from "../src/types.js";
import { makeEnv, seedContainer, seedHost, seedUser } from "./helpers/env.js";

function app() {
  return new Hono<AppContext>().route("/", authRoutes);
}

afterEach(() => vi.unstubAllGlobals());

describe("/auth/dev gating", () => {
  it("is available only when DEV_AUTH=1, regardless of legacy secret values", async () => {
    const { env } = makeEnv(); // DEV_AUTH="0"
    Object.assign(env, { DEV_AUTH_TOKEN: "sekrit" });
    expect((await app().request("/auth/dev?sub=x", {}, env)).status).toBe(404);
    expect((await app().request("/auth/dev?sub=x&token=sekrit", {}, env)).status).toBe(404);

    const local = makeEnv({ DEV_AUTH: "1" }).env;
    expect((await app().request("/auth/dev?sub=x&token=ignored", {}, local)).status).toBe(302);
  });
});

describe("signup and login via session identity", () => {
  it("first login creates the account; later logins reuse it (one human, one account)", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });

    const first = await app().request("/auth/dev?sub=alice", {}, env);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/onboarding");
    expect(first.headers.get("set-cookie")).toContain("cs_session=");

    const again = await app().request("/auth/dev?sub=alice", {}, env);
    expect(again.status).toBe(302);

    const users = await env.DB.prepare("SELECT * FROM users").all<UserRow>();
    expect(users.results).toHaveLength(1);
    expect(users.results[0]?.signup_method).toBe("dev");
    const identity = await env.DB.prepare(
      "SELECT provider, provider_subject FROM auth_identities WHERE user_id = ?",
    )
      .bind(users.results[0]?.id)
      .first<{ provider: string; provider_subject: string }>();
    expect(identity).toEqual({ provider: "dev", provider_subject: "dev|alice" });
  });

  it("concurrent completions of the same proof converge on one account", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });

    const responses = await Promise.all([
      app().request("/auth/dev?sub=racing", {}, env),
      app().request("/auth/dev?sub=racing", {}, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([302, 302]);
    const users = await env.DB.prepare(
      `SELECT u.* FROM users u JOIN auth_identities i ON i.user_id = u.id
       WHERE i.provider = 'dev' AND i.provider_subject = 'dev|racing'`,
    ).all();
    expect(users.results).toHaveLength(1);
  });

  it("redirects returning users with a container straight to the dashboard", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });
    await seedHost(env);
    await app().request("/auth/dev?sub=bob", {}, env);
    const user = await env.DB.prepare(
      "SELECT user_id FROM auth_identities WHERE provider_subject = 'dev|bob'",
    ).first<{ user_id: string }>();
    if (!user) throw new Error("dev user was not created");
    await seedContainer(env, { user_id: user.user_id });

    const res = await app().request("/auth/dev?sub=bob", {}, env);
    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("refuses signup for a banned identity (HMAC survives account deletion, §13)", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });
    await env.DB.prepare(
      "INSERT INTO banned_nullifiers (nullifier_hmac, banned_at, reason) VALUES (?, ?, 'abuse')",
    )
      .bind(hmacNullifier("dev|mallory", env.NULLIFIER_HMAC_KEY), Date.now())
      .run();

    const res = await app().request("/auth/dev?sub=mallory", {}, env);
    expect(res.status).toBe(403);
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(0);
  });

  it("refuses login for an account banned after signup", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });
    await app().request("/auth/dev?sub=eve", {}, env);
    await env.DB.prepare("UPDATE users SET status = 'banned'").run();

    const res = await app().request("/auth/dev?sub=eve", {}, env);
    expect(res.status).toBe(403);
  });
});

describe("/auth/world-id", () => {
  it("returns a fresh v4 session context without an action", async () => {
    const { env } = makeEnv();
    const res = await app().request("/auth/world-id/context", { method: "POST" }, env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      app_id: "app_test",
      environment: "production",
      rp_context: {
        rp_id: "rp_test",
        nonce: expect.any(String),
        created_at: expect.any(Number),
        expires_at: expect.any(Number),
        signature: expect.stringMatching(/^0x[0-9a-f]+$/),
      },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("creates and reuses the identity confirmed by a v4 session proof", async () => {
    const { env } = makeEnv();
    const submittedSessionId = `session_${"b".repeat(128)}`;
    const idkitResponse = {
      protocol_version: "4.0",
      nonce: "proof-nonce",
      environment: "production",
      session_id: submittedSessionId,
      responses: [{
        identifier: "proof_of_human",
        issuer_schema_id: 1,
        proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
        expires_at_min: 1,
        session_nullifier: ["0xnullifier", "0xaction"],
      }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({
          success: true,
          session_id: submittedSessionId,
          environment: "production",
          results: [{ identifier: "proof_of_human", success: true }],
        }), {
          status: 200,
        }),
      )),
    );

    const res = await app().request(
      "/auth/world-id/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idkitResponse }),
      },
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as { redirect: string }).toEqual({
      redirect: "/security?welcome=1",
    });
    const identities = await env.DB.prepare(
      "SELECT provider_subject, protocol_version FROM auth_identities",
    ).all<{ provider_subject: string; protocol_version: string }>();
    expect(identities.results).toEqual([{
      provider_subject: submittedSessionId,
      protocol_version: "4.0",
    }]);
    const again = await app().request(
      "/auth/world-id/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idkitResponse }),
      },
      env,
    );
    expect(again.status).toBe(200);
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(1);
  });

  it("rejects a non-session or non-v4 response before calling the verifier", async () => {
    const { env } = makeEnv();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const res = await app().request(
      "/auth/world-id/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idkitResponse: {
          protocol_version: "3.0",
          environment: "production",
          nonce: "proof-nonce",
          responses: [],
        } }),
      },
      env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "World ID verification failed. Please try again.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(0);
  });
});

describe("/auth/world-id/failure", () => {
  it("logs only a sanitized World App failure code and opaque request ID", async () => {
    const { env } = makeEnv();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await app().request(
      "/auth/world-id/failure",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "generic_error",
          request_id: "01234567-89ab-cdef-0123-456789abcdef",
        }),
      },
      env,
    );

    expect(res.status).toBe(204);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "worldid_client_failed",
        code: "generic_error",
        requestId: "01234567-89ab-cdef-0123-456789abcdef",
      }),
    );
  });

  it("retains only safe native-bridge diagnostics, never request or proof payloads", async () => {
    const { env } = makeEnv();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await app().request(
      "/auth/world-id/failure",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "generic_error",
          request_id: "01234567-89ab-cdef-0123-456789abcdef",
          transport: "mini_app",
          mini_app: {
            verify_version: 2,
            platform: "android",
            send_channel: "Android.postMessage",
            minikit_subscribed: true,
            response_channel: "minikit",
            proof: "must-not-be-logged",
          },
          response_payload: "must-not-be-logged",
        }),
      },
      env,
    );

    expect(res.status).toBe(204);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "worldid_client_failed",
        code: "generic_error",
        requestId: "01234567-89ab-cdef-0123-456789abcdef",
        transport: "mini_app",
        miniApp: {
          verifyVersion: 2,
          platform: "android",
          sendChannel: "Android.postMessage",
          minikitSubscribed: true,
          responseChannel: "minikit",
        },
      }),
    );
  });
});

/*
  Keep the old route names absent: v3 compatibility and migration were removed
  with the clean World ID v4 integration.
*/
describe("removed World ID routes", () => {
  it("does not expose the previous session endpoints", async () => {
    const { env } = makeEnv();
    for (const path of [
      "/auth/session/rp-context",
      "/auth/session/verify",
      "/auth/session/failure",
      "/auth/session/migrate",
    ]) {
      expect((await app().request(path, { method: "POST" }, env)).status).toBe(404);
    }
  });
});

describe("logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const { env, kv } = makeEnv({ DEV_AUTH: "1" });
    await seedUser(env); // unrelated user; ensures no cross-talk
    const loginRes = await app().request("/auth/dev?sub=carol", {}, env);
    const sid = /cs_session=([0-9a-f]+)/.exec(loginRes.headers.get("set-cookie") ?? "")?.[1];
    expect(sid).toBeTruthy();
    expect(kv.store.has(`sess:${sid}`)).toBe(true);

    const res = await app().request("/auth/logout", {
      method: "POST",
      headers: { cookie: `cs_session=${sid}` },
    }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(kv.store.has(`sess:${sid}`)).toBe(false);
    const revoked = await env.DB.prepare("SELECT * FROM session_revocations").all();
    expect(revoked.results).toHaveLength(1);
  });
});
