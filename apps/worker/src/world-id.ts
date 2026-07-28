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

interface WorldIdVerifyResponse {
  success?: unknown;
  nullifier?: unknown;
  code?: unknown;
  results?: Array<{
    success?: unknown;
    nullifier?: unknown;
    code?: unknown;
  }>;
}

export interface WorldIdRequest {
  app_id: `app_${string}`;
  action: string;
  environment: "production" | "staging";
  signal: string;
  rp_context: {
    rp_id: `rp_${string}`;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  };
}

export class WorldIdVerificationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorldIdVerificationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function worldIdConfig(env: Bindings): WorldIdConfig {
  if (!APP_ID_PATTERN.test(env.WORLD_ID_APP_ID)) throw new Error("invalid app id");
  if (!RP_ID_PATTERN.test(env.WORLD_ID_RP_ID)) throw new Error("invalid RP id");
  if (!ACTION_PATTERN.test(env.WORLD_ID_ACTION)) throw new Error("invalid action");
  if (env.WORLD_ID_ENVIRONMENT !== "production" && env.WORLD_ID_ENVIRONMENT !== "staging") {
    throw new Error("invalid environment");
  }
  if (!env.WORLD_ID_SIGNING_KEY || !SIGNING_KEY_PATTERN.test(env.WORLD_ID_SIGNING_KEY)) {
    throw new Error("invalid signing key");
  }
  return {
    appId: env.WORLD_ID_APP_ID as `app_${string}`,
    rpId: env.WORLD_ID_RP_ID as `rp_${string}`,
    action: env.WORLD_ID_ACTION,
    environment: env.WORLD_ID_ENVIRONMENT,
    signingKey: env.WORLD_ID_SIGNING_KEY,
  };
}

export function worldIdConfigured(env: Bindings): boolean {
  try {
    worldIdConfig(env);
    return true;
  } catch {
    return false;
  }
}

export function createWorldIdRequest(env: Bindings, signal: string): WorldIdRequest {
  const config = worldIdConfig(env);
  const signed = signRequest({
    signingKeyHex: config.signingKey,
    action: config.action,
  });
  return {
    app_id: config.appId,
    action: config.action,
    environment: config.environment,
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

function parseProof(rawProof: string, config: WorldIdConfig, signal: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawProof);
  } catch {
    throw new WorldIdVerificationError("World ID proof is invalid.", 400, "malformed_proof");
  }
  if (!isRecord(parsed)) {
    throw new WorldIdVerificationError("World ID proof is invalid.", 400, "malformed_proof");
  }
  if (parsed.protocol_version !== "3.0" && parsed.protocol_version !== "4.0") {
    throw new WorldIdVerificationError("World ID proof has an unsupported version.", 400, "invalid_version");
  }
  if (parsed.action !== config.action) {
    throw new WorldIdVerificationError("World ID proof does not match this action.", 400, "action_mismatch");
  }
  if ("environment" in parsed && parsed.environment !== config.environment) {
    throw new WorldIdVerificationError("World ID proof has the wrong environment.", 400, "environment_mismatch");
  }
  if (!Array.isArray(parsed.responses) || parsed.responses.length === 0) {
    throw new WorldIdVerificationError("World ID proof has no credential response.", 400, "missing_response");
  }
  const expectedSignal = hashSignal(signal).toLowerCase();
  if (!parsed.responses.every((response) =>
    isRecord(response)
    && typeof response.signal_hash === "string"
    && response.signal_hash.toLowerCase() === expectedSignal
  )) {
    throw new WorldIdVerificationError("World ID proof does not match this account.", 400, "signal_mismatch");
  }
  return parsed;
}

function verifierCode(value: WorldIdVerifyResponse | null, status: number): string {
  const candidate = typeof value?.code === "string"
    ? value.code
    : value?.results?.find((result) => typeof result.code === "string")?.code;
  if (typeof candidate === "string" && /^[a-z0-9_]{1,64}$/.test(candidate)) return candidate;
  return status >= 400 && status <= 599
    ? `verifier_http_${status}`
    : "invalid_verifier_response";
}

function nullifierDecimal(value: string): string | null {
  if (!NULLIFIER_PATTERN.test(value)) return null;
  try {
    return BigInt(value).toString(10);
  } catch {
    return null;
  }
}

export async function verifyWorldIdProof(
  env: Bindings,
  signal: string,
  rawProof: string,
): Promise<string> {
  const config = worldIdConfig(env);
  parseProof(rawProof, config, signal);

  let response: Response;
  try {
    response = await fetch(
      `https://developer.world.org/api/v4/verify/${encodeURIComponent(config.rpId)}`,
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

  const verified = await response.json().catch(() => null) as WorldIdVerifyResponse | null;
  if (
    !response.ok
    || verified?.success !== true
  ) {
    const code = verifierCode(verified, response.status);
    console.warn(JSON.stringify({ event: "world_id_verifier_rejected", status: response.status, code }));
    throw new WorldIdVerificationError("World ID could not verify this proof.", 400, code);
  }

  const resultNullifier = verified.results
    ?.filter((result) => result.success === true && typeof result.nullifier === "string")
    .map((result) => nullifierDecimal(result.nullifier as string))
    .find((value): value is string => value !== null);
  const nullifier = resultNullifier ?? (
    typeof verified.nullifier === "string" ? nullifierDecimal(verified.nullifier) : null
  );
  if (!nullifier) {
    throw new WorldIdVerificationError(
      "World ID returned no uniqueness proof.",
      400,
      "missing_nullifier",
    );
  }
  return nullifier;
}
