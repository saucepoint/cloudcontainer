import type { Child, FC } from "hono/jsx";
import { PAGE_STYLES } from "./styles.js";

export const Layout: FC<{
  title?: string;
  loggedIn?: boolean;
  notificationCount?: number;
  children?: Child;
}> = ({
  title,
  loggedIn,
  notificationCount = 0,
  children,
}) => {
  const unreadLabel = notificationCount === 1
    ? "1 unread notification"
    : `${notificationCount} unread notifications`;
  return (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="theme-color" content="#fbfaf7" />
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <link rel="preload" href="/fonts/ibm-plex-sans-latin.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
      <title>{title ? `${title} — usebench.dev` : "usebench.dev"}</title>
      <style dangerouslySetInnerHTML={{ __html: PAGE_STYLES }} />
    </head>
    <body>
      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div id="app-root">
        <div class="wrap">
          <header class="site">
            <a class="logo" href={loggedIn ? "/dashboard" : "/"}>
              <span class="logo-wordmark">work<span class="logo-bench">bench</span></span>
              <span class="logo-beta">beta</span>
            </a>
            {loggedIn ? (
              <nav class="row flush" aria-label="Account">
                <a
                  class={`btn secondary account-link${notificationCount > 0 ? " has-notifications" : ""}`}
                  aria-label={notificationCount > 0 ? `Account, ${unreadLabel}` : "Account"}
                  {...(notificationCount > 0
                    ? { "data-notification-count": notificationCount > 99 ? "99+" : String(notificationCount) }
                    : {})}
                  href="/account"
                >Account</a>
                <form method="post" action="/auth/logout" class="flush">
                  <button class="btn secondary" type="submit">
                    Sign out
                  </button>
                </form>
              </nav>
            ) : null}
          </header>
          <main id="main-content">{children}</main>
        </div>
      </div>
      <div id="ui-root"></div>
      <script type="module" src="/ui.js"></script>
    </body>
  </html>
  );
};
