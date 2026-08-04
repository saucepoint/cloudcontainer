import { CredentialRequest, IDKit } from "@worldcoin/idkit-core";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { describe, expect, it } from "vitest";
import { withNodeWasmFetch } from "../src/world-id.js";

describe("World ID CLI integration", () => {
  it("initializes IDKit WASM from the installed package in Node", async () => {
    const originalFetch = globalThis.fetch;
    const signed = signRequest({
      action: "verify-account",
      signingKeyHex: "11".repeat(32),
    });
    const request = await withNodeWasmFetch(() => IDKit.requestWithInviteCode({
      app_id: "app_test",
      action: "verify-account",
      rp_context: {
        rp_id: "rp_123456789abcdef0",
        nonce: signed.nonce,
        created_at: signed.createdAt,
        expires_at: signed.expiresAt,
        signature: signed.sig,
      },
      allow_legacy_proofs: false,
    }).constraints(CredentialRequest("proof_of_human", { signal: "account" })));

    expect(request.connectorURI).toMatch(/^https?:\/\//);
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
