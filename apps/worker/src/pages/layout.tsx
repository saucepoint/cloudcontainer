import type { Child, FC } from "hono/jsx";

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0b0e14; --panel: #131721; --panel2: #1a1f2e; --border: #232a3b;
  --text: #e6e9f0; --muted: #8b93a7; --accent: #6ee7b7; --accent-dim: #34d39922;
  --danger: #f87171; --warn: #fbbf24; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); text-decoration: none; }
.wrap { max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header.site { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2.5rem; }
.logo { font-weight: 700; letter-spacing: -0.02em; font-size: 1.15rem; color: var(--text); }
.logo span { color: var(--accent); }
h1 { font-size: 2rem; letter-spacing: -0.03em; line-height: 1.15; margin: 0 0 0.75rem; }
p.lead { color: var(--muted); font-size: 1.08rem; margin: 0 0 2rem; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.25rem; }
.card h2 { margin: 0 0 1rem; font-size: 1.05rem; }
.btn { display: inline-block; background: var(--accent); color: #05261a; border: 0; border-radius: 8px;
  padding: 0.65rem 1.3rem; font-weight: 600; font-size: 0.95rem; cursor: pointer; }
.btn:hover { filter: brightness(1.08); }
.btn.secondary { background: var(--panel2); color: var(--text); border: 1px solid var(--border); }
.btn.danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
.btn:disabled { opacity: 0.45; cursor: default; }
label { display: block; font-size: 0.85rem; color: var(--muted); margin: 0.9rem 0 0.3rem; }
input[type=text], input[type=password], textarea, select {
  width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; padding: 0.55rem 0.7rem; font-size: 0.92rem; font-family: var(--mono); }
textarea { min-height: 5.5rem; resize: vertical; }
.agents { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; }
.agent { position: relative; }
.agent input { position: absolute; opacity: 0; }
.agent label { display: block; margin: 0; cursor: pointer; background: var(--panel2); border: 1px solid var(--border);
  border-radius: 10px; padding: 0.9rem 1rem; color: var(--text); font-size: 0.95rem; font-weight: 600; }
.agent small { display: block; color: var(--muted); font-weight: 400; margin-top: 0.2rem; }
.agent input:checked + label { border-color: var(--accent); background: var(--accent-dim); }
.badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
.badge.running { background: #16341f; color: var(--accent); }
.badge.provisioning, .badge.destroying { background: #2b2417; color: var(--warn); }
.badge.stopped, .badge.waitlisted { background: var(--panel2); color: var(--muted); }
.badge.error, .badge.suspended { background: #341616; color: var(--danger); }
pre.ssh { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem 1rem;
  font-family: var(--mono); font-size: 0.9rem; overflow-x: auto; margin: 0.6rem 0; }
pre.ssh.prompt { white-space: pre-wrap; word-break: break-word; }
.muted { color: var(--muted); font-size: 0.88rem; }
.check { list-style: none; padding: 0; margin: 0.5rem 0 0; }
.check li { padding: 0.35rem 0; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; font-size: 0.92rem; }
.check li:last-child { border-bottom: 0; }
.ok { color: var(--accent); } .missing { color: var(--muted); }
details { margin-top: 1rem; } summary { cursor: pointer; color: var(--muted); font-size: 0.92rem; }
.row { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-top: 1rem; }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -2px; margin-right: 0.4rem; }
@keyframes spin { to { transform: rotate(360deg); } }
.err { color: var(--danger); font-size: 0.9rem; margin-top: 0.6rem; min-height: 1.2rem; }
.qr { display: flex; justify-content: center; margin-top: 1rem; }
.qr canvas { border-radius: 8px; background: #fff; padding: 12px; }
`;

export const Layout: FC<{ title?: string; loggedIn?: boolean; children?: Child }> = ({
  title,
  loggedIn,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title ? `${title} — Codestation` : "Codestation"}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <div class="wrap">
        <header class="site">
          <a class="logo" href={loggedIn ? "/dashboard" : "/"}>
            code<span>station</span>
          </a>
          {loggedIn ? (
            <form method="post" action="/auth/logout" style="margin:0">
              <button class="btn secondary" type="submit">
                Sign out
              </button>
            </form>
          ) : null}
        </header>
        {children}
      </div>
    </body>
  </html>
);
