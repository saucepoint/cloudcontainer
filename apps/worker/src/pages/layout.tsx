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
              usebench<span>.dev</span>
            </a>
            {loggedIn ? (
              <nav class="row" aria-label="Account" style="margin:0">
                <a class="btn secondary" href="/security">Security</a>
                <form method="post" action="/auth/logout" style="margin:0">
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
