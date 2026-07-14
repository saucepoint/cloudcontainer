import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptJsonAtRest } from "@codestation/contract";
import { githubRoutes } from "../src/github.js";
import { createSession } from "../src/sessions.js";
import type { AppContext, Bindings, UserRow } from "../src/types.js";
import { makeEnv, seedContainer, seedUser, stubFetch } from "./helpers/env.js";

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
    expect(authorize.searchParams.get("prompt")).toBe("select_account");
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

  it("revokes an existing GitHub authorization before starting a fresh account selection", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });
    const user = await seedUser(env);
    const headers = await login(env, user);
    await env.DB.prepare(
      `INSERT INTO credentials_encrypted
         (user_id, github_token, github_refresh_token, github_expires_at, github_login)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        user.id,
        encryptJsonAtRest("CANARY-gh-access", env.CREDENTIAL_MASTER_KEY),
        encryptJsonAtRest("CANARY-gh-refresh", env.CREDENTIAL_MASTER_KEY),
        Date.now() + 3_600_000,
        "octocat",
      )
      .run();
    stubFetch((url, init) => {
      if (
        url.hostname !== "api.github.com" ||
        url.pathname !== "/applications/client-id/grant"
      ) {
        return null;
      }
      expect(init.method).toBe("DELETE");
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Basic ${btoa("client-id:client-secret")}`,
      );
      expect(init.body).toBe(JSON.stringify({ access_token: "CANARY-gh-access" }));
      return new Response(null, { status: 204 });
    });

    const response = await app().request(
      "/auth/github/reauth?return_to=/onboarding",
      { method: "POST", headers },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl: string };
    const authorize = new URL(body.authorizationUrl);
    expect(authorize.searchParams.get("prompt")).toBe("select_account");
    const credentials = await env.DB.prepare(
      "SELECT github_token, github_refresh_token, github_expires_at, github_login FROM credentials_encrypted WHERE user_id = ?",
    )
      .bind(user.id)
      .first();
    expect(credentials).toEqual({
      github_token: null,
      github_refresh_token: null,
      github_expires_at: null,
      github_login: null,
    });
  });

  it("does not begin, replace, or complete GitHub authorization after server creation", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });
    const user = await seedUser(env);
    const headers = await login(env, user);
    const encryptedGithub = encryptJsonAtRest("CANARY-gh-access", env.CREDENTIAL_MASTER_KEY);
    await env.DB.prepare(
      `INSERT INTO credentials_encrypted (user_id, github_token, github_expires_at, github_login)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(user.id, encryptedGithub, Date.now() + 3_600_000, "octocat")
      .run();
    await seedContainer(env, { host_id: null, ssh_port: null });

    const start = await app().request("/auth/github?return_to=/onboarding", { headers }, env);
    expect(start.status).toBe(409);
    expect(await start.text()).toContain("manual terminal commands");

    const reauth = await app().request(
      "/auth/github/reauth?return_to=/onboarding",
      { method: "POST", headers },
      env,
    );
    expect(reauth.status).toBe(409);
    const credentials = await env.DB.prepare(
      "SELECT github_token, github_login FROM credentials_encrypted WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ github_token: string; github_login: string }>();
    expect(credentials).toMatchObject({ github_token: encryptedGithub, github_login: "octocat" });
  });

  it("does not store a GitHub callback that returns after server creation", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });
    const user = await seedUser(env);
    const headers = await login(env, user);
    const start = await app().request("/auth/github?return_to=/onboarding", { headers }, env);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    await seedContainer(env, { host_id: null, ssh_port: null });

    const callback = await app().request(
      `/auth/github/callback?code=oauth-code&state=${state}`,
      { headers },
      env,
    );
    expect(callback.status).toBe(409);
    expect(await callback.text()).toContain("manual terminal commands");
    expect(await env.DB.prepare("SELECT * FROM credentials_encrypted").first()).toBeNull();
  });
});

describe("GET /api/github/repos", () => {
  it("uses GitHub search instead of filtering a capped recent-repository list", async () => {
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
      if (url.hostname !== "api.github.com") return null;
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer CANARY-gh-access");
      if (url.pathname === "/search/repositories") {
        expect(url.searchParams.get("q")).toBe("world in:name");
        expect(url.searchParams.get("per_page")).toBe("20");
        return Response.json({
          items: [
            {
              full_name: "octocat/hello-world",
              private: false,
              archived: false,
              description: "A sample repository",
            },
            {
              full_name: "acme/world-private",
              private: true,
              archived: true,
              description: null,
            },
          ],
        });
      }
      return null;
    });

    const response = await app().request("/api/github/repos?q=world", { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repositories: [
        {
          fullName: "acme/world-private",
          private: true,
          archived: true,
          description: null,
        },
        {
          fullName: "octocat/hello-world",
          private: false,
          archived: false,
          description: "A sample repository",
        },
      ],
    });
  });

  it("finds an accessible private repository by exact owner/name", async () => {
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
      if (url.hostname !== "api.github.com" || url.pathname !== "/repos/acme/private") {
        return null;
      }
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer CANARY-gh-access");
      return Response.json({
        full_name: "acme/private",
        private: true,
        archived: false,
        description: "Private and installed",
      });
    });

    const response = await app().request("/api/github/repos?q=acme%2Fprivate", { headers }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repositories: [
        {
          fullName: "acme/private",
          private: true,
          archived: false,
          description: "Private and installed",
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

  it("is unavailable after server creation because it is only used during setup", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });
    const user = await seedUser(env);
    await seedContainer(env, { host_id: null, ssh_port: null });

    const response = await app().request(
      "/api/github/repos?q=octocat",
      { headers: await login(env, user) },
      env,
    );
    expect(response.status).toBe(409);
  });
});
