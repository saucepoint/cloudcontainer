import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyWorldIdProof } from "../src/worldid.js";
import { makeEnv } from "./helpers/env.js";

const nullifier = `0x${"a".repeat(64)}`;
const normalizedNullifier = BigInt(nullifier).toString(10);
const v3Proof = {
  protocol_version: "3.0",
  nonce: "proof-nonce",
  action: "codestation-login",
  environment: "production",
  user_presence_completed: false,
  responses: [{
    identifier: "orb",
    proof: "0xproof",
    merkle_root: `0x${"b".repeat(64)}`,
    nullifier,
  }],
};
const v4Proof = {
  protocol_version: "4.0",
  nonce: "proof-nonce",
  action: "codestation-login",
  environment: "production",
  user_presence_completed: false,
  responses: [{
    identifier: "proof_of_human",
    issuer_schema_id: 1,
    proof: ["proof"],
    expires_at_min: 1,
    nullifier,
  }],
};
const sessionProof = {
  protocol_version: "4.0",
  nonce: "proof-nonce",
  environment: "production",
  session_id: `session_${"c".repeat(128)}`,
  responses: [{
    identifier: "proof_of_human",
    issuer_schema_id: 1,
    proof: ["proof"],
    expires_at_min: 1,
    session_nullifier: ["nullifier", "action"],
  }],
};

afterEach(() => vi.unstubAllGlobals());

describe("World ID proof verification", () => {
  it("accepts an Orb v3 proof for the configured action", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        action: "codestation-login",
        nullifier,
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(verifyWorldIdProof(makeEnv().env, v3Proof)).resolves.toEqual({
      identityKey: `worldid-nullifier:${normalizedNullifier}`,
      protocolVersion: "3.0",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v4\/verify\/rp_/),
      expect.objectContaining({ body: JSON.stringify(v3Proof), method: "POST" }),
    );
  });

  it("accepts the matching v4 proof-of-human uniqueness proof", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        results: [{ success: true, nullifier }],
      }), { status: 200 }),
    ));

    await expect(verifyWorldIdProof(makeEnv().env, v4Proof)).resolves.toEqual({
      identityKey: `worldid-nullifier:${normalizedNullifier}`,
      protocolVersion: "4.0",
    });
  });

  it("retains compatibility with an existing v4 session identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, session_id: sessionProof.session_id }), {
        status: 200,
      }),
    ));

    await expect(verifyWorldIdProof(makeEnv().env, sessionProof)).resolves.toEqual({
      identityKey: sessionProof.session_id,
      protocolVersion: "4.0",
    });
  });

  it("rejects the wrong environment, action, or credential before verification", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(verifyWorldIdProof(
      makeEnv({ WORLD_ID_ENVIRONMENT: "staging" }).env,
      v3Proof,
    )).rejects.toThrow("expected staging, received production");
    await expect(verifyWorldIdProof(makeEnv().env, {
      ...v3Proof,
      action: "different-action",
    })).rejects.toThrow("expected codestation-login, received different-action");
    await expect(verifyWorldIdProof(makeEnv().env, {
      ...v3Proof,
      responses: [{ ...v3Proof.responses[0], identifier: "device" }],
    })).rejects.toThrow("missing the required proof-of-human credential");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a false result or a verifier identity mismatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, nullifier: `0x${"d".repeat(64)}` }), {
        status: 200,
      }),
    ));
    await expect(verifyWorldIdProof(makeEnv().env, v3Proof)).rejects.toThrow(
      "different nullifier",
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 200 }),
    ));
    await expect(verifyWorldIdProof(makeEnv().env, v3Proof)).rejects.toThrow(
      "verifier returned success=false",
    );
  });

  it("retains verifier errors for diagnostics and rejects non-JSON success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "invalid_rp_signature" }), { status: 400 }),
    ));
    await expect(verifyWorldIdProof(makeEnv().env, v3Proof)).rejects.toThrow(
      /400.*invalid_rp_signature/,
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    await expect(verifyWorldIdProof(makeEnv().env, v3Proof)).rejects.toThrow(
      "verifier returned invalid JSON",
    );
  });
});
