import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptJsonAtRest } from "@codestation/contract";
import { githubRoutes } from "../src/github.js";
import { createSession } from "../src/sessions.js";
import type { AppContext, Bindings, UserRow } from "../src/types.js";
import { makeEnv, seedUser, stubFetch } from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

function app() {
  return new Hono<AppContext>().route("/", githubRoutes);
}

async function login(env: Bindings, user: UserRow): Promise<Record<string, string>> {
  const sid = await createSession(env, user.id);
  return { cookie: `cs_session=${sid}` };
}

describe("GitHub OAuth", () => {
  it("round-trips safely back to onboarding and stores only encrypted tokens", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });
    const user = await seedUser(env);
    const headers = await login(env, user);

    const start = await app().request(
      "/auth/github?return_to=/onboarding",
      { headers },
      env,
    );
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin).toBe("https://github.com");
    expect(authorize.searchParams.get("client_id")).toBe("client-id");
    const state = authorize.searchParams.get("state")!;
    const stateRow = await env.DB.prepare("SELECT return_to FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ return_to: string }>();
    expect(stateRow?.return_to).toBe("/onboarding");

    stubFetch(
      (url) =>
        url.hostname === "github.com" && url.pathname === "/login/oauth/access_token"
          ? Response.json({
              access_token: "CANARY-gh-access",
              refresh_token: "CANARY-gh-refresh",
              expires_in: 28_800,
            })
          : null,
      (url, init) => {
        if (url.hostname !== "api.github.com" || url.pathname !== "/user") return null;
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer CANARY-gh-access");
        return Response.json({ login: "octocat" });
      },
    );

    const callback = await app().request(
      `/auth/github/callback?code=oauth-code&state=${state}`,
      { headers },
      env,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/onboarding");
    const credentials = await env.DB.prepare("SELECT * FROM credentials_encrypted").first();
    expect(credentials).toMatchObject({ github_login: "octocat" });
    expect(JSON.stringify(credentials)).not.toContain("CANARY-");
    expect(await env.DB.prepare("SELECT * FROM oauth_states WHERE state = ?").bind(state).first())
      .toBeNull();
  });

  it("does not allow an arbitrary OAuth return URL", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });
    const user = await seedUser(env);
    const headers = await login(env, user);
    const start = await app().request(
      "/auth/github?return_to=https://evil.example",
      { headers },
      env,
    );
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const row = await env.DB.prepare("SELECT return_to FROM oauth_states WHERE state = ?")
      .bind(state)
      .first<{ return_to: string }>();
    expect(row?.return_to).toBe("/dashboard");
  });
});

describe("GET /api/github/repos", () => {
  it("returns only non-secret repository metadata visible to the connected token", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });
    const user = await seedUser(env);
    const headers = await login(env, user);
    await env.DB.prepare(
      `INSERT INTO credentials_encrypted
         (user_id, github_token, github_expires_at, github_login)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(
        user.id,
        encryptJsonAtRest("CANARY-gh-access", env.CREDENTIAL_MASTER_KEY),
        Date.now() + 3_600_000,
        "octocat",
      )
      .run();
    stubFetch((url, init) => {
      if (url.hostname !== "api.github.com" || url.pathname !== "/user/repos") return null;
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer CANARY-gh-access");
      expect(url.searchParams.get("per_page")).toBe("100");
      return Response.json([
        {
          full_name: "octocat/hello-world",
          private: false,
          archived: false,
          description: "A sample repository",
          clone_url: "https://github.com/octocat/hello-world.git",
        },
        {
          full_name: "acme/private",
          private: true,
          archived: true,
          description: null,
        },
      ]);
    });

    const response = await app().request("/api/github/repos", { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repositories: [
        {
          fullName: "octocat/hello-world",
          private: false,
          archived: false,
          description: "A sample repository",
        },
        {
          fullName: "acme/private",
          private: true,
          archived: true,
          description: null,
        },
      ],
    });
  });

  it("requires a connected GitHub account", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });
    const user = await seedUser(env);
    const response = await app().request("/api/github/repos", { headers: await login(env, user) }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "connect GitHub first" });
  });
});
