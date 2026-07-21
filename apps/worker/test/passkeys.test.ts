import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { adminRoutes } from "../src/admin.js";
import { hashInviteCode } from "../src/invites.js";
import { passkeyRoutes } from "../src/passkeys.js";
import { createSession, sha256Hex } from "../src/sessions.js";
import type { AppContext, Bindings, UserRow } from "../src/types.js";
import { makeEnv, seedUser } from "./helpers/env.js";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...original,
    verifyAuthenticationResponse: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
  };
});

const mockedRegistration = vi.mocked(verifyRegistrationResponse);
const mockedAuthentication = vi.mocked(verifyAuthenticationResponse);
const BASE_URL = "https://workbench.test";

function app() {
  return new Hono<AppContext>()
    .route("/", passkeyRoutes)
    .route("/", adminRoutes);
}

function jsonBody(value: object, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(value),
  };
}

function cookieValue(response: Response, name: string): string {
  const value = new RegExp(`${name}=([^;,]+)`).exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (!value) throw new Error(`response did not set ${name}`);
  return `${name}=${value}`;
}

function successfulRegistration(credentialId: string): VerifiedRegistrationResponse {
  return {
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: {
        id: credentialId,
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ["internal", "hybrid"],
      },
      credentialType: "public-key",
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: BASE_URL,
      rpID: "workbench.test",
    },
  };
}

function successfulAuthentication(newCounter = 1): VerifiedAuthenticationResponse {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: "credential-1",
      newCounter,
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: BASE_URL,
      rpID: "workbench.test",
    },
  };
}

async function issueInvite(env: Bindings): Promise<string> {
  const response = await app().request(`${BASE_URL}/api/admin/invites`, {
    method: "POST",
    headers: { authorization: "Bearer admin-secret" },
  }, env);
  expect(response.status).toBe(201);
  return ((await response.json()) as { code: string }).code;
}

async function beginInvite(env: Bindings, code: string): Promise<{ response: Response; cookie: string }> {
  const response = await app().request(
    `${BASE_URL}/auth/invite/register/options`,
    jsonBody({ code }),
    env,
  );
  return { response, cookie: cookieValue(response, "cs_invite_registration") };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("admin invite generation", () => {
  it("is disabled without the Cloudflare secret and rejects the wrong bearer secret", async () => {
    const disabled = makeEnv().env;
    expect((await app().request(`${BASE_URL}/api/admin/invites`, { method: "POST" }, disabled)).status)
      .toBe(404);

    const enabled = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" }).env;
    const unauthorized = await app().request(`${BASE_URL}/api/admin/invites`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    }, enabled);
    expect(unauthorized.status).toBe(401);
  });

  it("returns eight random alphanumeric characters and persists only their keyed HMAC", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const code = await issueInvite(env);

    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    const stored = await env.DB.prepare("SELECT code_hash FROM invite_codes")
      .first<{ code_hash: string }>();
    expect(stored?.code_hash).toBe(await hashInviteCode(code, "admin-secret"));
    expect(stored?.code_hash).not.toContain(code);
  });
});

