import type { Child, FC } from "hono/jsx";

const CSS = `
:root {
  color-scheme: light;
  --paper: #fbfaf7;
  --ink: #20201d;
  --muted: #706f69;
  --line: #d8d6cf;
  --line-strong: #aaa79e;
  --surface: #f2f0ea;
  --field: #fffefa;
  --accent: #174ea6;
  --accent-soft: #eaf0fa;
  --danger: #a63025;
  --warn: #7a5700;
  --focus: #174ea6;
  --mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--paper); }
body { position: relative; min-height: 100vh; margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.5 Arial, Helvetica, sans-serif; }
button, input, textarea, select { font: inherit; }
button { appearance: none; }
a { color: var(--accent); text-underline-offset: 0.16em; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
::selection { background: #c9daf5; }
.skip-link { position: fixed; z-index: 100; left: 1rem; top: 1rem; padding: 0.45rem 0.65rem;
  background: var(--paper); color: var(--accent); border: 1px solid var(--line-strong);
  transform: translateY(-180%); }
.skip-link:focus { transform: translateY(0); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
#app-root { isolation: isolate; }
.wrap { width: min(100% - 2.5rem, 860px); margin: 0 auto; padding-bottom: 5rem; }
header.site { min-height: 70px; display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--ink); margin-bottom: 3.75rem; }
.logo { color: var(--ink); font-family: var(--mono); font-size: 0.96rem; font-weight: 700;
  letter-spacing: -0.025em; text-decoration: none; }
.logo:hover { text-decoration: none; }
.logo span { color: var(--accent); }
main { display: block; }
h1 { max-width: 700px; margin: 0 0 0.65rem; font-size: clamp(2rem, 7vw, 4.2rem);
  font-weight: 500; letter-spacing: -0.055em; line-height: 0.98; }
h2, legend { font-size: 1rem; font-weight: 700; letter-spacing: -0.015em; }
h3 { font-size: 0.92rem; }
p.lead { max-width: 590px; color: var(--muted); font-size: 1.08rem; margin: 0 0 3.75rem; }
code, pre { font-family: var(--mono); }
.card { background: transparent; border: 0; border-top: 1px solid var(--line); border-radius: 0;
  padding: 1.25rem 0 2.25rem; margin: 0; }
.card:last-of-type { margin-bottom: 1.2rem; }
.card h2 { margin: 0 0 1rem; }
.card-head { display: flex; gap: 1rem; justify-content: space-between; align-items: baseline; }
.card-head h2 { margin: 0; }
.btn, .link-btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem;
  min-height: 2.15rem; padding: 0.35rem 0.2rem; border: 0; border-radius: 0; background: transparent;
  color: var(--accent); font-weight: 600; font-size: 0.92rem; line-height: 1.2; cursor: pointer;
  text-decoration: none; }
.btn:hover, .link-btn:hover { background: var(--accent-soft); text-decoration: underline;
  text-underline-offset: 0.16em; }
.btn.secondary, .btn.danger { border: 0; background: transparent; color: var(--accent); }
.btn[data-active="true"] { background: var(--accent); color: #fff; }
.btn[data-active="true"]:hover { background: #123f87; color: #fff; text-decoration: none; }
.btn:disabled, .link-btn:disabled { background: transparent; color: var(--muted); opacity: 0.55;
  cursor: default; text-decoration: none; }
.btn[data-active="true"]:disabled { background: var(--accent); color: #fff; opacity: 0.7; }
label { display: block; margin: 1rem 0 0.3rem; color: var(--ink); font-size: 0.82rem; font-weight: 700; }
input[type=text], input[type=password], input[type=search], textarea, select {
  width: 100%; background: var(--field); color: var(--ink); border: 1px solid var(--line-strong);
  border-radius: 5px; padding: 0.64rem 0.7rem; font-size: 0.9rem; font-family: var(--mono);
  box-shadow: 0 1px 2px rgb(32 32 29 / 0.05);
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease; }
input:hover, textarea:hover, select:hover { border-color: var(--line-strong); }
input:focus, textarea:focus, select:focus { background: #fff; border-color: var(--focus);
  box-shadow: 0 0 0 1px var(--focus); }
textarea { min-height: 6rem; resize: vertical; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { width: 100%; margin: 0 0 1rem; color: var(--ink); }
.agents { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
.agent { display: grid; grid-template-columns: minmax(0, 1fr); background: var(--surface); border-radius: 5px; overflow: hidden; }
.agent input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.agent-choice { grid-column: 1; grid-row: 1; display: flex; min-height: 6.2rem; gap: 0.65rem; align-items: flex-start; margin: 0; padding: 0.85rem 9.5rem 0.85rem 1rem;
  color: var(--ink); background: transparent; border: 0; border-radius: 0; cursor: pointer; font-size: 0.94rem; }
.agent-choice:focus-within { outline: 2px solid var(--focus); outline-offset: -2px; }
.agent-checkbox { display: inline-flex; flex: 0 0 auto; width: 1.1rem; height: 1.1rem; align-items: center; justify-content: center;
  margin-top: 0.12rem; border: 1px solid var(--line-strong); color: transparent; font-family: var(--mono); font-size: 0.8rem; line-height: 1; }
.agent input:checked + .agent-checkbox { border-color: var(--accent); background: var(--accent); color: #fff; }
.agent-copy { min-width: 0; flex: 1; }
.agent-title { display: block; }
.agent small { display: block; color: var(--muted); font-weight: 400; line-height: 1.35; margin-top: 0.25rem; }
.agent:has(input:checked) { background: var(--accent-soft); }
.agent:has(input:checked) .agent-choice { color: var(--accent); background: var(--accent-soft); }
.agent-signin { grid-column: 1; grid-row: 1; display: flex; gap: 0.6rem; align-self: start; justify-self: end; align-items: center;
  padding: 0.45rem 1rem 0; }
.agent-signin .btn { font-size: 0.8rem; }
.agent-signin .ok { font-size: 0.78rem; }
.agent > [id$="-flow"] { grid-column: 1; grid-row: 2; min-width: 0; padding: 0 1rem 0.8rem; }
.agent > [id$="-flow"]:empty { display: none; }
.device-flow { display: grid; gap: 0.65rem; padding-top: 0.25rem; }
.device-flow-steps { margin: 0; padding-left: 1.2rem; }
.device-flow-steps li + li { margin-top: 0.2rem; }
.device-flow-code { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.65rem; align-items: center; }
.device-flow-code .ssh { min-width: 0; margin: 0; font-size: 1rem; font-weight: 700; letter-spacing: 0.16em; text-align: center; }
.device-flow-code .btn { justify-self: start; white-space: nowrap; }
.device-flow .muted { margin: 0; }
.badge { display: inline-flex; align-items: center; gap: 0.42rem; padding: 0; font-family: var(--mono);
  font-size: 0.76rem; font-weight: 600; white-space: nowrap; }
.badge::before { content: ""; width: 0.48rem; height: 0.48rem; border-radius: 50%; background: var(--muted); }
.badge.running { color: #28643b; }
.badge.running::before { background: #3e8b55; }
.badge.provisioning, .badge.destroying, .badge.upgrade_pending { color: var(--warn); }
.badge.provisioning::before, .badge.destroying::before, .badge.upgrade_pending::before { background: #b88a12; }
.badge.error, .badge.suspended { color: var(--danger); }
.badge.error::before, .badge.suspended::before { background: var(--danger); }
pre.ssh { margin: 0.65rem 0; padding: 0.8rem 0.9rem; background: var(--surface); color: var(--ink);
  border: 0; border-left: 3px solid var(--line-strong); border-radius: 0 4px 4px 0;
  font-family: var(--mono); font-size: 0.86rem; overflow-x: auto; }
pre.ssh.prompt { white-space: pre-wrap; word-break: break-word; }
.command-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.9rem; align-items: center; }
.command-row pre { margin: 0; }
.muted { color: var(--muted); font-size: 0.86rem; }
.check { list-style: none; padding: 0; margin: 0.25rem 0 0; }
.check li { min-height: 2.2rem; padding: 0.38rem 0; display: grid;
  grid-template-columns: 0.34rem minmax(0, 1fr) auto; column-gap: 0.75rem;
  align-items: start; font-size: 0.9rem; }
.check li::before { content: ""; width: 0.34rem; height: 0.34rem; margin-top: 0.5rem;
  border-radius: 50%; background: var(--line-strong); }
.ok { color: #28643b; } .missing { color: var(--muted); }
.group-label { margin: 1.5rem 0 0.2rem; color: var(--muted); font-family: var(--mono);
  font-size: 0.7rem; font-weight: 400; text-transform: uppercase; letter-spacing: 0.07em; }
.provider { display: grid; grid-template-columns: 0.34rem minmax(0, 1fr); column-gap: 0.75rem;
  padding: 0.75rem 0; }
.provider::before { content: ""; grid-column: 1; grid-row: 1; align-self: start; width: 0.34rem; height: 0.34rem;
  margin-top: 0.5rem; border-radius: 50%; background: var(--line-strong); }
.provider > * { grid-column: 2; }
.provider-head { display: flex; gap: 1rem; justify-content: space-between; align-items: center; flex-wrap: wrap; }
.provider small { display: block; color: var(--muted); margin-top: 0.12rem; }
.repo-list { display: grid; gap: 0.3rem; margin-top: 0.8rem; max-height: 22rem; overflow-y: auto; }
.repo-choice { display: flex; gap: 0.7rem; align-items: flex-start; margin: 0; padding: 0.65rem 0.75rem;
  color: var(--ink); background: var(--surface); border: 0; border-radius: 4px; cursor: pointer; }
.repo-choice input { flex: 0 0 auto; margin: 0.2rem 0 0; accent-color: var(--accent); }
.repo-choice:has(input:checked) { color: var(--accent); background: var(--accent-soft); }
.repo-choice:has(input:disabled) { opacity: 0.55; cursor: default; }
.repo-choice small { display: block; color: var(--muted); font-weight: 400; }
details { margin-top: 0.8rem; padding: 0.2rem 0; }
summary { color: var(--accent); font-size: 0.9rem; cursor: pointer; }
.onboarding-api-keys { margin-top: 1.35rem; }
.row { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.8rem; }
.create-workbench-btn { display: flex; width: fit-content; margin: 1.5rem auto 0; padding: 0.65rem 1.2rem; background: var(--accent); color: #fff; border-radius: 999px; font-size: 1.15rem; }
.create-workbench-btn:hover { background: #123f87; color: #fff; text-decoration: none; }
.notice { margin: 0.75rem 0; padding: 0.65rem 0 0.65rem 0.8rem; background: transparent;
  border-left: 2px solid var(--line-strong); border-radius: 0; }
.notice.error { color: var(--danger); border-left-color: var(--danger); }
.notice.warning { color: var(--ink); border-left-color: #b88a12; }
.spinner { display: inline-block; width: 12px; height: 12px; border: 1.5px solid var(--line-strong);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
  vertical-align: -1px; margin-right: 0.35rem; }
@keyframes spin { to { transform: rotate(360deg); } }
.err { min-height: 1.2rem; margin-top: 0.55rem; color: var(--danger); font-size: 0.88rem; }
.landing-title { max-width: 650px; }
.landing-signin-content { max-width: 580px; }
.landing-signin h2 { margin-bottom: 0.25rem; }
.auth-tabs { margin-top: 1rem; }
.auth-tab-list { display: flex; gap: 0.2rem; padding: 0.2rem; background: var(--surface); border-radius: 5px; }
.auth-tab { position: relative; flex: 1 1 0; min-height: 2.4rem; padding: 0.4rem 0.55rem; border: 0; border-radius: 3px; background: transparent;
  color: var(--muted); font-weight: 600; font-size: 0.84rem; cursor: pointer; }
.auth-tab:hover { color: var(--accent); }
.auth-tab[data-active] { color: var(--ink); }
.auth-tab-label { position: relative; z-index: 1; }
.auth-tab-indicator { position: absolute; inset: 0; z-index: 0; border-radius: 3px; background: var(--paper); box-shadow: 0 1px 2px rgb(32 32 29 / 0.1); }
.auth-tab-panel { min-width: 0; }
.auth-option { display: grid; gap: 0.5rem; padding: 1.1rem 0 0; }
.auth-option-form { display: grid; gap: 0.5rem; }
.auth-option p { margin: 0; }
.auth-option-title { margin: 0; font-size: 1rem; }
.auth-option > .btn { justify-self: start; }
.auth-dev-option { margin-top: 1rem; }
.auth-code-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; }
.auth-code-row input { letter-spacing: 0.18em; text-transform: uppercase; }
.spec-list li { justify-content: flex-start; }
.spec-list .ok { margin-left: auto; font-family: var(--mono); font-size: 0.75rem; }
.dialog-backdrop { position: fixed; inset: 0; z-index: 50; background: rgb(32 32 29 / 0.32);
  transition: opacity 140ms ease; }
.dialog-viewport { position: fixed; inset: 0; z-index: 51; display: grid; place-items: center;
  padding: 1.25rem; overflow-y: auto; }
.dialog-popup { width: min(100%, 430px); padding: 1.25rem; background: var(--paper);
  border: 1px solid var(--ink); box-shadow: 7px 7px 0 rgb(32 32 29 / 0.12);
  transition: opacity 140ms ease, transform 140ms ease; }
.dialog-backdrop[data-starting-style], .dialog-backdrop[data-ending-style] { opacity: 0; }
.dialog-popup[data-starting-style], .dialog-popup[data-ending-style] { opacity: 0; transform: translateY(5px); }
.dialog-title { margin: 0 0 0.45rem; font-size: 1.05rem; }
.dialog-description { margin: 0; color: var(--muted); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1.3rem; }
@media (max-width: 600px) {
  .wrap { width: min(100% - 2rem, 860px); padding-bottom: 3rem; }
  input[type=text], input[type=password], input[type=search], textarea, select { font-size: 16px; }
  header.site { min-height: 58px; margin-bottom: 2.5rem; }
  h1 { font-size: clamp(2.4rem, 13vw, 3.5rem); }
  p.lead { margin-bottom: 2.5rem; }
  .card { padding: 1rem 0 1.8rem; }
  .agents { grid-template-columns: 1fr; }
  .agent label { min-height: auto; }
  .card-head { align-items: flex-start; flex-wrap: wrap; }
  .command-row, .device-flow-code { grid-template-columns: 1fr; }
  .command-row .btn, .device-flow-code .btn { justify-self: start; }
  .auth-code-row { grid-template-columns: 1fr; gap: 0.35rem; }
  .auth-code-row .btn { justify-self: start; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
  .spinner { animation: none; border-top-color: var(--line-strong); }
}
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
      <meta name="theme-color" content="#fbfaf7" />
      <title>{title ? `${title} — Workbench` : "Workbench"}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div id="app-root">
        <div class="wrap">
          <header class="site">
            <a class="logo" href={loggedIn ? "/dashboard" : "/"}>
              work<span>bench</span>
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
