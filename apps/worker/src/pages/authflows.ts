/**
 * Inline JS driving every subscription sign-in flow, shared by the onboarding
 * wizard and the dashboard. Exposes on window:
 *
 * - codexDeviceFlow(el, done)   — "Sign in with ChatGPT" (OpenAI device code)
 * - copilotDeviceFlow(el, done) — "Sign in with GitHub" (GitHub device code)
 * - claudeOauthFlow(el, done)   — "Sign in with Claude" (approve, paste code)
 * - wranglerOauthFlow(el, done) — "Sign in with Cloudflare" (approve, paste
 *                                 the localhost callback URL)
 *
 * Each renders its UI into `el`, talks to the Worker's flow endpoints, and
 * calls `done()` once the credential is stored server-side. window.afActive
 * is true while any flow is on screen so re-renders know not to wipe it.
 */
export const AUTH_FLOWS_JS = `
const afEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function afApi(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('request failed: ' + res.status));
  return json;
}
window.afActive = false;

// Device-code flows: show a one-time code, poll until the provider approves.
async function afDeviceFlow(el, done, cfg) {
  window.afActive = true;
  const fail = (msg) => { window.afActive = false; el.innerHTML = '<p class="err">' + afEsc(msg) + '</p>'; };
  el.innerHTML = '<p class="muted"><span class="spinner"></span>' + afEsc(cfg.contacting) + '</p>';
  let start;
  try { start = await afApi(cfg.startPath); } catch (e) { return fail(e.message); }
  el.innerHTML =
    '<ol style="margin:0.6rem 0 0.6rem 1.2rem">' +
    '<li>Open <a href="' + afEsc(start.verificationUrl) + '" target="_blank" rel="noreferrer">' +
      afEsc(start.verificationUrl) + '</a>' + cfg.signInHint + '</li>' +
    '<li>Enter this one-time code (expires in ' + Math.round(start.expiresInSec / 60) + ' minutes)</li></ol>' +
    '<pre class="ssh">' + afEsc(start.userCode) + '</pre>' +
    '<p class="muted"><span class="spinner"></span>Waiting for approval…</p>';
  const deadline = Date.now() + start.expiresInSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (start.intervalSec || 5) * 1000));
    let poll;
    try { poll = await afApi(cfg.pollPath, cfg.pollBody(start)); } catch (e) { return fail(e.message); }
    if (poll.status === 'connected') { window.afActive = false; done(); return; }
  }
  fail('The code expired — click the sign-in button to get a new one.');
}

// Approve-then-paste flows: open the provider, paste back what it gives you.
async function afPasteFlow(el, done, cfg) {
  window.afActive = true;
  el.innerHTML = '<p class="muted"><span class="spinner"></span>Preparing sign-in…</p>';
  let start;
  try { start = await afApi(cfg.startPath); }
  catch (e) { window.afActive = false; el.innerHTML = '<p class="err">' + afEsc(e.message) + '</p>'; return; }
  el.innerHTML =
    '<ol style="margin:0.6rem 0 0.6rem 1.2rem">' +
    '<li><a href="' + afEsc(start.authorizeUrl) + '" target="_blank" rel="noreferrer">' +
      cfg.openLabel + '</a>' + cfg.step1 + '</li>' +
    '<li>' + cfg.step2 + '</li></ol>' +
    '<label for="' + cfg.inputId + '">' + cfg.inputLabel + '</label>' +
    '<input type="text" id="' + cfg.inputId + '" autocomplete="off" spellcheck="false" placeholder="' + afEsc(cfg.placeholder) + '">' +
    '<div class="row"><button type="button" class="btn af-connect">Connect</button></div>' +
    '<div class="err" role="alert" aria-live="assertive"></div>';
  el.querySelector('.af-connect').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const err = el.querySelector('.err');
    const value = document.getElementById(cfg.inputId).value.trim();
    if (!value) { err.textContent = cfg.emptyError; return; }
    btn.disabled = true;
    err.textContent = '';
    try {
      await afApi(cfg.finishPath, cfg.finishBody(value));
      window.afActive = false;
      done();
    } catch (e) {
      btn.disabled = false;
      err.textContent = e.message;
    }
  });
}

window.codexDeviceFlow = (el, done) => afDeviceFlow(el, done, {
  contacting: 'Contacting OpenAI…',
  signInHint: ' and sign in to ChatGPT',
  startPath: '/api/codex/device',
  pollPath: '/api/codex/device/poll',
  pollBody: (s) => ({ deviceAuthId: s.deviceAuthId, userCode: s.userCode }),
});

window.copilotDeviceFlow = (el, done) => afDeviceFlow(el, done, {
  contacting: 'Contacting GitHub…',
  signInHint: ' and sign in to GitHub',
  startPath: '/api/copilot/device',
  pollPath: '/api/copilot/device/poll',
  pollBody: (s) => ({ deviceCode: s.deviceCode }),
});

window.claudeOauthFlow = (el, done) => afPasteFlow(el, done, {
  startPath: '/api/claude/oauth/start',
  finishPath: '/api/claude/oauth/finish',
  openLabel: 'Open claude.ai',
  step1: ', sign in, and approve access',
  step2: 'Claude shows an authorization code — copy it and paste it below',
  inputId: 'claude-oauth-code',
  inputLabel: 'Authorization code',
  placeholder: 'code#state',
  emptyError: 'Paste the code Claude showed you after approving.',
  finishBody: (v) => ({ code: v }),
});

window.wranglerOauthFlow = (el, done) => afPasteFlow(el, done, {
  startPath: '/api/wrangler/oauth/start',
  finishPath: '/api/wrangler/oauth/finish',
  openLabel: 'Open the Cloudflare dashboard',
  step1: ' and allow Wrangler access',
  step2: 'Your browser then lands on a localhost page that will not load — that is expected. ' +
    'Copy the full address from the address bar and paste it below',
  inputId: 'wrangler-callback-url',
  inputLabel: 'Address your browser was sent to',
  placeholder: 'http://localhost:8976/oauth/callback?code=…',
  emptyError: 'Paste the localhost address from your browser.',
  finishBody: (v) => ({ callbackUrl: v }),
});
`;
