import {
  CredentialRequest,
  IDKit,
  any,
  proofOfHuman,
  type IDKitErrorCodes,
  type IDKitRequestConfig,
  type IDKitResultSession,
  type IDKitSessionConfig,
  type RpContext,
} from "@worldcoin/idkit-core";
import QRCode from "qrcode";

const SESSION_STORAGE_KEY = "cs_world_id_session";
const SESSION_ID_PATTERN = /^session_[0-9a-f]{128}$/i;
const ERROR_MESSAGES: Partial<Record<IDKitErrorCodes, string>> = {
  timeout: "Timed out waiting for World App.",
  cancelled: "Cancelled in World App.",
  user_rejected: "Cancelled in World App.",
  verification_rejected: "Cancelled in World App.",
  invalid_network: "World ID environment mismatch. This site must use production with the real World App.",
  invalid_rp_signature: "World ID rejected this site’s RP signing key.",
  unknown_rp: "World ID does not recognize this site’s RP ID.",
  inactive_rp: "This site’s World ID registration is not active yet.",
  world_id_4_not_available: "Your World App does not have a World ID 4.0 credential yet.",
  credential_unavailable: "This World ID is not Orb-verified and cannot prove personhood.",
  malformed_request: "World ID rejected this site’s request configuration.",
  connection_failed: "The connection to World App was lost. Please try again.",
  failed_by_host_app: "World App could not process this request. Please try again.",
  generic_error: "World App could not process this request. Please try again.",
  unexpected_response: "World App returned an unexpected response. Please try again.",
  duplicate_nonce: "This World ID request was already used. Please start again.",
  timestamp_too_old: "This World ID request expired. Please start again.",
  timestamp_too_far_in_future: "Your device time appears incorrect. Please correct it and try again.",
  invalid_timestamp: "Your device time appears incorrect. Please correct it and try again.",
};

type RpContextResponse = {
  app_id: `app_${string}`;
  action: string;
  rp_context: RpContext;
};

const button = document.querySelector<HTMLButtonElement>("#worldid-btn");
const status = document.querySelector<HTMLElement>("#worldid-status");
const qrContainer = document.querySelector<HTMLElement>("#worldid-qr");

function isSessionId(value: unknown): value is `session_${string}` {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function isSessionResult(value: unknown): value is IDKitResultSession {
  return typeof value === "object" && value !== null && isSessionId((value as { session_id?: unknown }).session_id);
}

function readSavedSessionId(): `session_${string}` | null {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!stored) return null;
    if (isSessionId(stored)) return stored;
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage may be disabled. A new World ID session can still be created.
  }
  return null;
}

async function fetchRpContext(mode: "proof" | "session"): Promise<RpContextResponse> {
  const response = await fetch(`/auth/session/rp-context?mode=${mode}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof (body as { error?: unknown } | null)?.error === "string"
      ? (body as { error: string }).error
      : "Could not start World ID sign-in.";
    throw new Error(message);
  }
  const context = body as Partial<RpContextResponse> | null;
  if (
    !context
    || typeof context.app_id !== "string"
    || !context.app_id.startsWith("app_")
    || typeof context.action !== "string"
    || !context.rp_context
  ) {
    throw new Error("World ID returned an invalid request context.");
  }
  return context as RpContextResponse;
}

async function reportFailure(code: IDKitErrorCodes, requestId: string): Promise<void> {
  try {
    await fetch("/auth/session/failure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, request_id: requestId }),
      keepalive: true,
    });
  } catch {
    // Diagnostics must never obscure the user-facing failure.
  }
}

async function renderConnection(connectorURI: string): Promise<void> {
  if (/Mobi|Android/i.test(navigator.userAgent)) {
    status!.textContent = "Opening World App…";
    window.location.assign(connectorURI);
    return;
  }

  status!.textContent = "Scan with World App";
  const canvas = document.createElement("canvas");
  qrContainer!.replaceChildren(canvas);
  await QRCode.toCanvas(canvas, connectorURI, { width: 220, margin: 1 });
}

async function startWorldIdSignIn(): Promise<void> {
  button!.disabled = true;
  status!.textContent = "Connecting to World ID…";
  qrContainer!.replaceChildren();

  try {
    const savedSessionId = readSavedSessionId();
    const mode = savedSessionId ? "session" : "proof";
    const { app_id, action, rp_context } = await fetchRpContext(mode);
    const baseConfig: IDKitSessionConfig = {
      app_id,
      rp_context,
      environment: button!.dataset.worldIdEnvironment === "staging" ? "staging" : "production",
    };
    const request = savedSessionId
      ? await IDKit.proveSession(savedSessionId, baseConfig)
        .constraints(any(CredentialRequest("proof_of_human")))
      : await IDKit.request({
          ...baseConfig,
          action,
          allow_legacy_proofs: true,
        } satisfies IDKitRequestConfig).preset(proofOfHuman());

    await renderConnection(request.connectorURI);
    const completion = await request.pollUntilCompletion({ timeout: 180_000 });
    if (!completion.success) {
      await reportFailure(completion.error, request.requestId);
      throw new Error(ERROR_MESSAGES[completion.error] ?? `World ID error: ${completion.error}`);
    }
    status!.textContent = "Verifying…";
    qrContainer!.replaceChildren();
    const response = await fetch("/auth/session/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idkitResponse: completion.result }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof (body as { error?: unknown } | null)?.error === "string"
        ? (body as { error: string }).error
        : "Sign-in failed.";
      throw new Error(message);
    }
    const redirect = (body as { redirect?: unknown } | null)?.redirect;
    if (typeof redirect !== "string" || !redirect.startsWith("/")) {
      throw new Error("Sign-in returned an invalid redirect.");
    }

    if (isSessionResult(completion.result)) {
      try {
        localStorage.setItem(SESSION_STORAGE_KEY, completion.result.session_id);
      } catch {
        // The authenticated cookie still works when storage is unavailable.
      }
    }
    window.location.assign(redirect);
  } catch (error) {
    status!.textContent = error instanceof Error ? error.message : "Something went wrong. Please try again.";
    button!.disabled = false;
  }
}

if (button && status && qrContainer) {
  button.addEventListener("click", () => void startWorldIdSignIn());
}
