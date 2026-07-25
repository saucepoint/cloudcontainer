import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { authRoutes, postLoginPath, requireUser } from "../src/auth.js";
import type { AppContext } from "../src/types.js";
import { createTestSession, makeEnv, seedContainer, seedHost, seedUser } from "./helpers/env.js";

function app() {
  return new Hono<AppContext>()
    .get("/protected", requireUser, (c) => c.json({ userId: c.get("user").id }))
    .route("/", authRoutes);
}

describe("Better Auth account sessions", () => {
  it("keeps the local development login explicitly gated", async () => {
    expect((await app().request("/auth/dev?sub=x", {}, makeEnv().env)).status).toBe(404);
    const { env } = makeEnv({ DEV_AUTH: "1" });
    const response = await app().request("/auth/dev?sub=x", {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/onboarding");
    expect(response.headers.get("set-cookie")).toContain("usebench.session_token=");
    expect((await env.DB.prepare("SELECT * FROM auth_sessions").all()).results).toHaveLength(1);
  });

  it("uses one stable development account per subject", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });
    await app().request("/auth/dev?sub=alice", {}, env);
    await app().request("/auth/dev?sub=alice", {}, env);
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(1);
  });

  it("routes unverified accounts to verification and configured accounts to the dashboard", async () => {
    const { env } = makeEnv();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
       VALUES ('unverified', 'User', 'u@example.test', 1, ?, ?)`,
    ).bind(now, now).run();
    expect(await postLoginPath(env, "unverified")).toBe("/verify");

    const user = await seedUser(env);
    expect(await postLoginPath(env, user.id)).toBe("/onboarding");
    await seedHost(env);
    await seedContainer(env, { user_id: user.id });
    expect(await postLoginPath(env, user.id)).toBe("/dashboard");
  });

  it("loads a database-backed session and rejects an unverified account", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const cookie = await createTestSession(env, user.id);
    expect((await app().request("/protected", { headers: { cookie } }, env)).status).toBe(200);
    await env.DB.prepare("UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?")
      .bind(user.id).run();
    const denied = await app().request("/protected", { headers: { cookie } }, env);
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toBe("/verify");
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
