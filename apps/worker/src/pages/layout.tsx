import type { Child, FC } from "hono/jsx";
import { PAGE_STYLES } from "./styles.js";

export const Layout: FC<{ title?: string; loggedIn?: boolean; children?: Child }> = ({
  title,
  loggedIn,
  children,
}) => (
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
              work<span class="logo-bench">bench</span>
            </a>
            {loggedIn ? (
              <nav class="row flush" aria-label="Account">
                <a class="btn secondary" href="/account">Account</a>
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
