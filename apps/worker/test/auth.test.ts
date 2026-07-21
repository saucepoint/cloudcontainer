import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { authRoutes } from "../src/auth.js";
import type { AppContext } from "../src/types.js";
import { makeEnv, seedContainer, seedHost, seedUser } from "./helpers/env.js";

function app() {
  return new Hono<AppContext>().route("/", authRoutes);
}

describe("/auth/dev", () => {
  it("is available only when explicitly enabled", async () => {
    const { env } = makeEnv();
    expect((await app().request("/auth/dev?sub=x", {}, env)).status).toBe(404);

    const local = makeEnv({ DEV_AUTH: "1" }).env;
    expect((await app().request("/auth/dev?sub=x", {}, local)).status).toBe(302);
  });

  it("creates one stable account for each development subject", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });
    const first = await app().request("/auth/dev?sub=alice", {}, env);
    const again = await app().request("/auth/dev?sub=alice", {}, env);

    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/onboarding");
    expect(first.headers.get("set-cookie")).toContain("cs_session=");
    expect(again.status).toBe(302);
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(1);
  });

  it("concurrent requests converge on one account", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });
    const responses = await Promise.all([
      app().request("/auth/dev?sub=racing", {}, env),
      app().request("/auth/dev?sub=racing", {}, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([302, 302]);
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(1);
  });

  it("redirects an account with a container to the dashboard", async () => {
    const { env } = makeEnv({ DEV_AUTH: "1" });
    await seedHost(env);
    await app().request("/auth/dev?sub=bob", {}, env);
    const user = await env.DB.prepare("SELECT id FROM users").first<{ id: string }>();
    if (!user) throw new Error("development user was not created");
    await seedContainer(env, { user_id: user.id });

    const response = await app().request("/auth/dev?sub=bob", {}, env);
    expect(response.headers.get("location")).toBe("/dashboard");
  });
});

describe("logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const { env, kv } = makeEnv({ DEV_AUTH: "1" });
    await seedUser(env);
    const loginResponse = await app().request("/auth/dev?sub=carol", {}, env);
    const sid = /cs_session=([0-9a-f]+)/.exec(loginResponse.headers.get("set-cookie") ?? "")?.[1];
    expect(sid).toBeTruthy();
    expect(kv.store.has(`sess:${sid}`)).toBe(true);

    const response = await app().request("/auth/logout", {
      method: "POST",
      headers: { cookie: `cs_session=${sid}` },
    }, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(kv.store.has(`sess:${sid}`)).toBe(false);
    expect((await env.DB.prepare("SELECT * FROM session_revocations").all()).results).toHaveLength(1);
  });
});
