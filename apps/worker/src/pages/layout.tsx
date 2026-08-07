import type { Child, FC } from "hono/jsx";
import { PAGE_STYLES } from "./styles.js";

const CONTACT_ADDRESS_CODE = "104,101,108,108,111,64,117,115,101,98,101,110,99,104,46,100,101,118";

// Canonical origin for SEO/social tags. These must always point at the
// production site even when the Worker runs locally or in preview.
const PUBLIC_ORIGIN = "https://usebench.dev";
const DEFAULT_DESCRIPTION =
  "Your free cloud terminal. An always-on Debian container with SSH, tmux, git, and the AI coding agents you already use — ready in minutes.";

export const Layout: FC<{
  title?: string;
  description?: string;
  path?: string;
  loggedIn?: boolean;
  notificationCount?: number;
  footerLinks?: Child;
  children?: Child;
}> = ({
  title,
  description = DEFAULT_DESCRIPTION,
  path = "/",
  loggedIn,
  notificationCount = 0,
  footerLinks,
  children,
}) => {
  const unreadLabel = notificationCount === 1
    ? "1 unread notification"
    : `${notificationCount} unread notifications`;
  const pageTitle = title ? `${title} — usebench.dev` : "workbench — your free cloud terminal";
  const pageUrl = `${PUBLIC_ORIGIN}${path}`;
  const ogImageUrl = `${PUBLIC_ORIGIN}/og.png`;
  return (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="theme-color" content="#fbfaf7" />
      <title>{pageTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={pageUrl} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="workbench" />
      <meta property="og:title" content={pageTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={pageUrl} />
      <meta property="og:image" content={ogImageUrl} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content="workbench — your free cloud terminal" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={pageTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImageUrl} />
      <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
      <link rel="preload" href="/fonts/ibm-plex-sans-latin.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
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
      <nav class="site-formalities" aria-label="Site information">
        <a class="site-formality" href="/terms">Terms of Service</a>
        {loggedIn ? (
          <a
            id="contact"
            class="site-formality"
            href="#contact"
            data-contact-code={CONTACT_ADDRESS_CODE}
          >Contact</a>
        ) : null}
        {footerLinks}
      </nav>
      <div id="ui-root"></div>
      <script type="module" src="/ui.js"></script>
    </body>
  </html>
  );
};
