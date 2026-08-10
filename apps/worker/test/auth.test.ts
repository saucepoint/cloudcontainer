import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { authRoutes, postLoginPath, requireAccount } from "../src/auth.js";
import { createAuth } from "../src/better-auth.js";
import type { AppContext } from "../src/types.js";
import { createTestSession, makeEnv, seedUser } from "./helpers/env.js";

function app() {
  return new Hono<AppContext>()
    .get("/protected", requireAccount, (c) => c.json({ userId: c.get("user").id }))
    .route("/", authRoutes);
}

describe("Better Auth account sessions", () => {
  it("keeps the local development login explicitly gated", async () => {
    expect((await app().request("/auth/dev?sub=x", {}, makeEnv().env)).status).toBe(404);
    const { env } = makeEnv({ DEV_AUTH: "1" });
    const response = await app().request("/auth/dev?sub=x", {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(response.headers.get("set-cookie")).toContain("usebench.session_token=");
    expect((await env.DB.prepare("SELECT * FROM auth_sessions").all()).results).toHaveLength(1);
  });

  it("uses one stable development account per subject", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });
    await app().request("/auth/dev?sub=alice", {}, env);
    await app().request("/auth/dev?sub=alice", {}, env);
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(1);
  });

  it("configures only Google and GitHub as trusted social providers", async () => {
    const { env } = makeEnv({
      AUTH_GOOGLE_CLIENT_ID: "google-client",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
      AUTH_GITHUB_CLIENT_ID: "github-client",
      AUTH_GITHUB_CLIENT_SECRET: "github-secret",
    });
    const context = await createAuth(env).$context;

    expect(context.socialProviders.map((provider) => provider.id)).toEqual(["google", "github"]);
    expect(context.trustedProviders).toEqual(["google", "github"]);
  });

  it.each([
    ["google", "Google User", "google-user-1", "google-user@example.test"],
    ["github", "GitHub User", "github-user-1", "github-user@example.test"],
  ])("creates a %s user and provider account", async (providerId, name, accountId, email) => {
    const { env } = makeEnv();
    const context = await createAuth(env).$context;
    const result = await context.internalAdapter.createOAuthUser(
      { name, email, emailVerified: true },
      { providerId, accountId, accessToken: "access-token" },
    );

    expect(result.user.email).toBe(email);
    expect(result.account.providerId).toBe(providerId);
    const user = await env.DB.prepare(
      "SELECT status, subscription_status FROM users WHERE id = ?",
    ).bind(result.user.id).first<{ status: string; subscription_status: string }>();
    expect(user).toEqual({ status: "active", subscription_status: "free" });
  });

  it("always routes authenticated accounts to the dashboard", () => {
    expect(postLoginPath()).toBe("/dashboard");
  });

  it("loads a database-backed session for an unverified account", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const cookie = await createTestSession(env, user.id);
    expect((await app().request("/protected", { headers: { cookie } }, env)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
      .bind(user.id).run();
    const allowed = await app().request("/protected", { headers: { cookie } }, env);
    expect(allowed.status).toBe(200);
  });

  it("keeps the QA bypass secret-gated and staging-only", async () => {
    const secret = "test-staging-bypass-secret";
    const disabled = makeEnv({ STAGING_AUTH_BYPASS_SECRET: secret });
    expect((await app().request("/auth/staging-bypass", {}, disabled.env)).status).toBe(404);

    const { env } = makeEnv({
      BASE_URL: "https://staging.usebench.dev",
      STAGING_AUTH_BYPASS_SECRET: secret,
    });
    const denied = await app().request("/auth/staging-bypass", {
      method: "POST",
      body: new URLSearchParams({ secret: "wrong", subject: "qa", state: "premium" }),
    }, env);
    expect(denied.status).toBe(401);
    const response = await app().request("/auth/staging-bypass", {
      method: "POST",
      body: new URLSearchParams({ secret, subject: "qa", state: "verified_premium" }),
    }, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
    expect(response.headers.get("set-cookie")).toContain("usebench.session_token=");
    expect(await env.DB.prepare(
      "SELECT verified_at, subscription_status FROM users WHERE name = 'Staging QA account'",
    ).first()).toMatchObject({ subscription_status: "paid" });

    const downgraded = await app().request("/auth/staging-bypass", {
      method: "POST",
      body: new URLSearchParams({ secret, subject: "qa", state: "unverified" }),
    }, env);
    expect(downgraded.status).toBe(302);
    expect(await env.DB.prepare(
      "SELECT verified_at, subscription_status FROM users WHERE name = 'Staging QA account'",
    ).first()).toEqual({ verified_at: null, subscription_status: "free" });
    expect((await env.DB.prepare("SELECT * FROM account_entitlements").all()).results).toHaveLength(0);
  });

  it("signs out by deleting the Better Auth session and expiring its cookie", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const cookie = await createTestSession(env, user.id);
    const response = await app().request("/auth/logout", {
      method: "POST",
      headers: { cookie },
    }, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await env.DB.prepare("SELECT * FROM auth_sessions").all()).results).toHaveLength(0);
  });
});
