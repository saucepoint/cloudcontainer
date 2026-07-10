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
import { signRequest } from "@worldcoin/idkit-core/signing";
import type { Bindings } from "./types.js";

const VERIFY_URL = (rpId: string) => `https://developer.world.org/api/v4/verify/${rpId}`;

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
  sessionNullifier: string | null;
}

/**
 * Forward an IDKit session-proof result to the Developer Portal for verification.
 * The payload is passed through byte-for-byte per the integration guide — no
 * field remapping, no client-supplied re-encoding.
 */
export async function verifySessionProof(
  env: Bindings,
  idkitResponse: unknown,
): Promise<WorldIdSessionIdentity> {
  const proofEnvironment = (idkitResponse as { environment?: unknown } | null)?.environment;
  if (proofEnvironment !== env.WORLD_ID_ENVIRONMENT) {
    throw new Error(
      `world id environment mismatch: expected ${env.WORLD_ID_ENVIRONMENT}, received ${String(proofEnvironment)}`,
    );
  }

  const res = await fetch(VERIFY_URL(env.WORLD_ID_RP_ID), {
    method: "POST",
    // World Developer Portal rejects requests without a User-Agent with an HTML 403.
    // Cloudflare Worker subrequests do not reliably supply one, so identify this call.
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "codestation-world-id/1.0",
    },
    body: JSON.stringify(idkitResponse),
  });
  if (!res.ok) {
    // The verifier response contains an error code/detail, not the submitted
    // proof. Preserve it in Worker logs so RP/key/environment mistakes can be
    // distinguished without exposing proof material.
    const detail = (await res.text()).slice(0, 1_000);
    throw new Error(`world id proof verification failed: ${res.status} ${detail}`);
  }
  const json = idkitResponse as {
    session_id?: unknown;
    responses?: Array<{ session_nullifier?: unknown }>;
  };
  if (typeof json.session_id !== "string" || !json.session_id) {
    throw new Error("verified payload missing session_id");
  }
  const nullifier = json.responses?.[0]?.session_nullifier;
  const sessionNullifier =
    Array.isArray(nullifier) && typeof nullifier[0] === "string" ? nullifier[0] : null;
  return { sessionId: json.session_id, sessionNullifier };
}
