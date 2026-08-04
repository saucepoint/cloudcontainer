import { authClient } from "./auth-client.js";

type Provider = "google" | "github";
const root = document.getElementById("cli-auth-root");
if (root) {
  const provider = root.dataset.provider as Provider | undefined;
  const attempt = root.dataset.attempt;
  const button = root.querySelector<HTMLButtonElement>("button");
  const status = root.querySelector<HTMLElement>("[data-status]");
  if (provider && attempt && button && status) {
    const label = provider === "google" ? "Google" : "GitHub";
    button.textContent = `Continue with ${label}`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Opening sign-in…";
      try {
        const result = await authClient.signIn.social({
          provider,
          callbackURL: `/cli/auth/callback?attempt=${encodeURIComponent(attempt)}`,
        });
        if (result.error) throw new Error(result.error.message);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Sign-in could not be started.";
        button.disabled = false;
      }
    });
  }
}
