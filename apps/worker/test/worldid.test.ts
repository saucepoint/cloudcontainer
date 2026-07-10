import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySessionProof } from "../src/worldid.js";
import { makeEnv } from "./helpers/env.js";

const proof = {
  protocol_version: "4.0",
  environment: "production",
  session_id: `session_${"a".repeat(128)}`,
  responses: [{ session_nullifier: ["nullifier", "action"] }],
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
});
