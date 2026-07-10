import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  createSession,
  getSessionUserId,
  isSessionRevoked,
  readCookie,
  revokeSession,
  SESSION_COOKIE,
  sessionCookie,
} from "../src/sessions.js";
import { makeEnv } from "./helpers/env.js";

describe("readCookie", () => {
  it("finds a cookie among several", () => {
    expect(readCookie("a=1; cs_session=abc; b=2", "cs_session")).toBe("abc");
  });

  it("returns null when absent or header missing", () => {
    expect(readCookie("a=1; b=2", "cs_session")).toBeNull();
    expect(readCookie(undefined, "cs_session")).toBeNull();
  });

  it("does not match a cookie whose name is a suffix", () => {
    expect(readCookie("xcs_session=evil", "cs_session")).toBeNull();
  });

  it("keeps '=' inside the value intact", () => {
    expect(readCookie("cs_session=abc=def", "cs_session")).toBe("abc=def");
  });
});

describe("session cookies", () => {
  it("sets HttpOnly and SameSite, adding Secure only for https deployments", () => {
    const secure = sessionCookie("sid123", true);
    expect(secure).toContain(`${SESSION_COOKIE}=sid123`);
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("SameSite=Lax");
    expect(secure).toContain("; Secure");
    expect(sessionCookie("sid123", false)).not.toContain("Secure");
  });

  it("clears with Max-Age=0", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
    expect(clearSessionCookie()).toContain(`${SESSION_COOKIE}=;`);
  });
});

describe("session lifecycle", () => {
  it("round-trips a session through KV", async () => {
    const { env } = makeEnv();
    const sid = await createSession(env, "user-1");
    expect(sid).toMatch(/^[0-9a-f]{64}$/);
    expect(await getSessionUserId(env, sid)).toBe("user-1");
    expect(await getSessionUserId(env, "unknown")).toBeNull();
  });

  it("revocation deletes KV and records in D1 (strong consistency for sensitive ops)", async () => {
    const { env } = makeEnv();
    const sid = await createSession(env, "user-1");
    expect(await isSessionRevoked(env, sid)).toBe(false);

    await revokeSession(env, sid);
    expect(await getSessionUserId(env, sid)).toBeNull();
    expect(await isSessionRevoked(env, sid)).toBe(true);
  });

  it("tolerates corrupt KV session data", async () => {
    const { env, kv } = makeEnv();
    kv.store.set("sess:bad", "not-json");
    expect(await getSessionUserId(env, "bad")).toBeNull();
  });
});
