/**
 * Signed-request scheme for Worker -> daemon RPC (defense-in-depth on top of
 * HTTPS, and compatible with future mTLS): Ed25519 over a canonical string of
 * method, path, timestamp, nonce, and body hash. The daemon rejects stale
 * timestamps and replayed nonces; nonce retention only needs to cover the
 * timestamp window.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { toB64, fromB64, toHex, utf8 } from "./crypto.js";

export const SIG_HEADER = "x-cs-signature";
export const TS_HEADER = "x-cs-timestamp";
export const NONCE_HEADER = "x-cs-nonce";

/** Max allowed clock skew between signer and verifier, seconds. */
const TIMESTAMP_WINDOW_SEC = 300;

export function generateEd25519Keypair(): { publicKey: string; privateKey: string } {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { publicKey: toB64(pub), privateKey: toB64(priv) };
}

function canonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return [method.toUpperCase(), path, timestamp, nonce, toHex(sha256(utf8(body)))].join("\n");
}

type SignedHeaders = Record<string, string>;

export function signRequest(
  method: string,
  path: string,
  body: string,
  privateKeyB64: string,
  now: () => number = Date.now,
): SignedHeaders {
  const timestamp = Math.floor(now() / 1000).toString();
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = toHex(nonceBytes);
  const msg = canonicalString(method, path, timestamp, nonce, body);
  const sig = ed25519.sign(utf8(msg), fromB64(privateKeyB64));
  return {
    [SIG_HEADER]: toB64(sig),
    [TS_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
  };
}

type VerifyFailure =
  | "missing-headers"
  | "stale-timestamp"
  | "replayed-nonce"
  | "bad-signature";

export interface NonceStore {
  /** Returns true if the nonce was unseen and is now recorded; false if replayed. */
  checkAndRecord(nonce: string, expiresAtSec: number): boolean | Promise<boolean>;
}

export async function verifyRequest(opts: {
  method: string;
  path: string;
  body: string;
  headers: { get(name: string): string | null };
  publicKeyB64: string;
  nonceStore: NonceStore;
  now?: () => number;
}): Promise<VerifyFailure | null> {
  const now = opts.now ?? Date.now;
  const sig = opts.headers.get(SIG_HEADER);
  const timestamp = opts.headers.get(TS_HEADER);
  const nonce = opts.headers.get(NONCE_HEADER);
  if (!sig || !timestamp || !nonce) return "missing-headers";

  const ts = Number(timestamp);
  const nowSec = Math.floor(now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > TIMESTAMP_WINDOW_SEC) {
    return "stale-timestamp";
  }

  const msg = canonicalString(opts.method, opts.path, timestamp, nonce, opts.body);
  let ok = false;
  try {
    ok = ed25519.verify(fromB64(sig), utf8(msg), fromB64(opts.publicKeyB64));
  } catch {
    ok = false;
  }
  if (!ok) return "bad-signature";

  // Record the nonce only after the signature checks out, so unauthenticated
  // traffic cannot pollute the store.
  const fresh = await opts.nonceStore.checkAndRecord(nonce, ts + TIMESTAMP_WINDOW_SEC * 2);
  if (!fresh) return "replayed-nonce";
  return null;
}

/** In-memory nonce store sized by the timestamp window; suitable for the daemon. */
export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  checkAndRecord(nonce: string, expiresAtSec: number): boolean {
    const nowSec = Math.floor(this.now() / 1000);
    if (this.seen.size > 10_000) this.gc(nowSec);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAtSec);
    return true;
  }

  private gc(nowSec: number): void {
    for (const [n, exp] of this.seen) {
      if (exp < nowSec) this.seen.delete(n);
    }
  }
}
