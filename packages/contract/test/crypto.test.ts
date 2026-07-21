import { describe, it, expect } from "vitest";
import {
  generateX25519Keypair,
  seal,
  sealOpen,
  sealJson,
  sealOpenJson,
  encryptJsonAtRest,
  decryptJsonAtRest,
  generateSymmetricKey,
  utf8,
  toB64,
  fromB64,
} from "../src/crypto.js";

describe("sealed box", () => {
  it("round-trips a payload sealed to the recipient key", () => {
    const kp = generateX25519Keypair();
    const sealed = seal(utf8("s3cret-llm-key"), kp.publicKey);
    const opened = sealOpen(sealed, kp.privateKey);
    expect(new TextDecoder().decode(opened)).toBe("s3cret-llm-key");
  });

  it("round-trips JSON credential payloads", () => {
    const kp = generateX25519Keypair();
    const payload = { llmKeys: { anthropic: "CANARY-anthropic-key" }, cloudflareToken: "cf-tok" };
    const sealed = sealJson(payload, kp.publicKey);
    expect(sealOpenJson(sealed, kp.privateKey)).toEqual(payload);
  });

  it("produces distinct ciphertexts for the same plaintext (ephemeral keys)", () => {
    const kp = generateX25519Keypair();
    expect(seal(utf8("x"), kp.publicKey)).not.toBe(seal(utf8("x"), kp.publicKey));
  });

  it("fails closed on tampered ciphertext", () => {
    const kp = generateX25519Keypair();
    const sealed = fromB64(seal(utf8("payload"), kp.publicKey));
    sealed[sealed.length - 1]! ^= 0xff;
    expect(() => sealOpen(toB64(sealed), kp.privateKey)).toThrow();
  });

  it("fails closed with the wrong recipient key", () => {
    const kp = generateX25519Keypair();
    const other = generateX25519Keypair();
    const sealed = seal(utf8("payload"), kp.publicKey);
    expect(() => sealOpen(sealed, other.privateKey)).toThrow();
  });

  it("rejects truncated payloads", () => {
    const kp = generateX25519Keypair();
    expect(() => sealOpen(toB64(new Uint8Array(10)), kp.privateKey)).toThrow();
  });
});

describe("at-rest encryption", () => {
  it("round-trips under the master key", () => {
    const key = generateSymmetricKey();
    const ct = encryptJsonAtRest({ openai: "sk-test" }, key);
    expect(decryptJsonAtRest(ct, key)).toEqual({ openai: "sk-test" });
  });

  it("fails with a different master key", () => {
    const ct = encryptJsonAtRest({ a: 1 }, generateSymmetricKey());
    expect(() => decryptJsonAtRest(ct, generateSymmetricKey())).toThrow();
  });

  it("ciphertext does not contain the plaintext", () => {
    const key = generateSymmetricKey();
    const ct = encryptJsonAtRest({ secret: "CANARY-value-123" }, key);
    expect(ct).not.toContain("CANARY-value-123");
  });
});
