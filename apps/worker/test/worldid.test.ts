import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorldIdContext,
  verifyWorldIdSession,
  WorldIdVerificationError,
} from "../src/worldid.js";
import { makeEnv } from "./helpers/env.js";

const sessionProof = {
  protocol_version: "4.0",
  nonce: "proof-nonce",
  environment: "production",
  session_id: `session_${"c".repeat(128)}`,
  responses: [{
    identifier: "proof_of_human",
    issuer_schema_id: 1,
    proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
    expires_at_min: 1,
    session_nullifier: ["0xnullifier", "0xaction"],
  }],
};

function verifiedResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    success: true,
    session_id: sessionProof.session_id,
    environment: "production",
    results: [{ identifier: "proof_of_human", success: true }],
    ...overrides,
  }), { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe("World ID v4 session integration", () => {
  it("signs an actionless RP context on the server", () => {
    const context = createWorldIdContext(makeEnv().env);

    expect(context).toEqual({
      app_id: "app_test",
      environment: "production",
      rp_context: {
        rp_id: "rp_test",
        nonce: expect.any(String),
        created_at: expect.any(Number),
        expires_at: expect.any(Number),
        signature: expect.stringMatching(/^0x[0-9a-f]+$/),
      },
    });
    expect(context).not.toHaveProperty("action");
    expect(context.rp_context.expires_at).toBeGreaterThan(context.rp_context.created_at);
  });

  it("forwards an unmodified v4 session proof and accepts its verified session ID", async () => {
    const fetch = vi.fn().mockResolvedValue(verifiedResponse());
    vi.stubGlobal("fetch", fetch);

    await expect(verifyWorldIdSession(makeEnv().env, sessionProof)).resolves.toBe(
      sessionProof.session_id,
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v4\/verify\/rp_test$/),
      expect.objectContaining({
        body: JSON.stringify(sessionProof),
        method: "POST",
      }),
    );
  });

  it("rejects legacy, uniqueness, wrong-environment, and wrong-credential payloads locally", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(verifyWorldIdSession(makeEnv().env, {
      ...sessionProof,
      protocol_version: "3.0",
    })).rejects.toThrow("not protocol version 4.0");
    await expect(verifyWorldIdSession(makeEnv().env, {
      ...sessionProof,
      session_id: undefined,
      action: "codestation-login",
    })).rejects.toThrow("not a session proof");
    await expect(verifyWorldIdSession(makeEnv({ WORLD_ID_ENVIRONMENT: "staging" }).env, sessionProof))
      .rejects.toThrow("wrong environment");
    await expect(verifyWorldIdSession(makeEnv().env, {
      ...sessionProof,
      responses: [{ ...sessionProof.responses[0], identifier: "passport" }],
    })).rejects.toThrow("missing the Proof of Human credential");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires the verifier to confirm the same session and Proof of Human result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      verifiedResponse({ session_id: `session_${"d".repeat(128)}` }),
    ));
    await expect(verifyWorldIdSession(makeEnv().env, sessionProof)).rejects.toThrow(
      "different session",
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      verifiedResponse({ results: [{ identifier: "proof_of_human", success: false }] }),
    ));
    await expect(verifyWorldIdSession(makeEnv().env, sessionProof)).rejects.toThrow(
      "did not verify Proof of Human",
    );
  });

  it("classifies verifier rejections and outages without exposing the proof", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "invalid_rp_signature" }), { status: 400 }),
    ));
    await expect(verifyWorldIdSession(makeEnv().env, sessionProof)).rejects.toMatchObject({
      message: "World ID verifier rejected the proof (invalid_rp_signature)",
      status: 400,
    } satisfies Partial<WorldIdVerificationError>);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(verifyWorldIdSession(makeEnv().env, sessionProof)).rejects.toMatchObject({
      message: "World ID verifier returned invalid JSON",
      status: 502,
    } satisfies Partial<WorldIdVerificationError>);
  });
});
