import { askConfirmation } from "./confirmation.js";
import { errorMessage, requestJson } from "./http.js";
import { authClient } from "./auth-client.js";

const notificationsRoot = document.getElementById("notifications");
let unreadNotificationCount = Number(notificationsRoot?.dataset.unreadCount ?? 0);
const notificationStatus = document.getElementById("notifications-status");

function updateNotificationBadge(): void {
  const notificationLabel = notificationsRoot?.querySelector<HTMLElement>(".notification-count");
  if (notificationLabel) {
    if (unreadNotificationCount > 0) {
      notificationLabel.textContent = `${unreadNotificationCount} unread`;
    } else {
      notificationLabel.classList.remove("badge", "notification-count");
      notificationLabel.classList.add("muted");
      notificationLabel.textContent = "All caught up";
    }
  }
  const accountLink = document.querySelector<HTMLAnchorElement>(".account-link");
  if (!accountLink) return;
  if (unreadNotificationCount > 0) {
    accountLink.classList.add("has-notifications");
    accountLink.dataset.notificationCount = unreadNotificationCount > 99
      ? "99+"
      : String(unreadNotificationCount);
    accountLink.setAttribute(
      "aria-label",
      `Account, ${unreadNotificationCount} unread notification${unreadNotificationCount === 1 ? "" : "s"}`,
    );
    return;
  }
  accountLink.classList.remove("has-notifications");
  delete accountLink.dataset.notificationCount;
  accountLink.setAttribute("aria-label", "Account");
}

function markNotificationRead(button: HTMLButtonElement): void {
  const notificationId = button.dataset.notificationRead;
  if (!notificationId || button.disabled) return;
  button.disabled = true;
  void requestJson(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" })
    .then(() => {
      const item = button.closest<HTMLElement>("[data-notification-id]");
      item?.classList.remove("unread");
      item?.querySelector("[data-notification-new]")?.remove();
      button.remove();
      unreadNotificationCount = Math.max(0, unreadNotificationCount - 1);
      if (notificationsRoot) notificationsRoot.dataset.unreadCount = String(unreadNotificationCount);
      updateNotificationBadge();
    })
    .catch((error: unknown) => {
      button.disabled = false;
      if (notificationStatus) notificationStatus.textContent = errorMessage(error, "Could not mark the notification as read.");
    });
}

document.querySelectorAll<HTMLButtonElement>("[data-notification-read]").forEach((button) => {
  button.addEventListener("click", () => markNotificationRead(button));
});

const markAllNotificationsButton = document.getElementById("mark-notifications-read") as HTMLButtonElement | null;
markAllNotificationsButton?.addEventListener("click", () => {
  if (markAllNotificationsButton.disabled) return;
  markAllNotificationsButton.disabled = true;
  void requestJson("/api/notifications/read-all", { method: "POST" })
    .then(() => {
      notificationsRoot?.querySelectorAll<HTMLElement>(".notification.unread").forEach((item) => {
        item.classList.remove("unread");
        item.querySelector("[data-notification-new]")?.remove();
        item.querySelector("[data-notification-read]")?.remove();
      });
      unreadNotificationCount = 0;
      if (notificationsRoot) notificationsRoot.dataset.unreadCount = "0";
      updateNotificationBadge();
      markAllNotificationsButton.remove();
    })
    .catch((error: unknown) => {
      markAllNotificationsButton.disabled = false;
      if (notificationStatus) notificationStatus.textContent = errorMessage(error, "Could not mark the notifications as read.");
    });
});

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
