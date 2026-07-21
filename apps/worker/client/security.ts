import {
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";

const button = document.querySelector<HTMLButtonElement>("#add-passkey-btn");
const status = document.querySelector<HTMLElement>("#passkey-setup-status");
const count = document.querySelector<HTMLElement>("#passkey-count");
const continueLink = document.querySelector<HTMLAnchorElement>("#security-continue");

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
