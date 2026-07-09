import { describe, it, expect } from "vitest";
import {
  generateEd25519Keypair,
  signRequest,
  verifyRequest,
  MemoryNonceStore,
  SIG_HEADER,
  TS_HEADER,
  NONCE_HEADER,
} from "../src/signing.js";

function headersOf(h: Record<string, string>) {
  const map = new Map(Object.entries(h));
  return { get: (name: string) => map.get(name) ?? null };
}

describe("signed requests", () => {
  const kp = generateEd25519Keypair();
  const body = JSON.stringify({ op: "start", jobId: "j1", containerId: "c1" });

  it("accepts a valid signed request", async () => {
    const h = signRequest("POST", "/jobs", body, kp.privateKey);
    const res = await verifyRequest({
      method: "POST",
      path: "/jobs",
      body,
      headers: headersOf(h),
      publicKeyB64: kp.publicKey,
      nonceStore: new MemoryNonceStore(),
    });
    expect(res).toBeNull();
  });

  it("rejects a tampered body", async () => {
    const h = signRequest("POST", "/jobs", body, kp.privateKey);
    const res = await verifyRequest({
      method: "POST",
      path: "/jobs",
      body: body.replace("start", "destroy"),
      headers: headersOf(h),
      publicKeyB64: kp.publicKey,
      nonceStore: new MemoryNonceStore(),
    });
    expect(res).toBe("bad-signature");
  });

  it("rejects a signature from the wrong key", async () => {
    const other = generateEd25519Keypair();
    const h = signRequest("POST", "/jobs", body, other.privateKey);
    const res = await verifyRequest({
      method: "POST",
      path: "/jobs",
      body,
      headers: headersOf(h),
      publicKeyB64: kp.publicKey,
      nonceStore: new MemoryNonceStore(),
    });
    expect(res).toBe("bad-signature");
  });

  it("rejects a replayed nonce", async () => {
    const h = signRequest("POST", "/jobs", body, kp.privateKey);
    const store = new MemoryNonceStore();
    const first = await verifyRequest({
      method: "POST",
      path: "/jobs",
      body,
      headers: headersOf(h),
      publicKeyB64: kp.publicKey,
      nonceStore: store,
    });
    expect(first).toBeNull();
    const replay = await verifyRequest({
      method: "POST",
      path: "/jobs",
      body,
      headers: headersOf(h),
      publicKeyB64: kp.publicKey,
      nonceStore: store,
    });
    expect(replay).toBe("replayed-nonce");
  });

  it("rejects stale timestamps (injected clock)", async () => {
    const past = () => Date.now() - 10 * 60 * 1000;
    const h = signRequest("POST", "/jobs", body, kp.privateKey, past);
    const res = await verifyRequest({
      method: "POST",
      path: "/jobs",
      body,
      headers: headersOf(h),
      publicKeyB64: kp.publicKey,
      nonceStore: new MemoryNonceStore(),
    });
    expect(res).toBe("stale-timestamp");
  });

  it("rejects missing headers", async () => {
    const res = await verifyRequest({
      method: "POST",
      path: "/jobs",
      body,
      headers: headersOf({ [TS_HEADER]: "1", [NONCE_HEADER]: "n" }),
      publicKeyB64: kp.publicKey,
      nonceStore: new MemoryNonceStore(),
    });
    expect(res).toBe("missing-headers");
  });

  it("rejects a path swap", async () => {
    const h = signRequest("POST", "/jobs", body, kp.privateKey);
    const res = await verifyRequest({
      method: "POST",
      path: "/jobs/other",
      body,
      headers: headersOf(h),
      publicKeyB64: kp.publicKey,
      nonceStore: new MemoryNonceStore(),
    });
    expect(res).toBe("bad-signature");
    expect(h[SIG_HEADER]).toBeTruthy();
  });
});
