/**
 * Sign in with World ID (IDKit v4 Session proofs).
 *
 * Design note vs. SPEC §2/§9: the spec originally called for a separate
 * incognito-action *verify* proof (v2 API) for signup uniqueness plus SIWO
 * (OIDC) for sessions. Both are superseded by World ID 4.0 Session proofs:
 * `session_id` is a stable, RP-scoped identifier that World App returns for
 * the same human on every `createSession`/`proveSession` call, so it already
 * bounds one human to one account (signup) and is repeatable (login) — one
 * mechanism does both jobs, same as the SIWO-sub shortcut this replaces.
 * `session_nullifier` is per-proof replay protection, not a stable identity,
 * and is not persisted beyond request-scoped logging.
 */
import type { IDKitResultSession } from "@worldcoin/idkit-core";
import { signRequest } from "@worldcoin/idkit-core/signing";
import type { Bindings } from "./types.js";

const VERIFY_URL = (rpId: string) => `https://developer.world.org/api/v4/verify/${rpId}`;
const SESSION_ID_PATTERN = /^session_[0-9a-f]{128}$/i;

export interface WorldIdRpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

/** Sign a fresh RP context for a session proof request. Session requests carry no action. */
export function signSessionRequest(env: Bindings): WorldIdRpContext {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: env.RP_SIGNING_KEY,
  });
  return {
    rp_id: env.WORLD_ID_RP_ID,
    nonce,
    created_at: createdAt,
    expires_at: expiresAt,
    signature: sig,
  };
}

export interface WorldIdSessionIdentity {
  sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSessionProof(
  value: unknown,
  environment: Bindings["WORLD_ID_ENVIRONMENT"],
): IDKitResultSession {
  if (!isRecord(value)) throw new Error("world id session proof must be an object");
  if (value.protocol_version !== "4.0") {
    throw new Error("world id session proof must use protocol version 4.0");
  }
  if (value.environment !== environment) {
    throw new Error(
      `world id environment mismatch: expected ${environment}, received ${String(value.environment)}`,
    );
  }
  if (!SESSION_ID_PATTERN.test(String(value.session_id))) {
    throw new Error("world id session proof has an invalid session_id");
  }
  if (typeof value.nonce !== "string" || !value.nonce) {
    throw new Error("world id session proof has an invalid nonce");
  }
  if (!Array.isArray(value.responses) || !value.responses.some((response) =>
    isRecord(response) && response.identifier === "proof_of_human" && response.issuer_schema_id === 1
  )) {
    throw new Error("world id session proof is missing the proof-of-human credential");
  }
  return value as unknown as IDKitResultSession;
}

/**
 * Forward an IDKit session-proof result to the Developer Portal for verification.
 * The payload is forwarded as returned by IDKit per the integration guide,
 * without field remapping or proof re-encoding.
 */
export async function verifySessionProof(
  env: Bindings,
  idkitResponse: unknown,
): Promise<WorldIdSessionIdentity> {
  const proof = parseSessionProof(idkitResponse, env.WORLD_ID_ENVIRONMENT);

  const res = await fetch(VERIFY_URL(env.WORLD_ID_RP_ID), {
    method: "POST",
    // World Developer Portal rejects requests without a User-Agent with an HTML 403.
    // Cloudflare Worker subrequests do not reliably supply one, so identify this call.
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "codestation-world-id/1.0",
    },
    body: JSON.stringify(proof),
  });
  const responseBody = await res.text();
  let verifierResponse: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (isRecord(parsed)) verifierResponse = parsed;
  } catch {
    // The status code below remains the primary failure signal. A successful
    // verifier response is JSON, so a non-JSON 2xx response is rejected below.
  }
  if (!res.ok) {
    // The verifier response contains an error code/detail, not the submitted
    // proof. Preserve it in Worker logs so RP/key/environment mistakes can be
    // distinguished without exposing proof material.
    throw new Error(`world id proof verification failed: ${res.status} ${responseBody.slice(0, 1_000)}`);
  }
  if (verifierResponse && "success" in verifierResponse && verifierResponse.success !== true) {
    throw new Error(`world id proof verification failed: verifier returned success=${String(verifierResponse.success)}`);
  }
  if (!verifierResponse) {
    throw new Error("world id proof verification failed: verifier returned invalid JSON");
  }
  const verifiedSessionId = verifierResponse.session_id;
  if (typeof verifiedSessionId !== "string" || !SESSION_ID_PATTERN.test(verifiedSessionId)) {
    throw new Error("world id verifier returned an invalid session_id");
  }
  if (verifiedSessionId !== proof.session_id) {
    throw new Error("world id verifier returned a different session_id");
  }
  if ("environment" in verifierResponse && verifierResponse.environment !== env.WORLD_ID_ENVIRONMENT) {
    throw new Error("world id verifier returned a different environment");
  }
  return { sessionId: verifiedSessionId };
}
