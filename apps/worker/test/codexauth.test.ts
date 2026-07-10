/**
 * "Sign in with ChatGPT" device-code flow: real Hono app, fake D1/KV, OpenAI
 * endpoints stubbed. Covers start, pending/approved polls, auth.json assembly,
 * user binding of the attempt, expiry, and upstream failure paths.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { generateX25519Keypair } from "@codestation/contract";
import { buildCodexAuthJson, codexAuthRoutes } from "../src/codexauth.js";
import { decryptLlmKeys, getCredentialsRow } from "../src/credentials.js";
import { createSession } from "../src/sessions.js";
import type { AppContext, Bindings, UserRow } from "../src/types.js";
import { makeEnv, seedContainer, seedHost, seedUser, stubFetch, type FetchRoute } from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

function app() {
  return new Hono<AppContext>().route("/", codexAuthRoutes);
}

async function login(env: Bindings, user: UserRow): Promise<Record<string, string>> {
  const sid = await createSession(env, user.id);
  return { cookie: `cs_session=${sid}` };
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** Unsigned JWT with the OpenAI auth-claims namespace, as in a real id_token. */
function fakeIdToken(authClaims: Record<string, unknown>): string {
  const b64url = (s: string) =>
    Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const payload = b64url(JSON.stringify({ "https://api.openai.com/auth": authClaims }));
  return `${b64url('{"alg":"none"}')}.${payload}.sig`;
}

/** Stub of auth.openai.com; `approved` flips the poll from pending to success. */
function fakeOpenAI(opts: { approved?: boolean; idToken?: string } = {}) {
  const idToken = opts.idToken ?? fakeIdToken({ chatgpt_account_id: "acct-42" });
  const calls: string[] = [];
  const route: FetchRoute = (url, init) => {
    if (url.hostname !== "auth.openai.com") return null;
    calls.push(url.pathname);
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      return Response.json({ device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      if (!opts.approved) return Response.json({ error: "pending" }, { status: 403 });
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      expect(body).toEqual({ device_auth_id: "dev-1", user_code: "ABCD-1234" });
      return Response.json({
        authorization_code: "authcode-1",
        code_challenge: "chal",
        code_verifier: "verif",
      });
    }
    if (url.pathname === "/oauth/token") {
      const params = new URLSearchParams(String(init.body));
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("authcode-1");
      expect(params.get("code_verifier")).toBe("verif");
      expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
      return Response.json({
        id_token: idToken,
        access_token: "CANARY-access",
        refresh_token: "CANARY-refresh",
      });
    }
    return null;
  };
  return { route, calls, idToken };
}

async function setup(openai = fakeOpenAI()) {
  const { env } = makeEnv();
  const user = await seedUser(env);
  const headers = await login(env, user);
  stubFetch(openai.route);
  return { env, headers, openai };
}

async function startDevice(env: Bindings, headers: Record<string, string>) {
  const res = await app().request("/api/codex/device", { method: "POST", headers }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    deviceAuthId: string;
    userCode: string;
    verificationUrl: string;
    intervalSec: number;
    expiresInSec: number;
  };
}

describe("buildCodexAuthJson", () => {
  it("assembles the auth.json the Codex CLI expects, with account_id from the JWT", () => {
    const idToken = fakeIdToken({ chatgpt_account_id: "acct-42" });
    const parsed = JSON.parse(
      buildCodexAuthJson({ id_token: idToken, access_token: "a", refresh_token: "r" }),
    );
    expect(parsed).toEqual({
      OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: "a", refresh_token: "r", account_id: "acct-42" },
      last_refresh: expect.any(String),
    });
    expect(new Date(parsed.last_refresh).getTime()).not.toBeNaN();
  });

  it("tolerates an id_token without the account claim", () => {
    const parsed = JSON.parse(
      buildCodexAuthJson({ id_token: "garbage", access_token: "a", refresh_token: "r" }),
    );
    expect(parsed.tokens.account_id).toBeNull();
  });
});

