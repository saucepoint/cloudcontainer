import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptJsonAtRest } from "@workbench/contract";
import { githubConfigured, githubRoutes } from "../src/github.js";
import { createSession } from "../src/sessions.js";
import type { AppContext, Bindings, UserRow } from "../src/types.js";
import { makeEnv, seedContainer, seedUser, stubFetch } from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

function app() {
  return new Hono<AppContext>().route("/", githubRoutes);
}

const githubConfig = {
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_APP_SLUG: "workbench-test",
} satisfies Partial<Bindings>;

async function login(env: Bindings, user: UserRow): Promise<Record<string, string>> {
  const sid = await createSession(env, user.id);
  return { cookie: `cs_session=${sid}` };
}

describe("GitHub App connection", () => {
  it("starts installation and user authorization from the singular connection route", async () => {
    const { env } = makeEnv(githubConfig);
    const user = await seedUser(env);
    const response = await app().request(
      "/auth/github?return_to=/onboarding",
      { headers: await login(env, user) },
      env,
    );

    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("location")!);
    expect(destination.origin).toBe("https://github.com");
    expect(destination.pathname).toBe("/apps/workbench-test/installations/new");
    expect(destination.searchParams.get("state")).toMatch(/^[a-f\d]{32}$/);
  });

  it("is unavailable unless the install-capable App configuration is complete", async () => {
    for (const overrides of [
      {
        GITHUB_APP_CLIENT_ID: "client-id",
        GITHUB_APP_CLIENT_SECRET: "client-secret",
      },
      { ...githubConfig, GITHUB_APP_SLUG: "not/a/slug" },
    ]) {
      const { env } = makeEnv(overrides);
      const user = await seedUser(env);
      expect(githubConfigured(env)).toBe(false);

      const response = await app().request(
        "/auth/github?return_to=/onboarding",
        { headers: await login(env, user) },
        env,
      );
      expect(response.status).toBe(404);
    }
  });

  it("installs the App before OAuth, then stores only encrypted tokens", async () => {
    const { env } = makeEnv(githubConfig);
    const user = await seedUser(env);
    const headers = await login(env, user);

    const start = await app().request(
      "/auth/github?return_to=/onboarding",
      { headers },
      env,
    );
    expect(start.status).toBe(302);
    const installation = new URL(start.headers.get("location")!);
    expect(installation.origin).toBe("https://github.com");
    expect(installation.pathname).toBe("/apps/workbench-test/installations/new");
    expect(installation.searchParams.get("client_id")).toBeNull();
    const state = installation.searchParams.get("state")!;
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
      `/auth/github/callback?code=oauth-code&installation_id=1234&state=${state}`,
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
    const { env } = makeEnv(githubConfig);
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

  it("preserves working credentials while restarting the singular connection flow", async () => {
    const { env } = makeEnv(githubConfig);
    const user = await seedUser(env);
    const headers = await login(env, user);
    const encryptedGithub = encryptJsonAtRest("CANARY-gh-access", env.CREDENTIAL_MASTER_KEY);
    await env.DB.prepare(
      `INSERT INTO credentials_encrypted
         (user_id, github_token, github_refresh_token, github_expires_at, github_login)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        user.id,
        encryptedGithub,
        encryptJsonAtRest("CANARY-gh-refresh", env.CREDENTIAL_MASTER_KEY),
        Date.now() + 3_600_000,
        "octocat",
      )
      .run();
    const fetchMock = stubFetch();

    const response = await app().request(
      "/auth/github?return_to=/onboarding",
      { headers },
      env,
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/apps/workbench-test/installations/new",
    );
    const credentials = await env.DB.prepare(
      "SELECT github_token, github_login FROM credentials_encrypted WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ github_token: string; github_login: string }>();
    expect(credentials).toMatchObject({ github_token: encryptedGithub, github_login: "octocat" });

    const legacyInstall = await app().request("/auth/github/install", { headers }, env);
    const legacyReauth = await app().request(
      "/auth/github/reauth",
      { method: "POST", headers },
      env,
    );
    expect(legacyInstall.status).toBe(404);
    expect(legacyReauth.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not begin, replace, or complete GitHub authorization after server creation", async () => {
    const { env } = makeEnv(githubConfig);
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

    const start = await app().request(
      "/auth/github?return_to=/onboarding",
      { headers },
      env,
    );
    expect(start.status).toBe(409);
    expect(await start.text()).toContain("manual terminal commands");
    const credentials = await env.DB.prepare(
      "SELECT github_token, github_login FROM credentials_encrypted WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ github_token: string; github_login: string }>();
    expect(credentials).toMatchObject({ github_token: encryptedGithub, github_login: "octocat" });
  });

  it("does not store a GitHub callback that returns after server creation", async () => {
    const { env } = makeEnv(githubConfig);
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
    const { env } = makeEnv(githubConfig);
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
    const { env } = makeEnv(githubConfig);
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
    const { env } = makeEnv(githubConfig);
    const user = await seedUser(env);
    const response = await app().request("/api/github/repos", { headers: await login(env, user) }, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "connect GitHub first" });
  });

  it("is unavailable after server creation because it is only used during setup", async () => {
    const { env } = makeEnv(githubConfig);
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
