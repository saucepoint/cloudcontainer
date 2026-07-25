import * as React from "react";
import { createRoot } from "react-dom/client";
import { authClient } from "./auth-client.js";
import { requestJson } from "./http.js";

type SocialProvider = "google" | "apple" | "github";

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function LandingAuth(): React.JSX.Element {
  const [pending, setPending] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState("");

  const socialSignIn = async (provider: SocialProvider): Promise<void> => {
    setPending(provider);
    setStatus("Opening sign-in…");
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: "/account/continue",
      });
      if (result.error) throw new Error(result.error.message);
    } catch (error) {
      setStatus(message(error, "Sign-in could not be started."));
      setPending(null);
    }
  };

  const createPasskey = async (): Promise<void> => {
    setPending("create-passkey");
    setStatus("Preparing a new passkey…");
    try {
      const { context } = await requestJson<{ context: string }>("/account/passkey/context");
      const result = await authClient.passkey.addPasskey({ name: "Primary passkey", context });
      if (result.error) throw new Error(result.error.message);
      window.location.assign("/account/continue");
    } catch (error) {
      setStatus(message(error, "The passkey could not be created."));
      setPending(null);
    }
  };

  const usePasskey = async (): Promise<void> => {
    setPending("use-passkey");
    setStatus("Waiting for your passkey…");
    try {
      const result = await authClient.signIn.passkey({ autoFill: false });
      if (result.error) throw new Error(result.error.message);
      window.location.assign("/account/continue");
    } catch (error) {
      setStatus(message(error, "Passkey sign-in failed."));
      setPending(null);
    }
  };

  return (
    <div className="auth-provider-list">
      <button className="btn auth-provider" type="button" disabled={pending !== null} onClick={() => void socialSignIn("google")}>Sign in with Google</button>
      <button className="btn auth-provider" type="button" disabled={pending !== null} onClick={() => void socialSignIn("apple")}>Sign in with Apple</button>
      <button className="btn auth-provider" type="button" disabled={pending !== null} onClick={() => void socialSignIn("github")}>Sign in with GitHub</button>
      <div className="auth-divider"><span>or use a passkey</span></div>
      <button className="btn secondary auth-provider" type="button" disabled={pending !== null} onClick={() => void createPasskey()}>Create passkey</button>
      <button className="btn secondary auth-provider" type="button" disabled={pending !== null} onClick={() => void usePasskey()}>Use passkey</button>
      <p className="muted auth-status" role="status" aria-live="polite">{status}</p>
    </div>
  );
}

const root = document.getElementById("landing-auth-root");
if (root) createRoot(root).render(<LandingAuth />);
