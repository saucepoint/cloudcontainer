import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySessionProof } from "../src/worldid.js";
import { makeEnv } from "./helpers/env.js";

const proof = {
  protocol_version: "4.0",
  nonce: "proof-nonce",
  environment: "production",
  session_id: `session_${"a".repeat(128)}`,
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
  it("rejects a proof from a different environment before calling the verifier", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      verifySessionProof(makeEnv({ WORLD_ID_ENVIRONMENT: "staging" }).env, proof),
    ).rejects.toThrow("expected staging, received production");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains the verifier error detail for diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "invalid_rp_signature" }), { status: 400 }),
      ),
    );

    await expect(verifySessionProof(makeEnv().env, proof)).rejects.toThrow(
      /400.*invalid_rp_signature/,
    );
  });

  it("accepts only the session identity confirmed by the verifier", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, session_id: proof.session_id }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(verifySessionProof(makeEnv().env, proof)).resolves.toEqual({
      sessionId: proof.session_id,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v4\/verify\/rp_/),
      expect.objectContaining({ body: JSON.stringify(proof), method: "POST" }),
    );
  });

  it("rejects a false result or a verifier session mismatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          success: true,
          session_id: `session_${"b".repeat(128)}`,
        }), { status: 200 }),
      ),
    );
    await expect(verifySessionProof(makeEnv().env, proof)).rejects.toThrow(
      "different session_id",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false }), { status: 200 }),
      ),
    );
    await expect(verifySessionProof(makeEnv().env, proof)).rejects.toThrow(
      "verifier returned success=false",
    );
  });

  it("rejects a successful verifier response that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));

    await expect(verifySessionProof(makeEnv().env, proof)).rejects.toThrow(
      "verifier returned invalid JSON",
    );
  });

  it("rejects malformed or non-human session proofs before calling the verifier", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(verifySessionProof(makeEnv().env, {
      ...proof,
      responses: [{ identifier: "selfie", issuer_schema_id: 11 }],
    })).rejects.toThrow("missing the proof-of-human credential");
    await expect(verifySessionProof(makeEnv().env, {
      ...proof,
      session_id: "session_invalid",
    })).rejects.toThrow("invalid session_id");
    expect(fetch).not.toHaveBeenCalled();
  });
});