describe("invite signup", () => {
  it("creates the user, mandatory first passkey, session, and one-time redemption together", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const code = await issueInvite(env);
    const start = await beginInvite(env, code);
    expect(start.response.status).toBe(200);
    const ceremonyToken = start.cookie.slice(start.cookie.indexOf("=") + 1);
    const storedChallenge = await env.DB.prepare(
      "SELECT token_hash FROM auth_challenges",
    ).first<{ token_hash: string }>();
    expect(storedChallenge?.token_hash).toBe(await sha256Hex(ceremonyToken));
    expect(storedChallenge?.token_hash).not.toContain(ceremonyToken);
    mockedRegistration.mockResolvedValueOnce(successfulRegistration("invite-credential"));

    const finish = await app().request(
      `${BASE_URL}/auth/invite/register/verify`,
      jsonBody({ response: { id: "browser-registration" } }, start.cookie),
      env,
    );

    expect(finish.status).toBe(200);
    expect(finish.headers.get("set-cookie")).toContain("cs_session=");
    const user = await env.DB.prepare("SELECT * FROM users").first<UserRow>();
    expect(user?.signup_method).toBe("invite");
    const passkey = await env.DB.prepare(
      "SELECT credential_id, user_id FROM passkeys",
    ).first<{ credential_id: string; user_id: string }>();
    expect(passkey).toEqual({ credential_id: "invite-credential", user_id: user?.id });
    const redemption = await env.DB.prepare(
      "SELECT user_id FROM invite_redemptions",
    ).first<{ user_id: string }>();
    expect(redemption?.user_id).toBe(user?.id);

    const reused = await app().request(
      `${BASE_URL}/auth/invite/register/options`,
      jsonBody({ code }),
      env,
    );
    expect(reused.status).toBe(403);
  });

  it("does not burn the invite or create a user when passkey verification fails", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const code = await issueInvite(env);
    const start = await beginInvite(env, code);
    mockedRegistration.mockRejectedValueOnce(new Error("bad attestation"));

    const failed = await app().request(
      `${BASE_URL}/auth/invite/register/verify`,
      jsonBody({ response: { id: "bad-registration" } }, start.cookie),
      env,
    );
    expect(failed.status).toBe(400);
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(0);
    expect((await env.DB.prepare("SELECT * FROM invite_redemptions").all()).results).toHaveLength(0);

    const retry = await beginInvite(env, code);
    expect(retry.response.status).toBe(200);
  });

  it("allows only one of two concurrent ceremonies to redeem the same code", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const code = await issueInvite(env);
    const first = await beginInvite(env, code);
    const second = await beginInvite(env, code);
    mockedRegistration
      .mockResolvedValueOnce(successfulRegistration("credential-first"))
      .mockResolvedValueOnce(successfulRegistration("credential-second"));

    const firstFinish = await app().request(
      `${BASE_URL}/auth/invite/register/verify`,
      jsonBody({ response: { id: "response-first" } }, first.cookie),
      env,
    );
    const secondFinish = await app().request(
      `${BASE_URL}/auth/invite/register/verify`,
      jsonBody({ response: { id: "response-second" } }, second.cookie),
      env,
    );

    expect(firstFinish.status).toBe(200);
    expect(secondFinish.status).toBe(409);
    expect((await env.DB.prepare("SELECT * FROM users").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM passkeys").all()).results).toHaveLength(1);
    expect((await env.DB.prepare("SELECT * FROM invite_redemptions").all()).results).toHaveLength(1);
  });

  it("keeps an invite redeemed after its account is deleted", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const code = await issueInvite(env);
    const start = await beginInvite(env, code);
    mockedRegistration.mockResolvedValueOnce(successfulRegistration("deleted-user-credential"));
    await app().request(
      `${BASE_URL}/auth/invite/register/verify`,
      jsonBody({ response: { id: "browser-registration" } }, start.cookie),
      env,
    );
    await env.DB.prepare("DELETE FROM users").run();

    const redemption = await env.DB.prepare(
      "SELECT user_id FROM invite_redemptions",
    ).first<{ user_id: string | null }>();
    expect(redemption?.user_id).toBeNull();
    const reused = await app().request(
      `${BASE_URL}/auth/invite/register/options`,
      jsonBody({ code }),
      env,
    );
    expect(reused.status).toBe(403);
  });
});

describe("passkey attachment and login", () => {
  it("lets an authenticated World ID user attach an optional passkey", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const sid = await createSession(env, user.id);
    const start = await app().request(
      `${BASE_URL}/auth/passkey/register/options`,
      jsonBody({}, `cs_session=${sid}`),
      env,
    );
    expect(start.status).toBe(200);
    const registrationCookie = cookieValue(start, "cs_passkey_registration");
    mockedRegistration.mockResolvedValueOnce(successfulRegistration("credential-1"));

    const finish = await app().request(
      `${BASE_URL}/auth/passkey/register/verify`,
      jsonBody(
        { response: { id: "browser-registration" } },
        `cs_session=${sid}; ${registrationCookie}`,
      ),
      env,
    );
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ verified: true, passkeyCount: 1 });
    expect((await env.DB.prepare("SELECT * FROM passkeys").all()).results).toHaveLength(1);
  });

  it("authenticates a discoverable passkey, updates its counter, and consumes the challenge once", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await env.DB.prepare(
      `INSERT INTO passkeys
         (credential_id, user_id, public_key, counter, transports, device_type,
          backed_up, created_at)
       VALUES ('credential-1', ?, ?, 0, '["internal"]', 'multiDevice', 1, ?)`,
    )
      .bind(user.id, new Uint8Array([1, 2, 3, 4]), Date.now())
      .run();
    const start = await app().request(
      `${BASE_URL}/auth/passkey/authenticate/options`,
      { method: "POST" },
      env,
    );
    const authCookie = cookieValue(start, "cs_passkey_auth");
    mockedAuthentication.mockResolvedValueOnce(successfulAuthentication(7));

    const finish = await app().request(
      `${BASE_URL}/auth/passkey/authenticate/verify`,
      jsonBody({ response: { id: "credential-1" } }, authCookie),
      env,
    );
    expect(finish.status).toBe(200);
    expect(finish.headers.get("set-cookie")).toContain("cs_session=");
    const stored = await env.DB.prepare(
      "SELECT counter, last_used_at FROM passkeys WHERE credential_id = 'credential-1'",
    ).first<{ counter: number; last_used_at: number | null }>();
    expect(stored?.counter).toBe(7);
    expect(stored?.last_used_at).not.toBeNull();

    const replay = await app().request(
      `${BASE_URL}/auth/passkey/authenticate/verify`,
      jsonBody({ response: { id: "credential-1" } }, authCookie),
      env,
    );
    expect(replay.status).toBe(400);
    expect(mockedAuthentication).toHaveBeenCalledTimes(1);
  });
});
