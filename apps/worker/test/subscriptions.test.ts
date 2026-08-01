/**
 * Subscription sign-in flows beyond ChatGPT: Claude paste-code PKCE, GitHub
 * Copilot device code, and Cloudflare wrangler paste-URL PKCE. Real Hono app,
 * fake D1, provider endpoints stubbed. Covers start/finish happy paths,
 * user binding, single-use state, encryption at rest, and failure paths.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { decryptLlmKeys, decryptString, getCredentialsRow } from "../src/credentials.js";
import { subscriptionRoutes } from "../src/subscriptions.js";
import type { AppContext, Bindings, UserRow } from "../src/types.js";
import { createTestSession, makeEnv, seedContainer, seedUser, stubFetch, type FetchRoute } from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

function app() {
  return new Hono<AppContext>().route("/", subscriptionRoutes);
}

async function login(env: Bindings, user: UserRow): Promise<Record<string, string>> {
  return { cookie: await createTestSession(env, user.id) };
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function setup(...routes: FetchRoute[]) {
  const { env } = makeEnv();
  const user = await seedUser(env);
  const headers = await login(env, user);
  stubFetch(...routes);
  return { env, headers };
}

// ---------------------------------------------------------------- Claude

/** Stub of Anthropic's token endpoint; captures the exchange body. */
function fakeAnthropic(opts: { fail?: boolean } = {}) {
  const exchanges: Array<Record<string, unknown>> = [];
  const route: FetchRoute = (url, init) => {
    if (url.hostname !== "platform.claude.com") return null;
    if (url.pathname !== "/v1/oauth/token") return null;
    if (opts.fail) return new Response("nope", { status: 500 });
    exchanges.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Response.json({ access_token: "CANARY-oat01" });
  };
  return { route, exchanges };
}

async function startClaude(
  env: Bindings,
  headers: Record<string, string>,
  agent?: "pi" | "claude" | "opencode",
): Promise<string> {
  const res = await app().request(
    "/api/claude/oauth/start",
    agent ? json({ agent }, headers) : { method: "POST", headers },
    env,
  );
  expect(res.status).toBe(200);
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const url = new URL(authorizeUrl);
  expect(url.origin).toBe("https://claude.ai");
  expect(url.searchParams.get("code")).toBe("true");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  return url.searchParams.get("state") ?? "";
}