describe("POST /api/codex/device", () => {
  it("requires auth", async () => {
    const { env } = makeEnv();
    const res = await app().request("/api/codex/device", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("returns the one-time code and binds the attempt to the user", async () => {
    const { env, headers } = await setup();
    const start = await startDevice(env, headers);
    expect(start).toEqual({
      deviceAuthId: "dev-1",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalSec: 5,
      expiresInSec: 900,
    });
    const row = await env.DB.prepare("SELECT user_id FROM oauth_states WHERE state = ?")
      .bind("codex:dev-1")
      .first<{ user_id: string }>();
    expect(row?.user_id).toBe("user-1");
  });

  it("maps an OpenAI outage to a 502 without creating state", async () => {
    const { env, headers } = await setup({
      route: (url) => (url.hostname === "auth.openai.com" ? new Response("nope", { status: 500 }) : null),
      calls: [],
      idToken: "",
    });
    const res = await app().request("/api/codex/device", { method: "POST", headers }, env);
    expect(res.status).toBe(502);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_states").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("POST /api/codex/device/poll", () => {
  it("reports pending while the user has not approved", async () => {
    const { env, headers } = await setup(fakeOpenAI({ approved: false }));
    const start = await startDevice(env, headers);
    const res = await app().request(
      "/api/codex/device/poll",
      json({ deviceAuthId: start.deviceAuthId, userCode: start.userCode }, headers),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
    // Attempt survives for the next poll.
    const row = await env.DB.prepare("SELECT 1 AS x FROM oauth_states WHERE state = ?")
      .bind("codex:dev-1")
      .first();
    expect(row).toBeTruthy();
  });

  it("stores the credential encrypted and consumes the attempt on approval", async () => {
    const openai = fakeOpenAI({ approved: true });
    const { env, headers } = await setup(openai);
    const start = await startDevice(env, headers);
    const res = await app().request(
      "/api/codex/device/poll",
      json({ deviceAuthId: start.deviceAuthId, userCode: start.userCode }, headers),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "connected" });

    const row = await getCredentialsRow(env, "user-1");
    expect(row?.llm_keys).not.toContain("CANARY-access"); // ciphertext only in D1
    const authJson = JSON.parse(decryptLlmKeys(env, row).codex_subscription_token ?? "");
    expect(authJson.tokens).toEqual({
      id_token: openai.idToken,
      access_token: "CANARY-access",
      refresh_token: "CANARY-refresh",
      account_id: "acct-42",
    });

    const state = await env.DB.prepare("SELECT 1 AS x FROM oauth_states WHERE state = ?")
      .bind("codex:dev-1")
      .first();
    expect(state).toBeNull(); // single-use
  });

  it("pushes refresh-credentials to a running container on approval", async () => {
    const openai = fakeOpenAI({ approved: true });
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: generateX25519Keypair().publicKey });
    await seedContainer(env);
    const headers = await login(env, user);
    const jobs: string[] = [];
    stubFetch(openai.route, (url, init) => {
      if (url.pathname === "/jobs" && init.method === "POST") {
        jobs.push((JSON.parse(String(init.body)) as { op: string }).op);
        return Response.json({ ok: true }, { status: 202 });
      }
      return null;
    });
    const start = await startDevice(env, headers);
    const res = await app().request(
      "/api/codex/device/poll",
      json({ deviceAuthId: start.deviceAuthId, userCode: start.userCode }, headers),
      env,
    );
    expect(res.status).toBe(200);
    expect(jobs).toContain("refresh-credentials");
  });

  it("rejects polls from a different user", async () => {
    const { env, headers } = await setup(fakeOpenAI({ approved: true }));
    const start = await startDevice(env, headers);
    const mallory = await seedUser(env, "user-2");
    const malloryHeaders = await login(env, mallory);
    const res = await app().request(
      "/api/codex/device/poll",
      json({ deviceAuthId: start.deviceAuthId, userCode: start.userCode }, malloryHeaders),
      env,
    );
    expect(res.status).toBe(403);
    expect(await getCredentialsRow(env, "user-2")).toBeNull();
  });

  it("rejects unknown and expired attempts", async () => {
    const { env, headers } = await setup(fakeOpenAI({ approved: true }));
    const unknown = await app().request(
      "/api/codex/device/poll",
      json({ deviceAuthId: "nope", userCode: "ABCD-1234" }, headers),
      env,
    );
    expect(unknown.status).toBe(403);

    const start = await startDevice(env, headers);
    await env.DB.prepare("UPDATE oauth_states SET expires_at = ? WHERE state = ?")
      .bind(Date.now() - 1, "codex:dev-1")
      .run();
    const expired = await app().request(
      "/api/codex/device/poll",
      json({ deviceAuthId: start.deviceAuthId, userCode: start.userCode }, headers),
      env,
    );
    expect(expired.status).toBe(403);
  });

  it("consumes the attempt and returns 502 when the token exchange fails", async () => {
    const { env, headers } = await setup();
    const start = await startDevice(env, headers);
    stubFetch((url) => {
      if (url.pathname === "/api/accounts/deviceauth/token") {
        return Response.json({
          authorization_code: "authcode-1",
          code_challenge: "chal",
          code_verifier: "verif",
        });
      }
      if (url.pathname === "/oauth/token") return new Response("bad", { status: 500 });
      return null;
    });
    const res = await app().request(
      "/api/codex/device/poll",
      json({ deviceAuthId: start.deviceAuthId, userCode: start.userCode }, headers),
      env,
    );
    expect(res.status).toBe(502);
    const state = await env.DB.prepare("SELECT 1 AS x FROM oauth_states WHERE state = ?")
      .bind("codex:dev-1")
      .first();
    expect(state).toBeNull();
    expect(await getCredentialsRow(env, "user-1")).toBeNull();
  });
});
