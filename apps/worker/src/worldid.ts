import { signRequest } from "@worldcoin/idkit/signing";
import type { Bindings } from "./types.js";

const SESSION_ID_PATTERN = /^session_[0-9a-f]{128}$/i;

function verifyUrl(rpId: string): string {
  return `https://developer.world.org/api/v4/verify/${rpId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class WorldIdVerificationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502,
  ) {
    super(message);
    this.name = "WorldIdVerificationError";
  }
}

export function createWorldIdContext(env: Bindings) {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: env.RP_SIGNING_KEY,
  });
  return {
    app_id: env.WORLD_ID_APP_ID,
    environment: env.WORLD_ID_ENVIRONMENT,
    rp_context: {
      rp_id: env.WORLD_ID_RP_ID,
      nonce,
      created_at: createdAt,
      expires_at: expiresAt,
      signature: sig,
    },
  };
}

function parseSessionProof(
  env: Bindings,
  value: unknown,
): { payload: Record<string, unknown>; sessionId: string } {
  if (!isRecord(value)) {
    throw new WorldIdVerificationError("World ID response must be an object", 400);
  }
  if (value.protocol_version !== "4.0") {
    throw new WorldIdVerificationError("World ID response is not protocol version 4.0", 400);
  }
  if (value.environment !== env.WORLD_ID_ENVIRONMENT) {
    throw new WorldIdVerificationError("World ID response has the wrong environment", 400);
  }
  if (typeof value.nonce !== "string" || value.nonce.length === 0) {
    throw new WorldIdVerificationError("World ID response has an invalid nonce", 400);
  }
  const sessionId = value.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new WorldIdVerificationError("World ID response is not a session proof", 400);
  }
  if (!Array.isArray(value.responses) || value.responses.length === 0) {
    throw new WorldIdVerificationError("World ID response has no credentials", 400);
  }
  const proofOfHuman = value.responses.find((response) =>
    isRecord(response)
    && response.identifier === "proof_of_human"
    && response.issuer_schema_id === 1
    && Array.isArray(response.proof)
    && response.proof.length === 5
    && response.proof.every((part) => typeof part === "string" && part.length > 0)
    && Array.isArray(response.session_nullifier)
    && response.session_nullifier.length === 2
    && response.session_nullifier.every((part) => typeof part === "string" && part.length > 0)
  );
  if (!proofOfHuman) {
    throw new WorldIdVerificationError(
      "World ID session is missing the Proof of Human credential",
      400,
    );
  }
  return { payload: value, sessionId };
}

function verifierCode(value: Record<string, unknown> | null): string {
  return typeof value?.code === "string" && /^[a-z0-9_]{1,64}$/.test(value.code)
    ? ` (${value.code})`
    : "";
}

/** Verify an unmodified IDKit v4 session result and return its durable identity. */
export async function verifyWorldIdSession(
  env: Bindings,
  idkitResponse: unknown,
): Promise<string> {
  const proof = parseSessionProof(env, idkitResponse);
  let response: Response;
  try {
    response = await fetch(verifyUrl(env.WORLD_ID_RP_ID), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "codestation-world-id/2.0",
      },
      body: JSON.stringify(proof.payload),
    });
  } catch {
    throw new WorldIdVerificationError("World ID verifier is unavailable", 502);
  }

  const responseBody = await response.text();
  let verified: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(responseBody);
    if (isRecord(parsed)) verified = parsed;
  } catch {
    // Rejected below. Successful verifier responses are JSON objects.
  }
  if (!response.ok) {
    throw new WorldIdVerificationError(
      `World ID verifier rejected the proof${verifierCode(verified)}`,
      response.status >= 500 ? 502 : 400,
    );
  }
  if (!verified) {
    throw new WorldIdVerificationError("World ID verifier returned invalid JSON", 502);
  }
  if (verified.success !== true) {
    throw new WorldIdVerificationError("World ID verifier rejected the proof", 400);
  }
  if (verified.session_id !== proof.sessionId) {
    throw new WorldIdVerificationError("World ID verifier returned a different session", 400);
  }
  if (
    "environment" in verified
    && verified.environment !== env.WORLD_ID_ENVIRONMENT
  ) {
    throw new WorldIdVerificationError("World ID verifier returned a different environment", 400);
  }
  if (
    !Array.isArray(verified.results)
    || !verified.results.some((result) =>
      isRecord(result)
      && result.identifier === "proof_of_human"
      && result.success === true
    )
  ) {
    throw new WorldIdVerificationError("World ID verifier did not verify Proof of Human", 400);
  }
  return proof.sessionId;
}
