import { askConfirmation } from "./confirmation.js";
import { errorMessage, requestJson } from "./http.js";
import { authClient } from "./auth-client.js";

const passkeyButton = document.getElementById("add-passkey-btn") as HTMLButtonElement | null;
const passkeyStatus = document.getElementById("passkey-setup-status");

passkeyButton?.addEventListener("click", () => {
  passkeyButton.disabled = true;
  if (passkeyStatus) passkeyStatus.textContent = "Waiting for your passkey manager…";
  void authClient.passkey.addPasskey({ name: "Backup passkey" }).then((result) => {
    if (result.error) throw new Error(result.error.message);
    window.location.reload();
  }).catch((error: unknown) => {
    if (passkeyStatus) passkeyStatus.textContent = errorMessage(error, "The passkey could not be added.");
    passkeyButton.disabled = false;
  });
});

const credentialsButton = document.getElementById("delete-credentials-btn") as HTMLButtonElement | null;
const credentialsStatus = document.getElementById("credentials-delete-status");

credentialsButton?.addEventListener("click", () => {
  askConfirmation(
    "Delete saved credentials?",
    "This permanently removes your OAuth tokens, API tokens, and other saved credentials.",
    "Delete credentials",
    () => {
      credentialsButton.disabled = true;
      void requestJson("/api/credentials", { method: "DELETE" })
        .then(() => window.location.reload())
        .catch((error: unknown) => {
          if (credentialsStatus) credentialsStatus.textContent = errorMessage(error, "Could not delete the credentials.");
          credentialsButton.disabled = false;
        });
    },
    true,
  );
});

const accountButton = document.getElementById("delete-account-btn") as HTMLButtonElement | null;
const accountStatus = document.getElementById("account-delete-status");

accountButton?.addEventListener("click", () => {
  askConfirmation(
    "Delete account?",
    "This permanently deletes your credentials, keys, and account. There is no grace period.",
    "Delete account",
    () => {
      accountButton.disabled = true;
      void requestJson("/api/account/delete", { method: "POST" })
        .then(() => { window.location.href = "/"; })
        .catch((error: unknown) => {
          if (accountStatus) accountStatus.textContent = errorMessage(error, "Could not delete the account.");
          accountButton.disabled = false;
        });
    },
    true,
  );
});
