import { authClient } from "./auth-client.js";

const button = document.getElementById("add-passkey-btn") as HTMLButtonElement | null;
const status = document.getElementById("passkey-setup-status");

button?.addEventListener("click", () => {
  button.disabled = true;
  if (status) status.textContent = "Waiting for your passkey manager…";
  void authClient.passkey.addPasskey({ name: "Backup passkey" }).then((result) => {
    if (result.error) throw new Error(result.error.message);
    window.location.reload();
  }).catch((error: unknown) => {
    if (status) status.textContent = error instanceof Error ? error.message : "The passkey could not be added.";
    button.disabled = false;
  });
});
