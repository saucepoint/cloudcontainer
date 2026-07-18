/**
 * World ID authentication supports two compatible proof paths:
 *
 * - Existing IDKit v4 sessions continue to resolve to their `session_id`.
 * - New sign-ins use the `proofOfHuman()` preset for the fixed login action.
 *   IDKit can satisfy that request with either a v4 proof-of-human credential
 *   or its Orb-verified v3 fallback.
 *
 * The v3/v4 uniqueness nullifier is stable only for this app and action. It is
 * normalized before persistence so equivalent hexadecimal encodings cannot
 * create multiple accounts.
 */
import { signRequest } from "@worldcoin/idkit-core/signing";
import type { Bindings } from "./types.js";

const VERIFY_URL = (rpId: string) => `https://developer.world.org/api/v4/verify/${rpId}`;
const SESSION_ID_PATTERN = /^session_[0-9a-f]{128}$/i;
const NULLIFIER_PATTERN = /^0x[0-9a-f]{64}$/i;

interface WorldIdRpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

type WorldIdProofMode = "proof" | "session";

/** Sign a fresh RP context. Uniqueness proofs bind the configured login action. */
export function signWorldIdRequest(
  env: Bindings,
  mode: WorldIdProofMode,
): WorldIdRpContext {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: env.RP_SIGNING_KEY,
    ...(mode === "proof" ? { action: env.WORLD_ID_ACTION } : {}),
  });
  return {
    rp_id: env.WORLD_ID_RP_ID,
    nonce,
    created_at: createdAt,
    expires_at: expiresAt,
    signature: sig,
  };
}

export interface WorldIdIdentity {
  identityKey: string;
  protocolVersion: "3.0" | "4.0";
}

type ParsedProof =
  | { kind: "session"; payload: Record<string, unknown>; sessionId: string }
  | {
      kind: "uniqueness";
      payload: Record<string, unknown>;
      protocolVersion: "3.0" | "4.0";
      nullifier: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNullifier(value: unknown): string | null {
  if (typeof value !== "string" || !NULLIFIER_PATTERN.test(value)) return null;
  return BigInt(value).toString(10);
}

function parseProof(env: Bindings, value: unknown): ParsedProof {
  if (!isRecord(value)) throw new Error("world id proof must be an object");
  if (value.environment !== env.WORLD_ID_ENVIRONMENT) {
    throw new Error(
      `world id environment mismatch: expected ${env.WORLD_ID_ENVIRONMENT}, received ${String(value.environment)}`,
    );
  }
  if (typeof value.nonce !== "string" || !value.nonce) {
    throw new Error("world id proof has an invalid nonce");
  }
  if (!Array.isArray(value.responses) || value.responses.length === 0) {
    throw new Error("world id proof has no credential responses");
  }

  if (value.protocol_version === "4.0" && SESSION_ID_PATTERN.test(String(value.session_id))) {
    const credential = value.responses.find((response) =>
      isRecord(response) && response.identifier === "proof_of_human" && response.issuer_schema_id === 1
    );
    if (!credential) {
      throw new Error("world id session proof is missing the proof-of-human credential");
    }
    return { kind: "session", payload: value, sessionId: String(value.session_id) };
  }

  if (value.action !== env.WORLD_ID_ACTION) {
    throw new Error(
      `world id action mismatch: expected ${env.WORLD_ID_ACTION}, received ${String(value.action)}`,
    );
  }

  const protocolVersion = value.protocol_version;
  if (protocolVersion !== "3.0" && protocolVersion !== "4.0") {
    throw new Error(`unsupported world id protocol version: ${String(protocolVersion)}`);
  }
  const credential = value.responses.find((response) => {
    if (!isRecord(response)) return false;
    return protocolVersion === "3.0"
      ? response.identifier === "orb"
      : response.identifier === "proof_of_human" && response.issuer_schema_id === 1;
  });
  if (!isRecord(credential)) {
    throw new Error("world id proof is missing the required proof-of-human credential");
  }
  const nullifier = normalizeNullifier(credential.nullifier);
  if (!nullifier) throw new Error("world id proof has an invalid nullifier");
  return {
    kind: "uniqueness",
    payload: value,
    protocolVersion,
    nullifier,
  };
}

function verifiedNullifier(response: Record<string, unknown>): string | null {
  const topLevel = normalizeNullifier(response.nullifier);
  if (topLevel) return topLevel;
  if (!Array.isArray(response.results)) return null;
  for (const result of response.results) {
    if (isRecord(result) && result.success === true) {
      const normalized = normalizeNullifier(result.nullifier);
      if (normalized) return normalized;
    }
  }
  return null;
}

/** Forward an unmodified IDKit result to the Developer Portal and extract its verified identity. */
export async function verifyWorldIdProof(
  env: Bindings,
  idkitResponse: unknown,
): Promise<WorldIdIdentity> {
  const proof = parseProof(env, idkitResponse);
  const res = await fetch(VERIFY_URL(env.WORLD_ID_RP_ID), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "codestation-world-id/1.0",
    },
    body: JSON.stringify(proof.payload),
  });
  const responseBody = await res.text();
  let verifierResponse: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (isRecord(parsed)) verifierResponse = parsed;
  } catch {
    // A successful verifier response is JSON and is rejected below otherwise.
  }
  if (!res.ok) {
    const verifierCode =
      typeof verifierResponse?.code === "string" && /^[a-z0-9_]{1,64}$/.test(verifierResponse.code)
        ? ` (${verifierResponse.code})`
        : "";
    throw new Error(`world id proof verification failed with status ${res.status}${verifierCode}`);
  }
  if (!verifierResponse) {
    throw new Error("world id proof verification failed: verifier returned invalid JSON");
  }
  if (verifierResponse.success !== true) {
    throw new Error(
      `world id proof verification failed: verifier returned success=${String(verifierResponse.success)}`,
    );
  }
  if ("environment" in verifierResponse && verifierResponse.environment !== env.WORLD_ID_ENVIRONMENT) {
    throw new Error("world id verifier returned a different environment");
  }

  if (proof.kind === "session") {
    if (verifierResponse.session_id !== proof.sessionId) {
      throw new Error("world id verifier returned a different session_id");
    }
    return { identityKey: proof.sessionId, protocolVersion: "4.0" };
  }

  if ("action" in verifierResponse && verifierResponse.action !== env.WORLD_ID_ACTION) {
    throw new Error("world id verifier returned a different action");
  }
  const nullifier = verifiedNullifier(verifierResponse);
  if (!nullifier || nullifier !== proof.nullifier) {
    throw new Error("world id verifier returned a different nullifier");
  }
  return {
    identityKey: `worldid-nullifier:${nullifier}`,
    protocolVersion: proof.protocolVersion,
  };
}
