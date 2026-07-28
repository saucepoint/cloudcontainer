import { EnterIcon, GitHubLogoIcon, LockClosedIcon } from "@radix-ui/react-icons";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { authClient } from "./auth-client.js";
import { errorMessage, requestJson } from "./http.js";
import { GoogleIcon } from "./icons.js";

type SocialProvider = "google" | "github";

function LandingAuth(): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [status, setStatus] = React.useState("");

  const socialSignIn = async (provider: SocialProvider): Promise<void> => {
    setPending(true);
    setStatus("Opening sign-in…");
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: "/account/continue",
      });
      if (result.error) throw new Error(result.error.message);
    } catch (error) {
      setStatus(errorMessage(error, "Sign-in could not be started."));
      setPending(false);
    }
  };

  const createPasskey = async (): Promise<void> => {
    setPending(true);
    setStatus("Preparing a new passkey…");
    try {
      const { context } = await requestJson<{ context: string }>("/account/passkey/context");
      const result = await authClient.passkey.addPasskey({ name: "Primary passkey", context });
      if (result.error) throw new Error(result.error.message);
      window.location.assign("/account/continue");
    } catch (error) {
      setStatus(errorMessage(error, "The passkey could not be created."));
      setPending(false);
    }
  };

  const usePasskey = async (): Promise<void> => {
    setPending(true);
    setStatus("Waiting for your passkey…");
    try {
      const result = await authClient.signIn.passkey({ autoFill: false });
      if (result.error) throw new Error(result.error.message);
      window.location.assign("/account/continue");
    } catch (error) {
      setStatus(errorMessage(error, "Passkey sign-in failed."));
      setPending(false);
    }
  };

  return (
    <div className="auth-provider-list">
      <button
        className="btn auth-provider"
        type="button"
        disabled={pending}
        onClick={() => void socialSignIn("google")}
      >
        <GoogleIcon />Sign in with Google
      </button>
      <button
        className="btn auth-provider"
        type="button"
        disabled={pending}
        onClick={() => void socialSignIn("github")}
      >
        <GitHubLogoIcon aria-hidden="true" />Sign in with GitHub
      </button>
      <div className="auth-divider"><span>or use a passkey</span></div>
      <button
        className="btn secondary auth-provider"
        type="button"
        disabled={pending}
        onClick={() => void createPasskey()}
      >
        <LockClosedIcon aria-hidden="true" />Create passkey
      </button>
      <button
        className="btn secondary auth-provider"
        type="button"
        disabled={pending}
        onClick={() => void usePasskey()}
      >
        <EnterIcon aria-hidden="true" />Use passkey
      </button>
      <p className="muted auth-status" role="status" aria-live="polite">{status}</p>
    </div>
  );
}

const root = document.getElementById("landing-auth-root");
if (root) createRoot(root).render(<LandingAuth />);
