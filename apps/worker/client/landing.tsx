import { Tabs } from "@base-ui/react/tabs";
import {
  CredentialRequest,
  IDKitSessionWidget,
  type IDKitDebugReport,
  type IDKitErrorCodes,
  type IDKitResultSession,
  type RpContext,
} from "@worldcoin/idkit";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { createRoot } from "react-dom/client";

const SESSION_STORAGE_KEY = "cs_world_id_session";
const SESSION_ID_PATTERN = /^session_[0-9a-f]{128}$/i;
const PROOF_OF_HUMAN = CredentialRequest("proof_of_human");
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
  nullifier_replayed: "This World ID response was already used. Please start again.",
  rp_signature_expired: "The World ID request expired. Please start again.",
  unexpected_response: "World App returned an unexpected response. Please try again.",
  duplicate_nonce: "This World ID request was already used. Please start again.",
  timestamp_too_old: "This World ID request expired. Please start again.",
  timestamp_too_far_in_future: "Your device time appears incorrect. Please correct it and try again.",
  invalid_timestamp: "Your device time appears incorrect. Please correct it and try again.",
};

type WorldIdContext = {
  app_id: `app_${string}`;
  environment: "production" | "staging";
  rp_context: RpContext;
};

type AuthTab = "passkey" | "world-id" | "invite";

function isAuthTab(value: string | number): value is AuthTab {
  return value === "passkey" || value === "world-id" || value === "invite";
}

