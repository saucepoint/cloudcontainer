import { Tabs } from "@base-ui/react/tabs";
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
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import QRCode from "qrcode";
import * as React from "react";
import { createRoot } from "react-dom/client";

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
  inactive_rp: "This World ID registration is not active yet.",
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

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (error.name === "NotAllowedError") return "The passkey prompt was cancelled or timed out.";
  return error.message || fallback;
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
      : fallbackForStatus(response.status);
    throw new Error(message);
  }
  return json as T;
}

function fallbackForStatus(statusCode: number): string {
  return statusCode === 401 ? "Sign-in failed." : "Could not complete that request.";
}

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

function LandingAuth({ worldIdEnvironment }: { worldIdEnvironment: "production" | "staging" }): React.JSX.Element {
  const supportsWebAuthn = browserSupportsWebAuthn();
  const qrContainer = React.useRef<HTMLDivElement>(null);
  const inviteInput = React.useRef<HTMLInputElement>(null);
  const [passkeyStatus, setPasskeyStatus] = React.useState(
    supportsWebAuthn ? "" : "This browser does not support passkeys.",
  );
  const [passkeyPending, setPasskeyPending] = React.useState(false);
  const [worldIdStatus, setWorldIdStatus] = React.useState("");
  const [worldIdPending, setWorldIdPending] = React.useState(false);
  const [inviteCode, setInviteCode] = React.useState("");
  const [inviteStatus, setInviteStatus] = React.useState(
    supportsWebAuthn ? "" : "Use a passkey-capable browser to redeem an invite.",
  );
  const [invitePending, setInvitePending] = React.useState(false);

  const startPasskeySignIn = async (): Promise<void> => {
    if (!supportsWebAuthn) return;

    setPasskeyPending(true);
    setPasskeyStatus("Waiting for your passkey…");
    try {
      const optionsJSON = await postJson<PublicKeyCredentialRequestOptionsJSON>(
        "/auth/passkey/authenticate/options",
      );
      const response = await startAuthentication({ optionsJSON });
      setPasskeyStatus("Verifying…");
      const result = await postJson<{ redirect: string }>(
        "/auth/passkey/authenticate/verify",
        { response },
      );
      window.location.assign(result.redirect);
    } catch (error) {
      setPasskeyStatus(errorMessage(error, "Passkey sign-in failed. Please try again."));
      setPasskeyPending(false);
    }
  };

  const registerWithInvite = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!supportsWebAuthn) return;

    const code = inviteCode.trim().toUpperCase();
    setInviteCode(code);
    if (!/^[A-Z0-9]{8}$/.test(code)) {
      setInviteStatus("Enter the eight letters and numbers from your invite.");
      inviteInput.current?.focus();
      return;
    }

    setInvitePending(true);
    setInviteStatus("Preparing your required passkey…");
    try {
      const optionsJSON = await postJson<PublicKeyCredentialCreationOptionsJSON>(
        "/auth/invite/register/options",
        { code },
      );
      const response = await startRegistration({ optionsJSON });
      setInviteStatus("Creating your account…");
      const result = await postJson<{ redirect: string }>(
        "/auth/invite/register/verify",
        { response },
      );
      window.location.assign(result.redirect);
    } catch (error) {
      setInviteStatus(errorMessage(error, "Invite signup failed. Please try again."));
      setInvitePending(false);
    }
  };

  const renderConnection = async (connectorURI: string): Promise<void> => {
    if (/Mobi|Android/i.test(navigator.userAgent)) {
      setWorldIdStatus("Opening World App…");
      window.location.assign(connectorURI);
      return;
    }

    const container = qrContainer.current;
    if (!container) throw new Error("Could not show the World ID QR code.");

    setWorldIdStatus("Scan with World App");
    const canvas = document.createElement("canvas");
    container.replaceChildren(canvas);
    await QRCode.toCanvas(canvas, connectorURI, { width: 220, margin: 1 });
  };

  const startWorldIdSignIn = async (): Promise<void> => {
    setWorldIdPending(true);
    setWorldIdStatus("Connecting to World ID…");
    qrContainer.current?.replaceChildren();

    try {
      const savedSessionId = readSavedSessionId();
      const mode = savedSessionId ? "session" : "proof";
      const { app_id, action, rp_context } = await fetchRpContext(mode);
      const baseConfig: IDKitSessionConfig = {
        app_id,
        rp_context,
        environment: worldIdEnvironment === "staging" ? "staging" : "production",
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
      setWorldIdStatus("Verifying…");
      qrContainer.current?.replaceChildren();
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
      setWorldIdStatus(error instanceof Error ? error.message : "Something went wrong. Please try again.");
      setWorldIdPending(false);
    }
  };

  return (
    <Tabs.Root defaultValue="passkey" className="auth-tabs">
      <Tabs.List className="auth-tab-list" aria-label="Authentication options">
        <Tabs.Tab value="passkey" className="auth-tab">Passkey</Tabs.Tab>
        <Tabs.Tab value="world-id" className="auth-tab">World ID</Tabs.Tab>
        <Tabs.Tab value="invite" className="auth-tab">Invite Code</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="passkey" keepMounted className="auth-tab-panel">
        <section className="auth-option" aria-labelledby="passkey-heading">
          <div>
            <h3 id="passkey-heading" className="auth-option-title">Passkey</h3>
            <p className="muted">Quickest login for existing users.</p>
          </div>
          <button
            id="passkey-login-btn"
            className="btn"
            type="button"
            disabled={!supportsWebAuthn || passkeyPending}
            onClick={() => void startPasskeySignIn()}
          >
            Sign in with a passkey →
          </button>
          <p id="passkey-status" className="muted" role="status" aria-live="polite">{passkeyStatus}</p>
        </section>
      </Tabs.Panel>

      <Tabs.Panel value="world-id" keepMounted className="auth-tab-panel">
        <section className="auth-option" aria-labelledby="worldid-heading">
          <div>
            <h3 id="worldid-heading" className="auth-option-title">World ID</h3>
            <p className="muted">Sign in or create a free account by proving you are one person.</p>
          </div>
          <button
            id="worldid-btn"
            className="btn"
            type="button"
            disabled={worldIdPending}
            onClick={() => void startWorldIdSignIn()}
          >
            Continue with World ID →
          </button>
          <p id="worldid-status" className="muted" role="status" aria-live="polite">{worldIdStatus}</p>
          <div ref={qrContainer} id="worldid-qr" className="qr" role="status" aria-live="polite"></div>
        </section>
      </Tabs.Panel>

      <Tabs.Panel value="invite" keepMounted className="auth-tab-panel">
        <form id="invite-form" className="auth-option" onSubmit={(event) => void registerWithInvite(event)}>
          <div>
            <h3 className="auth-option-title">Invite Code</h3>
            <p className="muted">
              Create an account with a one-time invite code
            </p>
          </div>
          <div className="auth-code-row">
            <input
              ref={inviteInput}
              id="invite-code"
              name="code"
              type="text"
              inputMode="text"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              minLength={8}
              maxLength={8}
              pattern="[A-Za-z0-9]{8}"
              required
              disabled={!supportsWebAuthn || invitePending}
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())}
            />
            <button id="invite-btn" className="btn" type="submit" disabled={!supportsWebAuthn || invitePending}>
              Use invite →
            </button>
          </div>
          <p id="invite-status" className="muted" role="status" aria-live="polite">{inviteStatus}</p>
        </form>
      </Tabs.Panel>
    </Tabs.Root>
  );
}

const root = document.getElementById("landing-auth-root");
if (root) {
  const worldIdEnvironment = root.dataset.worldIdEnvironment === "staging" ? "staging" : "production";
  createRoot(root).render(<LandingAuth worldIdEnvironment={worldIdEnvironment} />);
}
