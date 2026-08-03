/**
 * Crypto primitives shared by the control-plane Worker (Workers runtime) and
 * the host daemon (Node runtime). Pure-JS noble libraries are used so both
 * runtimes execute the exact same code — no WebCrypto/node:crypto divergence.
 *
 * - Sealed box: X25519 ECDH (ephemeral) + HKDF-SHA256 + XChaCha20-Poly1305.
 *   Used to seal credential payloads to a destination host's public key so
 *   transport HTTPS never carries those payloads as plaintext.
 * - At-rest encryption: XChaCha20-Poly1305 under the credential master key
 *   (Workers Secret). Used for D1 `credentials_encrypted` blobs.
 */
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";

const SEALED_INFO = "workbench-sealed-v1";
const NONCE_LEN = 24;

// -- encoding helpers --------------------------------------------------------

export function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

// -- sealed box ---------------------------------------------------------------

export function generateX25519Keypair(): { publicKey: string; privateKey: string } {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  return { publicKey: toB64(pub), privateKey: toB64(priv) };
}

function deriveSealKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(recipientPub, 32);
  return hkdf(sha256, shared, salt, SEALED_INFO, 32);
}

/** Seal `plaintext` to a recipient X25519 public key (base64). Output: base64(ephPub || nonce || ct). */
export function seal(plaintext: Uint8Array, recipientPublicKeyB64: string): string {
  const recipientPub = fromB64(recipientPublicKeyB64);
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientPub);
  const key = deriveSealKey(shared, ephPub, recipientPub);
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(32 + NONCE_LEN + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 32 + NONCE_LEN);
  return toB64(out);
}

/** Open a sealed box with the recipient's private key (base64). Throws on tamper/wrong key. */
export function sealOpen(sealedB64: string, recipientPrivateKeyB64: string): Uint8Array {
  const data = fromB64(sealedB64);
  if (data.length < 32 + NONCE_LEN + 16) throw new Error("sealed payload too short");
  const ephPub = data.slice(0, 32);
  const nonce = data.slice(32, 32 + NONCE_LEN);
  const ct = data.slice(32 + NONCE_LEN);
  const priv = fromB64(recipientPrivateKeyB64);
  const recipientPub = x25519.getPublicKey(priv);
  const shared = x25519.getSharedSecret(priv, ephPub);
  const key = deriveSealKey(shared, ephPub, recipientPub);
  return xchacha20poly1305(key, nonce).decrypt(ct);
}

export function sealJson(value: unknown, recipientPublicKeyB64: string): string {
  return seal(utf8(JSON.stringify(value)), recipientPublicKeyB64);
}

export function sealOpenJson<T = unknown>(sealedB64: string, recipientPrivateKeyB64: string): T {
  return JSON.parse(decoder.decode(sealOpen(sealedB64, recipientPrivateKeyB64))) as T;
}

// -- at-rest encryption (credential master key) -------------------------------

/** Encrypt with a 32-byte master key (base64). Output: base64(nonce || ct). */
function encryptAtRest(plaintext: Uint8Array, masterKeyB64: string): string {
  const key = fromB64(masterKeyB64);
  if (key.length !== 32) throw new Error("master key must be 32 bytes");
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(NONCE_LEN + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_LEN);
  return toB64(out);
}

function decryptAtRest(ciphertextB64: string, masterKeyB64: string): Uint8Array {
  const key = fromB64(masterKeyB64);
  const data = fromB64(ciphertextB64);
  const nonce = data.slice(0, NONCE_LEN);
  const ct = data.slice(NONCE_LEN);
  return xchacha20poly1305(key, nonce).decrypt(ct);
}

export function encryptJsonAtRest(value: unknown, masterKeyB64: string): string {
  return encryptAtRest(utf8(JSON.stringify(value)), masterKeyB64);
}

export function decryptJsonAtRest<T = unknown>(ciphertextB64: string, masterKeyB64: string): T {
  return JSON.parse(decoder.decode(decryptAtRest(ciphertextB64, masterKeyB64))) as T;
}

export function generateSymmetricKey(): string {
  return toB64(randomBytes(32));
}
