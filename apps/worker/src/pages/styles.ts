export const PAGE_STYLES = `
@font-face {
  font-family: "IBM Plex Sans";
  src: url("/fonts/ibm-plex-sans-latin.woff2") format("woff2");
  font-weight: 100 700;
  font-style: normal;
  font-display: swap;
}
:root {
  color-scheme: light;
  --paper: #fbfaf7;
  --ink: #20201d;
  --muted: #65645e;
  --line: #d8d6cf;
  --line-strong: #aaa79e;
  --surface: #f2f0ea;
  --surface-strong: #e8e6de;
  --field: #fffefa;
  --accent: #174ea6;
  --accent-strong: #123f87;
  --accent-soft: #eaf0fa;
  --danger: #a63025;
  --danger-strong: #8e2a20;
  --danger-soft: #f9ece9;
  --warn: #7a5700;
  --focus: #174ea6;
  --radius: 6px;
  --sans: "IBM Plex Sans", Arial, Helvetica, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--paper); }
body { position: relative; min-height: 100vh; margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.5 var(--sans); }
button, input, textarea, select { font: inherit; }
button { appearance: none; }
a { color: var(--accent); text-underline-offset: 0.16em; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
::selection { background: #c9daf5; }
.skip-link { position: fixed; z-index: 100; left: 1rem; top: 1rem; padding: 0.45rem 0.65rem;
  background: var(--paper); color: var(--accent); border: 1px solid var(--line-strong);
  border-radius: var(--radius); transform: translateY(-180%); }
.skip-link:focus { transform: translateY(0); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
#app-root { isolation: isolate; }
.wrap { width: min(100% - 2.5rem, 731px); margin: 0 auto; padding-bottom: 5rem; }
header.site { min-height: 70px; display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--ink); margin-bottom: 3.75rem; }
.logo { display: inline-flex; align-items: center; gap: 0.55rem; color: var(--ink); font-family: var(--mono);
  font-size: 0.96rem; font-weight: 700; letter-spacing: -0.025em; text-decoration: none; }
.logo:hover { text-decoration: none; }
.logo-bench { color: var(--accent); }
.logo-beta { padding: 0.15rem 0.35rem; border: 1px solid var(--line); border-radius: 3px; background: var(--surface);
  color: var(--muted); font-size: 0.62rem; font-weight: 600; letter-spacing: 0.04em; line-height: 1; }
main { display: block; }
h1 { max-width: 700px; margin: 0 0 0.65rem; font-size: clamp(2rem, 7vw, 4.2rem);
  font-weight: 600; letter-spacing: -0.04em; line-height: 0.98; }
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
  min-height: 2.15rem; font-weight: 600; font-size: 0.92rem; line-height: 1.2; cursor: pointer;
  text-decoration: none;
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 100ms ease; }
.btn, .link-btn { padding: 0.35rem 0.2rem; border: 0; border-radius: 0;
  background: transparent; color: var(--accent); text-decoration: underline;
  text-underline-offset: 0.16em; }
.btn:hover, .link-btn:hover { background: var(--accent-soft); text-decoration: underline;
  text-underline-offset: 0.16em; }
.btn:active { transform: translateY(1px); }
.btn svg, .link-btn svg { width: 1em; height: 1em; flex: 0 0 auto; }
.btn.primary { padding: 0.45rem 0.95rem; border: 1px solid var(--accent); border-radius: var(--radius);
  background: var(--accent); color: #fff; text-decoration: none; }
.btn.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); text-decoration: none; }
.btn.secondary { background: transparent; color: var(--accent); }
.account-link { position: relative; }
.account-link.has-notifications::after { content: attr(data-notification-count); position: absolute; top: -0.35rem; right: -0.45rem;
  display: inline-flex; min-width: 1.05rem; height: 1.05rem; align-items: center; justify-content: center;
  padding: 0 0.2rem; border: 2px solid var(--paper); border-radius: 999px; background: var(--danger);
  color: #fff; font-family: var(--mono); font-size: 0.62rem; font-weight: 700; line-height: 1; text-decoration: none; }
.btn.danger { background: transparent; color: var(--danger); }
.btn.danger:hover { background: var(--danger-soft); }
.btn.danger-solid { padding: 0.45rem 0.95rem; border: 1px solid var(--danger);
  border-radius: var(--radius); background: var(--danger); color: #fff; text-decoration: none; }
.btn.danger-solid:hover { background: var(--danger-strong); border-color: var(--danger-strong); }
.btn[aria-pressed="true"] { background: var(--accent-soft); text-decoration: underline;
  text-underline-offset: 0.16em; }
.btn:disabled, .link-btn:disabled { opacity: 0.55; cursor: default; text-decoration: none;
  pointer-events: none; transform: none; }
.btn.primary .spinner, .btn.danger-solid .spinner {
  border-color: rgb(255 255 255 / 0.4); border-top-color: #fff; }
label { display: block; margin: 1rem 0 0.3rem; color: var(--ink); font-size: 0.82rem; font-weight: 700; }
input[type=text], input[type=password], input[type=search], textarea, select {
  width: 100%; background: var(--field); color: var(--ink); border: 1px solid var(--line-strong);
  border-radius: var(--radius); padding: 0.64rem 0.7rem; font-size: 0.9rem; font-family: var(--mono);
  box-shadow: 0 1px 2px rgb(32 32 29 / 0.05);
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease; }
input:hover, textarea:hover, select:hover { border-color: var(--line-strong); }
input:focus, textarea:focus, select:focus { background: #fff; border-color: var(--focus);
  box-shadow: 0 0 0 1px var(--focus); }
textarea { min-height: 6rem; resize: vertical; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { width: 100%; margin: 0 0 1rem; color: var(--ink); }
.agents { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
.agent { display: grid; grid-template-columns: minmax(0, 1fr); background: var(--surface);
  border-radius: var(--radius); overflow: hidden; transition: background-color 140ms ease; }
.agent:hover { background: var(--surface-strong); }
.agent-choice input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.agent-choice { grid-column: 1; grid-row: 1; display: flex; min-height: 6.2rem; gap: 0.65rem; align-items: flex-start; margin: 0; padding: 0.85rem 1rem;
  color: var(--ink); background: transparent; border: 0; border-radius: 0; cursor: pointer; font-size: 0.94rem; }
.agent-choice:focus-within { outline: 2px solid var(--focus); outline-offset: -2px; }
.agent-checkbox { display: inline-flex; flex: 0 0 auto; width: 1.1rem; height: 1.1rem; align-items: center; justify-content: center;
  margin-top: 0.12rem; border: 1px solid var(--line-strong); color: transparent; font-family: var(--mono); font-size: 0.8rem; line-height: 1; }
.agent-choice input:checked + .agent-checkbox { border-color: var(--accent); background: var(--accent); color: #fff; }
.agent-copy { min-width: 0; flex: 1; }
.agent-title { display: block; }
.agent small { display: block; color: var(--muted); font-weight: 400; line-height: 1.35; margin-top: 0.25rem; }
.agent:has(input:checked), .agent:has(input:checked):hover { background: var(--accent-soft); }
.agent:has(input:checked) .agent-choice { color: var(--accent); background: var(--accent-soft); }
.agent-signins { display: grid; gap: 0.5rem; padding: 0 1rem 0.85rem; }
.agent-auth { min-width: 0; }
.agent-signin { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
.agent-signin .btn { font-size: 0.8rem; }
.agent-signin .ok { font-size: 0.78rem; }
.agent-auth > [id$="-flow"] { min-width: 0; }
.agent-auth > [id$="-flow"]:empty { display: none; }
.device-flow { display: grid; gap: 0.65rem; padding-top: 0.25rem; }
.device-flow-steps { margin: 0; padding-left: 1.2rem; }
.device-flow-steps li + li { margin-top: 0.2rem; }
.device-flow-code { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.65rem; align-items: center; }
.device-flow-code .ssh { min-width: 0; margin: 0; font-size: 1rem; font-weight: 700; letter-spacing: 0.16em; text-align: center; }
.device-flow-code .btn { justify-self: start; white-space: nowrap; }
.device-flow .muted { margin: 0; }
.flow-steps { margin: 0.6rem 0; padding-left: 1.2rem; }
.badge { display: inline-flex; align-items: center; gap: 0.42rem; padding: 0; font-family: var(--mono);
  font-size: 0.76rem; font-weight: 600; white-space: nowrap; transition: color 240ms ease; }
.badge::before { content: ""; width: 0.48rem; height: 0.48rem; border-radius: 50%;
  background: var(--muted); transition: background-color 240ms ease; }
.badge.running { color: #28643b; }
.badge.running::before { background: #3e8b55; animation: badge-pulse 1.4s ease-out 2; }
@keyframes badge-pulse {
  0% { box-shadow: 0 0 0 0 rgb(62 139 85 / 0.4); }
  100% { box-shadow: 0 0 0 7px rgb(62 139 85 / 0); }
}
.badge.provisioning, .badge.destroying, .badge.upgrade_pending { color: var(--warn); }
.badge.provisioning::before, .badge.destroying::before, .badge.upgrade_pending::before { background: #b88a12; }
.badge.error, .badge.suspended { color: var(--danger); }
.badge.error::before, .badge.suspended::before { background: var(--danger); }
.badge.notification-count { color: var(--danger); }
.badge.notification-count::before { background: var(--danger); }
.notification-list { display: grid; gap: 0.75rem; }
.notification { padding: 0.85rem 1rem; border-left: 3px solid var(--line-strong); background: var(--surface); }
.notification.unread { border-left-color: var(--danger); background: var(--danger-soft); }
.notification-head { display: flex; gap: 0.75rem; align-items: baseline; justify-content: space-between; }
.notification h3 { margin: 0; font-size: 0.98rem; }
.notification.unread h3 { font-weight: 700; }
.notification-message { margin: 0.35rem 0 0; white-space: pre-line; }
.notification-meta { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-top: 0.55rem; }
.notification-meta .btn { min-height: auto; font-size: 0.8rem; }
.notification-unread { color: var(--danger); font-family: var(--mono); font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
.notification-severity { color: var(--muted); font-family: var(--mono); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em; }
.notification-severity.warning { color: var(--warn); }
.notification-severity.critical { color: var(--danger); }
pre.ssh { margin: 0.65rem 0; padding: 0.8rem 0.9rem; background: var(--surface); color: var(--ink);
  border: 0; border-left: 3px solid var(--line-strong); border-radius: 0 var(--radius) var(--radius) 0;
  font-family: var(--mono); font-size: 0.86rem; overflow-x: auto; }
pre.ssh.prompt { white-space: pre-wrap; word-break: break-word; }
.command-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.9rem; align-items: center; }
.command-row pre { margin: 0; }
.muted { color: var(--muted); font-size: 0.86rem; }
.hint { margin: 0.6rem 0 0; }
.key-fingerprint { font-family: var(--mono); font-size: 0.8rem; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; max-width: 75%; }
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
.onboarding-api-keys .provider::before { content: none; }
.provider-head { display: flex; gap: 1rem; justify-content: space-between; align-items: center; flex-wrap: wrap; }
.provider small { display: block; color: var(--muted); margin-top: 0.12rem; }
.repo-list { display: grid; gap: 0.3rem; margin-top: 0.8rem; max-height: 22rem; overflow-y: auto; }
.repo-choice { display: flex; gap: 0.7rem; align-items: flex-start; margin: 0; padding: 0.65rem 0.75rem;
  color: var(--ink); background: var(--surface); border: 0; border-radius: var(--radius); cursor: pointer;
  transition: background-color 140ms ease; }
.repo-choice:hover { background: var(--surface-strong); }
.repo-choice input { flex: 0 0 auto; margin: 0.2rem 0 0; accent-color: var(--accent); }
.repo-choice:has(input:checked), .repo-choice:has(input:checked):hover { color: var(--accent); background: var(--accent-soft); }
.repo-choice:has(input:disabled) { opacity: 0.55; cursor: default; }
.repo-choice small { display: block; color: var(--muted); font-weight: 400; }
details { margin-top: 0.8rem; padding: 0.2rem 0; }
summary { color: var(--accent); font-size: 0.9rem; cursor: pointer; }
.onboarding-api-keys { margin-top: 1.35rem; }
.row { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.8rem; }
.row.flush, form.flush { margin: 0; }
.create-workbench-btn { margin: 1.5rem 0 0; padding: 0.7rem 1.35rem; font-size: 1.02rem; }
.notice { margin: 0.75rem 0; padding: 0.65rem 0 0.65rem 0.8rem; background: transparent;
  border-left: 2px solid var(--line-strong); border-radius: 0; }
.notice.error { color: var(--danger); border-left-color: var(--danger); }
.notice.warning { color: var(--ink); border-left-color: #b88a12; }
.spinner { display: inline-block; width: 12px; height: 12px; border: 1.5px solid var(--line-strong);
  border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite;
  vertical-align: -1px; margin-right: 0.35rem; }
@keyframes spin { to { transform: rotate(360deg); } }
.skel { position: relative; overflow: hidden; background: var(--surface); border-radius: var(--radius); }
.skel::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 0.55), transparent);
  animation: shimmer 1.4s ease-in-out infinite; }
@keyframes shimmer { to { transform: translateX(100%); } }
.skel-title { height: 1.1rem; width: 14rem; max-width: 60%; margin-bottom: 0.9rem; }
.skel-line { height: 0.85rem; width: 100%; max-width: 26rem; margin-top: 0.55rem; }
.skel-line.short { max-width: 16rem; }
.err { margin-top: 0.55rem; color: var(--danger); font-size: 0.88rem; }
.err:empty { display: none; }
.landing-hero { text-align: left; }
.landing-title { max-width: 650px; }
.landing-hero .lead { margin-top: 1.1rem; line-height: 1.8; }
.landing-signin-content { width: 100%; }
.auth-provider-list { display: grid; width: min(100%, 25rem); gap: 0.55rem; margin: 1rem auto 0;
  padding: 1.1rem 1.25rem; border: 1px solid var(--line); border-radius: var(--radius); }
.auth-provider { width: min(100%, 18rem); justify-self: center; justify-content: center; }
.auth-divider { display: flex; align-items: center; gap: 0.75rem; color: var(--muted); font-size: 0.85rem; }
.auth-divider::before, .auth-divider::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
.auth-status { min-height: 1.3em; margin: 0; }
.auth-status:empty { display: none; }
.auth-dev-option { margin-top: 1rem; }
.auth-code-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; }
.auth-code-row input { letter-spacing: 0.18em; text-transform: uppercase; }
.verification-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.verification-option { margin: 0; }
.verification-option h2 { margin-top: 0; }
.verification-status { min-height: 1.3em; margin: 0.65rem 0 0; }
.verification-status.error { color: var(--danger); }
.world-id-qr { width: fit-content; max-width: 100%; margin: 1rem auto 0; text-align: center; }
.world-id-qr img { display: block; width: 240px; max-width: 100%; height: auto; padding: 0.5rem;
  background: #fff; border: 1px solid var(--line); border-radius: var(--radius); }
.world-id-qr p { margin: 0.55rem 0 0; }
.spec-list li { justify-content: flex-start; }
.spec-list .ok, .spec-list .tier-label { align-self: center; display: inline-flex; align-items: center; margin-left: auto;
  font-family: var(--mono); font-size: 0.75rem; line-height: 1.2; white-space: nowrap; }
.dialog-backdrop { position: fixed; inset: 0; z-index: 50; background: rgb(32 32 29 / 0.32);
  transition: opacity 140ms ease; }
.dialog-viewport { position: fixed; inset: 0; z-index: 51; display: grid; place-items: center;
  padding: 1.25rem; overflow-y: auto; }
.dialog-popup { width: min(100%, 430px); padding: 1.25rem; background: var(--paper);
  border: 1px solid var(--line); border-radius: 8px;
  box-shadow: 0 12px 32px rgb(32 32 29 / 0.16), 0 2px 6px rgb(32 32 29 / 0.08);
  transition: opacity 140ms ease, transform 140ms ease; }
.dialog-backdrop[data-starting-style], .dialog-backdrop[data-ending-style] { opacity: 0; }
.dialog-popup[data-starting-style], .dialog-popup[data-ending-style] { opacity: 0; transform: translateY(5px); }
.dialog-title { margin: 0 0 0.45rem; font-size: 1.05rem; }
.dialog-description { margin: 0; color: var(--muted); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.3rem; }
@media (max-width: 600px) {
  .wrap { width: min(100% - 2rem, 860px); padding-bottom: 3rem; }
  input[type=text], input[type=password], input[type=search], textarea, select { font-size: 16px; }
  header.site { min-height: 58px; margin-bottom: 2.5rem; }
  h1 { font-size: clamp(2.4rem, 13vw, 3.5rem); }
  p.lead { margin-bottom: 2.5rem; }
  .card { padding: 1rem 0 1.8rem; }
  .btn, .link-btn { min-height: 2.75rem; }
  .agents { grid-template-columns: 1fr; }
  .agent label { min-height: auto; }
  .card-head { align-items: flex-start; flex-wrap: wrap; }
  .account-link.has-notifications::after { top: -0.2rem; right: -0.3rem; }
  .command-row, .device-flow-code { grid-template-columns: 1fr; }
  .command-row .btn, .device-flow-code .btn { justify-self: start; }
  .auth-code-row, .verification-grid { grid-template-columns: 1fr; gap: 0.35rem; }
  .auth-code-row .btn { justify-self: start; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
  .spinner { animation: none; border-top-color: var(--line-strong); }
  .skel::after { animation: none; }
  .badge.running::before { animation: none; }
}
`;
