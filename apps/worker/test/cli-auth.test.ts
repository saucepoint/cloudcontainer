import { describe, expect, it } from "vitest";
import { app as workerApp } from "../src/index.js";
import { createTestSession, makeEnv, seedUser } from "./helpers/env.js";

const json = (body: unknown, headers: HeadersInit = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("CLI browser authentication bridge", () => {
  it("rejects non-loopback callbacks and unavailable providers", async () => {
    const { env } = makeEnv({
      AUTH_GOOGLE_CLIENT_ID: "google-client",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
    });
    const invalid = await workerApp.request(
      "/api/cli/auth/start",
      json({ provider: "google", callbackUri: "https://evil.example/callback", state: "a".repeat(32) }),
      env,
    );
    expect(invalid.status).toBe(400);

    const unavailable = await workerApp.request(
      "/api/cli/auth/start",
      json({ provider: "github", callbackUri: "http://127.0.0.1:4123/callback", state: "a".repeat(32) }),
      env,
    );
    expect(unavailable.status).toBe(503);
  });

  it("creates a browser URL for a valid provider and callback", async () => {
    const { env } = makeEnv({
      AUTH_GOOGLE_CLIENT_ID: "google-client",
      AUTH_GOOGLE_CLIENT_SECRET: "google-secret",
    });
    const response = await workerApp.request(
      "/api/cli/auth/start",
      json({ provider: "google", callbackUri: "http://127.0.0.1:4123/callback", state: "a".repeat(32) }),
      env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { browserUrl: string; expiresInSec: number };
    expect(body.browserUrl).toMatch(/^https:\/\/usebench\.dev\/cli\/auth\?attempt=[a-f0-9]{64}$/);
    expect(body.expiresInSec).toBe(600);
  });

  it("exchanges a callback code once for a separate signed session", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env, "cli-user");
    const cookie = await createTestSession(env, user.id);
    const now = Date.now();
    const attemptId = "a".repeat(64);
    await env.DB.prepare(
      `INSERT INTO cli_auth_attempts
         (id, provider, callback_uri, state, created_at, expires_at)
       VALUES (?, 'google', ?, ?, ?, ?)`,
    ).bind(attemptId, "http://127.0.0.1:4123/callback", "b".repeat(32), now, now + 600_000).run();

    const callback = await workerApp.request(
      `/cli/auth/callback?attempt=${attemptId}`,
      { headers: { cookie } },
      env,
    );
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "");
    expect(location.hostname).toBe("127.0.0.1");
    expect(location.searchParams.get("state")).toBe("b".repeat(32));
    const code = location.searchParams.get("code");
    expect(code).toMatch(/^[a-f0-9]{64}$/);

    const exchange = await workerApp.request(
      "/api/cli/auth/exchange",
      json({ code }),
      env,
    );
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get("set-cookie")).toContain("usebench.session_token=");

    const replay = await workerApp.request(
      "/api/cli/auth/exchange",
      json({ code }),
      env,
    );
    expect(replay.status).toBe(403);
  });

  it("returns only non-secret session state", async () => {
    const { env } = makeEnv({ WORLD_ID_APP_ID: "app_test", WORLD_ID_RP_ID: "rp_test", WORLD_ID_SIGNING_KEY: "a".repeat(64) });
    const user = await seedUser(env, "state-user");
    const cookie = await createTestSession(env, user.id);
    const response = await workerApp.request("/api/cli/session", { headers: { cookie } }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verified: true,
      worldIdAvailable: true,
      githubAvailable: false,
      hasWorkbench: false,
      redirect: "/onboarding",
    });
  });
});
