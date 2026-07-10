/**
 * Inline JS driving the "Sign in with ChatGPT" device-code flow, shared by the
 * onboarding wizard and the dashboard. Exposes window.codexDeviceFlow(el, done):
 * renders the one-time code into `el`, polls the Worker until the user approves
 * at auth.openai.com, then calls `done()`. window.cxActive is true while a flow
 * is on screen so periodic re-renders know not to wipe it.
 */
export const CODEX_DEVICE_JS = `
const cxEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function cxApi(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('request failed: ' + res.status));
  return json;
}
window.cxActive = false;
window.codexDeviceFlow = async (el, done) => {
  window.cxActive = true;
  const fail = (msg) => { window.cxActive = false; el.innerHTML = '<p class="err">' + cxEsc(msg) + '</p>'; };
  el.innerHTML = '<p class="muted"><span class="spinner"></span>Contacting OpenAI…</p>';
  let start;
  try { start = await cxApi('/api/codex/device'); } catch (e) { return fail(e.message); }
  el.innerHTML =
    '<ol style="margin:0.6rem 0 0.6rem 1.2rem">' +
    '<li>Open <a href="' + cxEsc(start.verificationUrl) + '" target="_blank" rel="noreferrer">' +
      cxEsc(start.verificationUrl) + '</a> and sign in to ChatGPT</li>' +
    '<li>Enter this one-time code (expires in 15 minutes)</li></ol>' +
    '<pre class="ssh">' + cxEsc(start.userCode) + '</pre>' +
    '<p class="muted"><span class="spinner"></span>Waiting for approval…</p>';
  const deadline = Date.now() + start.expiresInSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (start.intervalSec || 5) * 1000));
    let poll;
    try {
      poll = await cxApi('/api/codex/device/poll',
        { deviceAuthId: start.deviceAuthId, userCode: start.userCode });
    } catch (e) { return fail(e.message); }
    if (poll.status === 'connected') { window.cxActive = false; done(); return; }
  }
  fail('The code expired — click Sign in with ChatGPT to get a new one.');
};
`;