describe("Claude OAuth", () => {
  it("requires auth to start", async () => {
    const { env } = makeEnv();
    const res = await app().request("/api/claude/oauth/start", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("binds the attempt to the user and exchanges the pasted code with the state as PKCE verifier", async () => {
    const anthropic = fakeAnthropic();
    const { env, headers } = await setup(anthropic.route);
    const state = await startClaude(env, headers);
    expect(state.length).toBeGreaterThanOrEqual(43);
    const row = await env.DB.prepare("SELECT user_id FROM oauth_states WHERE state = ?")
      .bind(`claude:${state}`)
      .first<{ user_id: string }>();
    expect(row?.user_id).toBe("user-1");

    const res = await app().request(
      "/api/claude/oauth/finish",
      json({ code: `authcode-1#${state}` }, headers),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "connected" });
    expect(anthropic.exchanges).toMatchObject([
      {
        grant_type: "authorization_code",
        code: "authcode-1",
        state,
        code_verifier: state,
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
      },
    ]);

    const creds = await getCredentialsRow(env, "user-1");
    expect(creds?.llm_keys).not.toContain("CANARY-oat01"); // ciphertext only in D1
    expect(decryptLlmKeys(env, creds).claude_subscription_token).toBe("CANARY-oat01");
    // Single-use.
    const gone = await env.DB.prepare("SELECT 1 AS x FROM oauth_states WHERE state = ?")
      .bind(`claude:${state}`)
      .first();
    expect(gone).toBeNull();
  });

  it("binds Pi and OpenCode sign-ins to separate credential slots", async () => {
    const anthropic = fakeAnthropic();
    const { env, headers } = await setup(anthropic.route);
    const state = await startClaude(env, headers, "pi");
    const stored = await env.DB.prepare("SELECT user_id FROM oauth_states WHERE state = ?")
      .bind(`claude:pi:${state}`)
      .first<{ user_id: string }>();
    expect(stored?.user_id).toBe("user-1");

    const wrongAgent = await app().request(
      "/api/claude/oauth/finish",
      json({ code: `authcode-1#${state}`, agent: "opencode" }, headers),
      env,
    );
    expect(wrongAgent.status).toBe(403);

    const connected = await app().request(
      "/api/claude/oauth/finish",
      json({ code: `authcode-1#${state}`, agent: "pi" }, headers),
      env,
    );
    expect(connected.status).toBe(200);
    const credentials = decryptLlmKeys(env, await getCredentialsRow(env, "user-1"));
    expect(credentials.pi_claude_subscription_token).toBe("CANARY-oat01");
    expect(credentials.claude_subscription_token).toBeUndefined();
    expect(credentials.opencode_claude_subscription_token).toBeUndefined();
  });

  it("rejects unsupported Claude sign-in targets before creating state", async () => {
    const { env, headers } = await setup(fakeAnthropic().route);
    const res = await app().request(
      "/api/claude/oauth/start",
      json({ agent: "codex" }, headers),
      env,
    );
    expect(res.status).toBe(400);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_states").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("rejects malformed pastes, unknown states, and other users' attempts", async () => {
    const { env, headers } = await setup(fakeAnthropic().route);
    const state = await startClaude(env, headers);

    for (const code of ["", "justacode", `authcode-1#unknown-state`]) {
      const res = await app().request("/api/claude/oauth/finish", json({ code }, headers), env);
      expect([400, 403]).toContain(res.status);
    }

    const mallory = await seedUser(env, "user-2");
    const malloryHeaders = await login(env, mallory);
    const res = await app().request(
      "/api/claude/oauth/finish",
      json({ code: `authcode-1#${state}` }, malloryHeaders),
      env,
    );
    expect(res.status).toBe(403);
    expect(await getCredentialsRow(env, "user-2")).toBeNull();
  });

  it("consumes the attempt and returns 502 when the exchange fails", async () => {
    const { env, headers } = await setup(fakeAnthropic({ fail: true }).route);
    const state = await startClaude(env, headers);
    const res = await app().request(
      "/api/claude/oauth/finish",
      json({ code: `authcode-1#${state}` }, headers),
      env,
    );
    expect(res.status).toBe(502);
    expect(await getCredentialsRow(env, "user-1")).toBeNull();
    const retry = await app().request(
      "/api/claude/oauth/finish",
      json({ code: `authcode-1#${state}` }, headers),
      env,
    );
    expect(retry.status).toBe(403); // single-use even on failure
  });
});

// ---------------------------------------------------------------- Copilot

function fakeGithub(opts: { approved?: boolean; error?: string } = {}) {
  const route: FetchRoute = (url, init) => {
    if (url.hostname !== "github.com") return null;
    if (url.pathname === "/login/device/code") {
      return Response.json({
        device_code: "devcode-1",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      expect(body.device_code).toBe("devcode-1");
      expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
      if (opts.error) return Response.json({ error: opts.error });
      if (!opts.approved) return Response.json({ error: "authorization_pending" });
      return Response.json({ access_token: "CANARY-gho" });
    }
    return null;
  };
  return { route };
}

async function startCopilot(env: Bindings, headers: Record<string, string>) {
  const res = await app().request("/api/copilot/device", { method: "POST", headers }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as { deviceCode: string; userCode: string; verificationUrl: string };
}

describe("GitHub Copilot device flow", () => {
  it("returns the one-time code and binds the attempt to the user", async () => {
    const { env, headers } = await setup(fakeGithub().route);
    const start = await startCopilot(env, headers);
    expect(start).toMatchObject({
      deviceCode: "devcode-1",
      userCode: "ABCD-1234",
      verificationUrl: "https://github.com/login/device",
    });
    const row = await env.DB.prepare("SELECT user_id FROM oauth_states WHERE state = ?")
      .bind("copilot:devcode-1")
      .first<{ user_id: string }>();
    expect(row?.user_id).toBe("user-1");
  });

  it("reports pending, then stores the token encrypted and consumes the attempt", async () => {
    const { env, headers } = await setup(fakeGithub().route);
    const start = await startCopilot(env, headers);
    const pending = await app().request(
      "/api/copilot/device/poll",
      json({ deviceCode: start.deviceCode }, headers),
      env,
    );
    expect(await pending.json()).toEqual({ status: "pending" });

    stubFetch(fakeGithub({ approved: true }).route);
    const res = await app().request(
      "/api/copilot/device/poll",
      json({ deviceCode: start.deviceCode }, headers),
      env,
    );
    expect(await res.json()).toEqual({ status: "connected" });
    const creds = await getCredentialsRow(env, "user-1");
    expect(creds?.llm_keys).not.toContain("CANARY-gho");
    expect(decryptLlmKeys(env, creds).github_copilot).toBe("CANARY-gho");
    const gone = await env.DB.prepare("SELECT 1 AS x FROM oauth_states WHERE state = ?")
      .bind("copilot:devcode-1")
      .first();
    expect(gone).toBeNull();
  });

  it("rejects polls from a different user", async () => {
    const { env, headers } = await setup(fakeGithub({ approved: true }).route);
    const start = await startCopilot(env, headers);
    const mallory = await seedUser(env, "user-2");
    const res = await app().request(
      "/api/copilot/device/poll",
      json({ deviceCode: start.deviceCode }, await login(env, mallory)),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("maps a denied authorization to 502 and consumes the attempt", async () => {
    const { env, headers } = await setup(fakeGithub({ error: "access_denied" }).route);
    const start = await startCopilot(env, headers);
    const res = await app().request(
      "/api/copilot/device/poll",
      json({ deviceCode: start.deviceCode }, headers),
      env,
    );
    expect(res.status).toBe(502);
    expect(await getCredentialsRow(env, "user-1")).toBeNull();
  });
});

// ---------------------------------------------------------------- wrangler

function fakeCloudflare(opts: { fail?: boolean } = {}) {
  const exchanges: Array<URLSearchParams> = [];
  const route: FetchRoute = (url, init) => {
    if (url.hostname !== "dash.cloudflare.com") return null;
    if (url.pathname !== "/oauth2/token") return null;
    if (opts.fail) return new Response("nope", { status: 500 });
    exchanges.push(new URLSearchParams(String(init.body)));
    return Response.json({
      access_token: "CANARY-wr-access",
      refresh_token: "CANARY-wr-refresh",
      expires_in: 3600,
      scope: "account:read workers:write offline_access",
    });
  };
  return { route, exchanges };
}

async function startWrangler(env: Bindings, headers: Record<string, string>): Promise<string> {
  const res = await app().request("/api/wrangler/oauth/start", { method: "POST", headers }, env);
  expect(res.status).toBe(200);
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const url = new URL(authorizeUrl);
  expect(url.origin).toBe("https://dash.cloudflare.com");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8976/oauth/callback");
  expect(url.searchParams.get("scope")).toContain("offline_access");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  return url.searchParams.get("state") ?? "";
}

describe("Cloudflare wrangler OAuth", () => {
  it("exchanges the pasted callback URL and stores the wrangler login encrypted", async () => {
    const cloudflare = fakeCloudflare();
    const { env, headers } = await setup(cloudflare.route);
    const state = await startWrangler(env, headers);

    const res = await app().request(
      "/api/wrangler/oauth/finish",
      json(
        { callbackUrl: `http://localhost:8976/oauth/callback?code=cfcode-1&state=${state}` },
        headers,
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "connected" });
    expect(cloudflare.exchanges[0]?.get("code")).toBe("cfcode-1");
    expect(cloudflare.exchanges[0]?.get("code_verifier")).toBe(state);
    expect(cloudflare.exchanges[0]?.get("grant_type")).toBe("authorization_code");

    const row = await getCredentialsRow(env, "user-1");
    expect(row?.wrangler_oauth).not.toContain("CANARY-"); // ciphertext only in D1
    const stored = JSON.parse(decryptString(env, row!.wrangler_oauth) ?? "{}");
    expect(stored).toMatchObject({
      oauth_token: "CANARY-wr-access",
      refresh_token: "CANARY-wr-refresh",
      scopes: ["account:read", "workers:write"], // offline_access stripped
    });
    expect(new Date(stored.expiration_time).getTime()).toBeGreaterThan(Date.now());
    // Single-use.
    const gone = await env.DB.prepare("SELECT 1 AS x FROM oauth_states WHERE state = ?")
      .bind(`wrangler:${state}`)
      .first();
    expect(gone).toBeNull();
  });

  it("rejects pastes that are not the localhost callback or lack a code", async () => {
    const { env, headers } = await setup(fakeCloudflare().route);
    const state = await startWrangler(env, headers);
    const bad = [
      "not a url",
      `https://evil.example/oauth/callback?code=x&state=${state}`,
      "http://localhost:8976/oauth/callback",
    ];
    for (const callbackUrl of bad) {
      const res = await app().request(
        "/api/wrangler/oauth/finish",
        json({ callbackUrl }, headers),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(await getCredentialsRow(env, "user-1")).toBeNull();
  });

  it("rejects unknown states and consumes the attempt when the exchange fails", async () => {
    const { env, headers } = await setup(fakeCloudflare({ fail: true }).route);
    const unknown = await app().request(
      "/api/wrangler/oauth/finish",
      json({ callbackUrl: "http://localhost:8976/oauth/callback?code=x&state=nope" }, headers),
      env,
    );
    expect(unknown.status).toBe(403);

    const state = await startWrangler(env, headers);
    const res = await app().request(
      "/api/wrangler/oauth/finish",
      json({ callbackUrl: `http://localhost:8976/oauth/callback?code=x&state=${state}` }, headers),
      env,
    );
    expect(res.status).toBe(502);
    expect(await getCredentialsRow(env, "user-1")).toBeNull();
    const retry = await app().request(
      "/api/wrangler/oauth/finish",
      json({ callbackUrl: `http://localhost:8976/oauth/callback?code=x&state=${state}` }, headers),
      env,
    );
    expect(retry.status).toBe(403);
  });
});

// ---------------------------------------------------------------- convex

describe("Convex browser-token OAuth", () => {
  it("exchanges the browser token and stores only the encrypted personal token", async () => {
    const fetchMock = vi.fn();
    const { env, headers } = await setup((url, init) => {
      if (url.href !== "https://api.convex.dev/v1/create_personal_access_token") return null;
      fetchMock(url, init);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer CANARY-browser-token");
      expect(JSON.parse(String(init.body))).toEqual({ name: "usebench.dev workbench" });
      return Response.json({ accessToken: "CANARY-convex-personal" });
    });

    const start = await app().request(
      "/api/convex/oauth/start",
      { method: "POST", headers },
      env,
    );
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({ authorizeUrl: "https://dashboard.convex.dev/auth" });

    const finish = await app().request(
      "/api/convex/oauth/finish",
      json({ authorizationToken: "CANARY-browser-token" }, headers),
      env,
    );
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ status: "connected" });
    expect(fetchMock).toHaveBeenCalledOnce();

    const row = await getCredentialsRow(env, "user-1");
    expect(row?.convex_token).not.toContain("CANARY-");
    expect(decryptString(env, row!.convex_token)).toBe("CANARY-convex-personal");
  });

  it("rejects missing tokens and does not store a failed exchange", async () => {
    const { env, headers } = await setup(() => new Response(null, { status: 401 }));
    const missing = await app().request(
      "/api/convex/oauth/finish",
      json({ authorizationToken: "" }, headers),
      env,
    );
    expect(missing.status).toBe(400);

    const failed = await app().request(
      "/api/convex/oauth/finish",
      json({ authorizationToken: "bad-token" }, headers),
      env,
    );
    expect(failed.status).toBe(502);
    expect(await getCredentialsRow(env, "user-1")).toBeNull();
  });
});

describe("credential setup lock", () => {
  it.each([
    "/api/claude/oauth/start",
    "/api/copilot/device",
    "/api/wrangler/oauth/start",
    "/api/convex/oauth/start",
  ])("refuses %s after a server has been created", async (path) => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedContainer(env, { host_id: null, ssh_port: null });
    const res = await app().request(path, { method: "POST", headers: await login(env, user) }, env);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("manual terminal commands") });
  });

  it("does not finish a subscription sign-in if a server is created while it is pending", async () => {
    const { env, headers } = await setup(fakeAnthropic().route);
    const state = await startClaude(env, headers);
    await seedContainer(env, { host_id: null, ssh_port: null });

    const res = await app().request(
      "/api/claude/oauth/finish",
      json({ code: `authcode-1#${state}` }, headers),
      env,
    );
    expect(res.status).toBe(409);
    expect(await getCredentialsRow(env, "user-1")).toBeNull();
  });
});
