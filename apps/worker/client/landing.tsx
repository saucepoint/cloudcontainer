import { Tabs } from "@base-ui/react/tabs";
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
import { postJson } from "./http.js";
import { webAuthnErrorMessage } from "./webauthn-errors.js";

type AuthTab = "passkey" | "invite";

const authRequestFallback = (status: number): string =>
  status === 401 ? "Sign-in failed." : "Could not complete that request.";

function isAuthTab(value: string | number): value is AuthTab {
  return value === "passkey" || value === "invite";
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


function LandingAuth(): React.JSX.Element {
  const supportsWebAuthn = browserSupportsWebAuthn();
  const reducedMotion = useReducedMotion();
  const [activeTab, setActiveTab] = React.useState<AuthTab>("passkey");
  const inviteInput = React.useRef<HTMLInputElement>(null);
  const [passkeyStatus, setPasskeyStatus] = React.useState(
    supportsWebAuthn ? "" : "This browser does not support passkeys.",
  );
  const [passkeyPending, setPasskeyPending] = React.useState(false);
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
        undefined,
        authRequestFallback,
      );
      const response = await startAuthentication({ optionsJSON });
      setPasskeyStatus("Verifying…");
      const result = await postJson<{ redirect: string }>(
        "/auth/passkey/authenticate/verify",
        { response },
        authRequestFallback,
      );
      window.location.assign(result.redirect);
    } catch (error) {
      setPasskeyStatus(webAuthnErrorMessage(error, "Passkey sign-in failed. Please try again."));
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
        authRequestFallback,
      );
      const response = await startRegistration({ optionsJSON });
      setInviteStatus("Creating your account…");
      const result = await postJson<{ redirect: string }>(
        "/auth/invite/register/verify",
        { response },
        authRequestFallback,
      );
      window.location.assign(result.redirect);
    } catch (error) {
      setInviteStatus(webAuthnErrorMessage(error, "Invite signup failed. Please try again."));
      setInvitePending(false);
    }
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

      <Tabs.Panel value="invite" keepMounted className="auth-tab-panel">
        <AnimatedAuthOption active={activeTab === "invite"} value="invite" labelledBy="invite-heading" reducedMotion={reducedMotion}>
          <form id="invite-form" className="auth-option-form" onSubmit={(event) => void registerWithInvite(event)}>
            <div>
              <h3 id="invite-heading" className="auth-option-title">Invite Code</h3>
              <p className="muted">Create an account with a one-time invite code</p>
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
    </Tabs.Root>
  );
}

const root = document.getElementById("landing-auth-root");
if (root) {
  createRoot(root).render(<LandingAuth />);
}
