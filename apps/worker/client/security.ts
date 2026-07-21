import {
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import { postJson } from "./http.js";
import { webAuthnErrorMessage } from "./webauthn-errors.js";

const button = document.querySelector<HTMLButtonElement>("#add-passkey-btn");
const status = document.querySelector<HTMLElement>("#passkey-setup-status");
const count = document.querySelector<HTMLElement>("#passkey-count");
const continueLink = document.querySelector<HTMLAnchorElement>("#security-continue");

async function addPasskey(
  addButton: HTMLButtonElement,
  setupStatus: HTMLElement,
  passkeyCount: HTMLElement,
): Promise<void> {
  addButton.disabled = true;
  setupStatus.textContent = "Waiting for your device…";
  try {
    const optionsJSON = await postJson<PublicKeyCredentialCreationOptionsJSON>(
      "/auth/passkey/register/options",
      undefined,
      "The passkey could not be added.",
    );
    const response = await startRegistration({ optionsJSON });
    setupStatus.textContent = "Verifying…";
    const result = await postJson<{ verified: true; passkeyCount: number }>(
      "/auth/passkey/register/verify",
      { response },
      "The passkey could not be added.",
    );
    passkeyCount.textContent = `${result.passkeyCount} ${result.passkeyCount === 1 ? "passkey" : "passkeys"}`;
    addButton.textContent = "Add another passkey →";
    if (continueLink) continueLink.textContent = "Continue →";
    setupStatus.textContent = "Passkey added. You can now use it from the sign-in page.";
  } catch (error) {
    setupStatus.textContent = webAuthnErrorMessage(error, "The passkey could not be added.");
  } finally {
    addButton.disabled = false;
  }
}

if (button && status && count) {
  if (browserSupportsWebAuthn()) {
    button.addEventListener("click", () => void addPasskey(button, status, count));
  } else {
    button.disabled = true;
    status.textContent = "This browser does not support passkeys.";
  }
}