function AnimatedAuthOption({
  active,
  value,
  labelledBy,
  reducedMotion,
  children,
}: {
  active: boolean;
  value: AuthTab;
  labelledBy: string;
  reducedMotion: boolean | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <AnimatePresence initial={false} mode="wait">
      {active ? (
        <motion.section
          key={value}
          className="auth-option"
          aria-labelledby={labelledBy}
          initial={reducedMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          {...(reducedMotion ? {} : { exit: { opacity: 0, y: -8 } })}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }}
        >
          {children}
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

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

async function fetchWorldIdContext(): Promise<WorldIdContext> {
  const response = await fetch("/auth/world-id/context", {
    method: "POST",
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
  const context = body as Partial<WorldIdContext> | null;
  if (
    !context
    || typeof context.app_id !== "string"
    || !context.app_id.startsWith("app_")
    || (context.environment !== "production" && context.environment !== "staging")
    || !context.rp_context
  ) {
    throw new Error("World ID returned an invalid request context.");
  }
  return context as WorldIdContext;
}

async function reportWorldIdFailure(
  code: IDKitErrorCodes,
  report?: IDKitDebugReport,
): Promise<void> {
  try {
    await fetch("/auth/world-id/failure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        request_id: report?.request_id,
        transport: report?.transport,
        mini_app: report?.mini_app,
      }),
      keepalive: true,
    });
  } catch {
    // Diagnostics must never obscure the user-facing failure.
  }
}

function LandingAuth(): React.JSX.Element {
  const supportsWebAuthn = browserSupportsWebAuthn();
  const reducedMotion = useReducedMotion();
  const [activeTab, setActiveTab] = React.useState<AuthTab>("passkey");
  const inviteInput = React.useRef<HTMLInputElement>(null);
  const worldIdRedirect = React.useRef<string | null>(null);
  const worldIdHostError = React.useRef<string | null>(null);
  const [passkeyStatus, setPasskeyStatus] = React.useState(
    supportsWebAuthn ? "" : "This browser does not support passkeys.",
  );
  const [passkeyPending, setPasskeyPending] = React.useState(false);
  const [worldIdStatus, setWorldIdStatus] = React.useState("");
  const [worldIdPending, setWorldIdPending] = React.useState(false);
  const [worldIdOpen, setWorldIdOpen] = React.useState(false);
  const [worldIdContext, setWorldIdContext] = React.useState<WorldIdContext | null>(null);
  const [worldIdSessionId, setWorldIdSessionId] = React.useState<`session_${string}` | null>(null);
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

  const startWorldIdSignIn = async (): Promise<void> => {
    setWorldIdPending(true);
    setWorldIdStatus("Preparing World ID…");
    worldIdRedirect.current = null;
    worldIdHostError.current = null;
    try {
      setWorldIdSessionId(readSavedSessionId());
      setWorldIdContext(await fetchWorldIdContext());
      setWorldIdStatus("");
      setWorldIdOpen(true);
    } catch (error) {
      setWorldIdStatus(error instanceof Error ? error.message : "Something went wrong. Please try again.");
      setWorldIdPending(false);
    }
  };

  const verifyWorldId = async (result: IDKitResultSession): Promise<void> => {
    setWorldIdStatus("Verifying…");
    try {
      const response = await postJson<{ redirect: unknown }>(
        "/auth/world-id/verify",
        { idkitResponse: result },
      );
      if (typeof response.redirect !== "string" || !response.redirect.startsWith("/")) {
        throw new Error("Sign-in returned an invalid redirect.");
      }
      worldIdRedirect.current = response.redirect;
    } catch (error) {
      worldIdHostError.current = errorMessage(error, "Sign-in failed.");
      setWorldIdStatus(worldIdHostError.current);
      throw error;
    }
  };

  const finishWorldIdSignIn = (result: IDKitResultSession): void => {
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, result.session_id);
    } catch {
      // The authenticated cookie still works when storage is unavailable.
    }
    const redirect = worldIdRedirect.current;
    if (!redirect) {
      setWorldIdStatus("Sign-in returned an invalid redirect.");
      setWorldIdPending(false);
      return;
    }
    window.location.assign(redirect);
  };

  return (
    <Tabs.Root
      defaultValue="passkey"
      className="auth-tabs"
      onValueChange={(value) => {
        if (isAuthTab(value)) setActiveTab(value);
      }}
    >
      <Tabs.List className="auth-tab-list" aria-label="Authentication options">
        <Tabs.Tab value="passkey" className="auth-tab">
          <span className="auth-tab-label">Passkey</span>
          {activeTab === "passkey" ? <motion.span aria-hidden className="auth-tab-indicator" layoutId="auth-tab-indicator" transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }} /> : null}
        </Tabs.Tab>
        <Tabs.Tab value="world-id" className="auth-tab">
          <span className="auth-tab-label">World ID</span>
          {activeTab === "world-id" ? <motion.span aria-hidden className="auth-tab-indicator" layoutId="auth-tab-indicator" transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }} /> : null}
        </Tabs.Tab>
        <Tabs.Tab value="invite" className="auth-tab">
          <span className="auth-tab-label">Invite Code</span>
          {activeTab === "invite" ? <motion.span aria-hidden className="auth-tab-indicator" layoutId="auth-tab-indicator" transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }} /> : null}
        </Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="passkey" keepMounted className="auth-tab-panel">
        <AnimatedAuthOption active={activeTab === "passkey"} value="passkey" labelledBy="passkey-heading" reducedMotion={reducedMotion}>
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
        </AnimatedAuthOption>
      </Tabs.Panel>

      <Tabs.Panel value="world-id" keepMounted className="auth-tab-panel">
        <AnimatedAuthOption active={activeTab === "world-id"} value="world-id" labelledBy="worldid-heading" reducedMotion={reducedMotion}>
          <div>
            <h3 id="worldid-heading" className="auth-option-title">World ID</h3>
            <p className="muted">Sign in or create a free account by proving you are one person.</p>
          </div>
          <button
            id="worldid-btn"
            className="btn"
            type="button"
            disabled={worldIdPending || worldIdOpen}
            onClick={() => void startWorldIdSignIn()}
          >
            Continue with World ID →
          </button>
          <p id="worldid-status" className="muted" role="status" aria-live="polite">{worldIdStatus}</p>
        </AnimatedAuthOption>
      </Tabs.Panel>

      <Tabs.Panel value="invite" keepMounted className="auth-tab-panel">
        <AnimatedAuthOption active={activeTab === "invite"} value="invite" labelledBy="invite-heading" reducedMotion={reducedMotion}>
          <form id="invite-form" className="auth-option-form" onSubmit={(event) => void registerWithInvite(event)}>
            <div>
              <h3 id="invite-heading" className="auth-option-title">Invite Code</h3>
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
        </AnimatedAuthOption>
      </Tabs.Panel>
      {worldIdContext ? (
        <IDKitSessionWidget
          open={worldIdOpen}
          onOpenChange={(open) => {
            setWorldIdOpen(open);
            if (!open) setWorldIdPending(false);
          }}
          app_id={worldIdContext.app_id}
          rp_context={worldIdContext.rp_context}
          environment={worldIdContext.environment}
          {...(worldIdSessionId ? { existing_session_id: worldIdSessionId } : {})}
          constraints={PROOF_OF_HUMAN}
          polling={{ timeout: 180_000 }}
          handleVerify={verifyWorldId}
          onSuccess={finishWorldIdSignIn}
          onError={async (code, report) => {
            await reportWorldIdFailure(code, report);
            setWorldIdStatus(
              code === "failed_by_host_app" && worldIdHostError.current
                ? worldIdHostError.current
                : ERROR_MESSAGES[code] ?? `World ID error: ${code}`,
            );
            setWorldIdPending(false);
          }}
        />
      ) : null}
    </Tabs.Root>
  );
}

const root = document.getElementById("landing-auth-root");
if (root) {
  createRoot(root).render(<LandingAuth />);
}
