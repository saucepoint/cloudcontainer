import {
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import {
  CredentialRequest,
  IDKit,
  any,
  isInWorldApp,
  type IDKitErrorCodes,
  type IDKitRequest,
  type IDKitSessionConfig,
  type RpContext,
} from "@worldcoin/idkit-core";
import QRCode from "qrcode";

const button = document.querySelector<HTMLButtonElement>("#add-passkey-btn");
const status = document.querySelector<HTMLElement>("#passkey-setup-status");
const count = document.querySelector<HTMLElement>("#passkey-count");
const continueLink = document.querySelector<HTMLAnchorElement>("#security-continue");
const worldIdSection = document.querySelector<HTMLElement>("#world-id-session-migration");
const worldIdButton = document.querySelector<HTMLButtonElement>("#upgrade-world-id-btn");
const worldIdStatus = document.querySelector<HTMLElement>("#world-id-upgrade-status");
const worldIdQr = document.querySelector<HTMLElement>("#world-id-upgrade-qr");

const WORLD_ID_SESSION_STORAGE_KEY = "cs_world_id_session";
const WORLD_ID_SESSION_PATTERN = /^session_[0-9a-f]{128}$/i;

type RpContextResponse = {
  app_id: `app_${string}`;
  rp_context: RpContext;
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The passkey could not be added.";
  if (error.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
  return error.message || "The passkey could not be added.";
}

async function postJson<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof (json as { error?: unknown } | null)?.error === "string"
      ? (json as { error: string }).error
      : "The passkey could not be added.";
    throw new Error(message);
  }
  return json as T;
}

async function fetchWorldIdSessionContext(): Promise<RpContextResponse> {
  const response = await fetch("/auth/session/rp-context?mode=session", {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof (body as { error?: unknown } | null)?.error === "string"
      ? (body as { error: string }).error
      : "Could not start the World ID update.";
    throw new Error(message);
  }
  const context = body as Partial<RpContextResponse> | null;
  if (!context || typeof context.app_id !== "string" || !context.rp_context) {
    throw new Error("World ID returned an invalid request context.");
  }
  return context as RpContextResponse;
}

function worldIdErrorMessage(code: IDKitErrorCodes): string {
  if (code === "world_id_4_not_available") {
    return "Your World App needs a World ID 4 credential before this account can be updated.";
  }
  if (code === "credential_unavailable") {
    return "This World ID cannot create a proof-of-human session.";
  }
  if (code === "user_rejected" || code === "verification_rejected") return "Cancelled in World App.";
  if (code === "timeout") return "Timed out waiting for World App.";
  return "World App could not complete the update. Please try again.";
}

function worldIdUpgradeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "World ID sign-in could not be updated.";
}

async function reportWorldIdFailure(code: IDKitErrorCodes, request: IDKitRequest): Promise<void> {
  const report = request.getDebugReport();
  try {
    await fetch("/auth/session/failure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        request_id: request.requestId,
        transport: report.transport,
        mini_app: report.mini_app,
      }),
      keepalive: true,
    });
  } catch {
    // Diagnostics must never obscure the user-facing failure.
  }
}

async function renderWorldIdConnection(connectorURI: string): Promise<void> {
  // A World App webview receives the request through IDKit's native bridge.
  // It may not have a connector URL at all; navigating away loses the bridge
  // response and makes the World App appear to fail generically.
  if (isInWorldApp()) {
    worldIdStatus!.textContent = "Confirm the update in World App…";
    return;
  }
  if (/Mobi|Android/i.test(navigator.userAgent)) {
    if (!connectorURI) throw new Error("Could not open World App. Please try again.");
    worldIdStatus!.textContent = "Opening World App…";
    window.location.assign(connectorURI);
    return;
  }
  if (!connectorURI) throw new Error("Could not start the World ID update. Please try again.");
  const canvas = document.createElement("canvas");
  worldIdQr!.replaceChildren(canvas);
  worldIdStatus!.textContent = "Scan with World App";
  await QRCode.toCanvas(canvas, connectorURI, { width: 220, margin: 1 });
}

async function addPasskey(): Promise<void> {
  button!.disabled = true;
  status!.textContent = "Waiting for your device…";
  try {
    const optionsJSON = await postJson<PublicKeyCredentialCreationOptionsJSON>(
      "/auth/passkey/register/options",
    );
    const response = await startRegistration({ optionsJSON });
    status!.textContent = "Verifying…";
    const result = await postJson<{ verified: true; passkeyCount: number }>(
      "/auth/passkey/register/verify",
      { response },
    );
    count!.textContent = `${result.passkeyCount} ${result.passkeyCount === 1 ? "passkey" : "passkeys"}`;
    button!.textContent = "Add another passkey →";
    if (continueLink) continueLink.textContent = "Continue →";
    status!.textContent = "Passkey added. You can now use it from the sign-in page.";
  } catch (error) {
    status!.textContent = errorMessage(error);
  } finally {
    button!.disabled = false;
  }
}

if (button && status && count) {
  if (browserSupportsWebAuthn()) {
    button.addEventListener("click", () => void addPasskey());
  } else {
    button.disabled = true;
    status.textContent = "This browser does not support passkeys.";
  }
}

async function upgradeWorldId(): Promise<void> {
  worldIdButton!.disabled = true;
  worldIdStatus!.textContent = "Connecting to World ID…";
  worldIdQr!.replaceChildren();
  try {
    const { app_id, rp_context } = await fetchWorldIdSessionContext();
    const environment = worldIdSection!.dataset.worldIdEnvironment === "staging" ? "staging" : "production";
    const config: IDKitSessionConfig = { app_id, rp_context, environment };
    const request = await IDKit.createSession(config)
      .constraints(any(CredentialRequest("proof_of_human")));
    await renderWorldIdConnection(request.connectorURI);
    const completion = await request.pollUntilCompletion({ timeout: 180_000 });
    if (!completion.success) {
      await reportWorldIdFailure(completion.error, request);
      throw new Error(worldIdErrorMessage(completion.error));
    }

    if (
      !("session_id" in completion.result)
      || !WORLD_ID_SESSION_PATTERN.test(completion.result.session_id)
    ) {
      throw new Error("World ID returned an invalid session.");
    }
    worldIdStatus!.textContent = "Updating sign-in…";
    worldIdQr!.replaceChildren();
    await postJson<{ migrated: true }>("/auth/session/migrate", {
      idkitResponse: completion.result,
    });
    try {
      localStorage.setItem(WORLD_ID_SESSION_STORAGE_KEY, completion.result.session_id);
    } catch {
      // The server identity is migrated even when browser storage is disabled.
    }
    worldIdStatus!.textContent = "World ID sign-in updated.";
  } catch (error) {
    worldIdStatus!.textContent = worldIdUpgradeErrorMessage(error);
  } finally {
    worldIdButton!.disabled = false;
  }
}

if (worldIdSection && worldIdButton && worldIdStatus && worldIdQr) {
  try {
    if (!WORLD_ID_SESSION_PATTERN.test(localStorage.getItem(WORLD_ID_SESSION_STORAGE_KEY) ?? "")) {
      localStorage.removeItem(WORLD_ID_SESSION_STORAGE_KEY);
    }
  } catch {
    // A session can still be updated when browser storage is disabled.
  }
  worldIdButton.addEventListener("click", () => void upgradeWorldId());
}
