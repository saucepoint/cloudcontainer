import type { IDKitRequestConfig } from "@worldcoin/idkit-core";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { signRequest } from "@worldcoin/idkit-core/signing";
import type { Bindings } from "./types.js";

const APP_ID_PATTERN = /^app_[a-z0-9]+$/;
const RP_ID_PATTERN = /^rp_[a-z0-9]+$/;
const ACTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SIGNING_KEY_PATTERN = /^(?:0x)?[0-9a-f]{64}$/i;
const NULLIFIER_PATTERN = /^0x[0-9a-f]{1,64}$/i;

interface WorldIdConfig {
  appId: `app_${string}`;
  rpId: `rp_${string}`;
  action: string;
  environment: "production" | "staging";
  signingKey: string;
}

type WorldIdRequest = IDKitRequestConfig & { signal: string };

export class WorldIdVerificationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502 | 503,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorldIdVerificationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function worldIdConfig(env: Bindings): WorldIdConfig | null {
  const signingKey = env.WORLD_ID_SIGNING_KEY;
  if (
    !APP_ID_PATTERN.test(env.WORLD_ID_APP_ID)
    || !RP_ID_PATTERN.test(env.WORLD_ID_RP_ID)
    || !ACTION_PATTERN.test(env.WORLD_ID_ACTION)
    || (env.WORLD_ID_ENVIRONMENT !== "production" && env.WORLD_ID_ENVIRONMENT !== "staging")
    || !signingKey
    || !SIGNING_KEY_PATTERN.test(signingKey)
  ) return null;

  return {
    appId: env.WORLD_ID_APP_ID as `app_${string}`,
    rpId: env.WORLD_ID_RP_ID as `rp_${string}`,
    action: env.WORLD_ID_ACTION,
    environment: env.WORLD_ID_ENVIRONMENT,
    signingKey,
  };
}

export function worldIdConfigured(env: Bindings): boolean {
  return worldIdConfig(env) !== null;
}

export function createWorldIdRequest(env: Bindings, signal: string): WorldIdRequest | null {
  const config = worldIdConfig(env);
  if (!config) return null;
  const signed = signRequest({
    signingKeyHex: config.signingKey,
    action: config.action,
  });
  return {
    app_id: config.appId,
    action: config.action,
    environment: config.environment,
    allow_legacy_proofs: false,
    signal,
    rp_context: {
      rp_id: config.rpId,
      nonce: signed.nonce,
      created_at: signed.createdAt,
      expires_at: signed.expiresAt,
      signature: signed.sig,
    },
  };
}

function rejectProof(message: string, code: string): never {
  throw new WorldIdVerificationError(message, 400, code);
}

function validateProof(rawProof: string, config: WorldIdConfig, signal: string): void {
  let proof: unknown;
  try {
    proof = JSON.parse(rawProof);
  } catch {
    rejectProof("World ID proof is invalid.", "malformed_proof");
  }
  if (!isRecord(proof)) rejectProof("World ID proof is invalid.", "malformed_proof");
  if (proof.protocol_version !== "4.0") {
    rejectProof("World ID proof has an unsupported version.", "invalid_version");
  }
  if (proof.action !== config.action) {
    rejectProof("World ID proof does not match this action.", "action_mismatch");
  }
  if ("environment" in proof && proof.environment !== config.environment) {
    rejectProof("World ID proof has the wrong environment.", "environment_mismatch");
  }
  if (!Array.isArray(proof.responses) || proof.responses.length === 0) {
    rejectProof("World ID proof has no credential response.", "missing_response");
  }

  const expectedSignal = hashSignal(signal).toLowerCase();
  const signalMatches = proof.responses.every((response) =>
    isRecord(response)
    && typeof response.signal_hash === "string"
    && response.signal_hash.toLowerCase() === expectedSignal
  );
  if (!signalMatches) {
    rejectProof("World ID proof does not match this account.", "signal_mismatch");
  }
}

function verifierResults(value: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(value?.results) ? value.results.filter(isRecord) : [];
}

function verifierCode(value: Record<string, unknown> | null, status: number): string {
  const result = verifierResults(value).find(({ code }) => typeof code === "string");
  const candidate = typeof value?.code === "string" ? value.code : result?.code;
  if (typeof candidate === "string" && /^[a-z0-9_]{1,64}$/.test(candidate)) return candidate;
  return status >= 400 && status <= 599
    ? `verifier_http_${status}`
    : "invalid_verifier_response";
}

function nullifierDecimal(value: unknown): string | null {
  return typeof value === "string" && NULLIFIER_PATTERN.test(value)
    ? BigInt(value).toString(10)
    : null;
}

function verifiedNullifier(value: Record<string, unknown>): string | null {
  for (const result of verifierResults(value)) {
    if (result.success !== true) continue;
    const nullifier = nullifierDecimal(result.nullifier);
    if (nullifier) return nullifier;
  }
  return nullifierDecimal(value.nullifier);
}

export async function verifyWorldIdProof(
  env: Bindings,
  signal: string,
  rawProof: string,
): Promise<string> {
  const config = worldIdConfig(env);
  if (!config) {
    throw new WorldIdVerificationError(
      "World ID verification is unavailable.",
      503,
      "not_configured",
    );
  }
  validateProof(rawProof, config, signal);

  let response: Response;
  try {
    response = await fetch(
      `https://developer.world.org/api/v4/verify/${config.rpId}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "usebench.dev/1.0",
        },
        body: rawProof,
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new WorldIdVerificationError(
      "World ID verification could not be reached. Try again.",
      502,
      "verifier_unavailable",
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  const verified = isRecord(payload) ? payload : null;
  if (!response.ok || verified?.success !== true) {
    const code = verifierCode(verified, response.status);
    console.warn(JSON.stringify({ event: "world_id_verifier_rejected", status: response.status, code }));
    const upstreamFailure = !verified || response.status >= 500;
    throw new WorldIdVerificationError(
      upstreamFailure
        ? "World ID verification is temporarily unavailable. Try again."
        : "World ID could not verify this proof.",
      upstreamFailure ? 502 : 400,
      code,
    );
  }

  const nullifier = verifiedNullifier(verified);
  if (!nullifier) {
    throw new WorldIdVerificationError(
      "World ID returned no uniqueness proof.",
      400,
      "missing_nullifier",
    );
  }
  return nullifier;
}
