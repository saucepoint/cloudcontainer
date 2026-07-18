/**
 * Auth flow tests via /auth/dev (the World ID bypass), which exercises the
 * same findOrCreateUser path as a verified session proof: signup uniqueness,
 * banned-nullifier enforcement (AC1), and login/logout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { hmacNullifier } from "@codestation/contract";
import { authRoutes } from "../src/auth.js";
import type { AppContext, UserRow } from "../src/types.js";
import { makeEnv, seedContainer, seedHost, seedUser } from "./helpers/env.js";

function app() {
  return new Hono<AppContext>().route("/", authRoutes);
}

afterEach(() => vi.unstubAllGlobals());

describe("/auth/dev gating", () => {
  it("is a 404 unless DEV_AUTH=1 or a matching DEV_AUTH_TOKEN is presented", async () => {
    const { env } = makeEnv(); // DEV_AUTH="0", no token secret
    expect((await app().request("/auth/dev?sub=x", {}, env)).status).toBe(404);

    const tokened = makeEnv({ DEV_AUTH_TOKEN: "sekrit" }).env;
    expect((await app().request("/auth/dev?sub=x", {}, tokened)).status).toBe(404);
    expect((await app().request("/auth/dev?sub=x&token=wrong", {}, tokened)).status).toBe(404);
    expect((await app().request("/auth/dev?sub=x&token=sekrit", {}, tokened)).status).toBe(302);
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

describe("/auth/session/verify", () => {
  it("creates an account from a verified Orb v3 nullifier", async () => {
    const { env } = makeEnv();
    const nullifier = `0x${"a".repeat(64)}`;
    const idkitResponse = {
      protocol_version: "3.0",
      nonce: "proof-nonce",
      action: "codestation-login",
      environment: "production",
      responses: [{
        identifier: "orb",
        proof: "0xproof",
        merkle_root: `0x${"b".repeat(64)}`,
        nullifier,
      }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        action: "codestation-login",
        nullifier,
      }), { status: 200 }),
    ));

    const res = await app().request(
      "/auth/session/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idkitResponse }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const identities = await env.DB.prepare(
      "SELECT provider_subject, protocol_version FROM auth_identities",
    ).all<{ provider_subject: string; protocol_version: string }>();
    expect(identities.results).toEqual([{
      provider_subject: `worldid-nullifier:${BigInt(nullifier).toString(10)}`,
      protocol_version: "3.0",
    }]);
  });

  it("creates the session for the identity confirmed by the verifier", async () => {
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
        proof: ["proof"],
        expires_at_min: 1,
        session_nullifier: ["nullifier", "action"],
      }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, session_id: submittedSessionId }), {
          status: 200,
        }),
      ),
    );

    const res = await app().request(
      "/auth/session/verify",
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
  });
});

describe("/auth/session/failure", () => {
  it("logs only a sanitized World App failure code and opaque request ID", async () => {
    const { env } = makeEnv();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await app().request(
      "/auth/session/failure",
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
