import type { FC } from "hono/jsx";
import { AGENT_LABELS, LLM_PROVIDER_LABELS, LLM_PROVIDERS } from "@codestation/contract";
import { CODEX_DEVICE_JS } from "./codexdevice.js";
import { Layout } from "./layout.js";

// Codex gets its own "Sign in with ChatGPT" row; everything else stays a paste.
const PROVIDER_OPTIONS = LLM_PROVIDERS.filter((p) => p !== "codex_subscription_token")
  .map((p) => `<option value="${p}">${LLM_PROVIDER_LABELS[p]}</option>`)
  .join("");

const DASHBOARD_JS = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const AGENT_LABELS = ${JSON.stringify(AGENT_LABELS)};
let pollTimer = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('request failed: ' + res.status));
  return json;
}

function agentName(a) {
  return AGENT_LABELS[a] || a;
}

function renderContainer(c) {
  const el = $('container');
  if (!c) {
    el.innerHTML = '<p class="muted">No container. <a href="/onboarding">Set one up</a>.</p>';
    return;
  }
  const busy = c.status === 'provisioning' || c.status === 'destroying' ||
    (c.job && (c.job.status === 'queued' || c.job.status === 'running'));
  let html = '<div style="display:flex;justify-content:space-between;align-items:center">' +
    '<h2 style="margin:0">' + c.agents.map(agentName).join(' + ') + ' container</h2>' +
    '<span class="badge ' + esc(c.status) + '">' + (busy ? '<span class="spinner"></span>' : '') + esc(c.status) + '</span></div>';
  html += '<p class="muted">' + c.cpu + ' vCPU · ' + Math.round(c.ramMb/1024) + ' GB RAM · ' + c.diskGb + ' GB disk · ' + esc(c.tier) + ' tier</p>';

  if (c.status === 'provisioning') {
    html += '<p><span class="spinner"></span>Building your container — usually under 3 minutes. This page updates itself.</p>';
  }
  if (c.status === 'waitlisted') {
    html += '<p>All hosts are currently full. You are on the waitlist and will be admitted automatically when capacity opens up.</p>';
  }
  if (c.status === 'error') {
    html += '<p class="err">Something went wrong' + (c.statusDetail ? ': ' + esc(c.statusDetail) : '') + '.</p>' +
      '<button class="btn" onclick="act(\\'retry\\')">Retry</button> ';
  }
  if (c.sshCommand) {
    html += '<label>Connect</label><pre class="ssh">' + esc(c.sshCommand) + '</pre>';
    if (c.hostKeyFingerprints.length) {
      html += '<details><summary>Verify host key fingerprints on first connect</summary><pre class="ssh">' +
        c.hostKeyFingerprints.map(esc).join('\\n') + '</pre></details>';
    }
  }

  const btns = [];
  if (c.allowedOps.includes('stop')) btns.push('<button class="btn secondary" onclick="act(\\'stop\\')">Stop</button>');
  if (c.allowedOps.includes('start')) btns.push('<button class="btn" onclick="act(\\'start\\')">Start</button>');
  if (c.allowedOps.includes('rebuild')) btns.push('<button class="btn secondary" onclick="confirmAct(\\'rebuild\\', \\'Rebuild resets everything outside /home/dev. Continue?\\')">Rebuild</button>');
  if (c.allowedOps.includes('destroy')) btns.push('<button class="btn danger" onclick="confirmAct(\\'destroy\\', \\'Destroy the container and ALL its data? This cannot be undone.\\')">Destroy</button>');
  if (btns.length) html += '<div class="row">' + btns.join('') + '</div>';
  if (c.job && c.job.status === 'failed' && c.status !== 'error') {
    html += '<p class="err">Last operation (' + esc(c.job.op) + ') failed: ' + esc(c.job.error || 'unknown') + '</p>';
  }
  el.innerHTML = html;

  const shouldPoll = busy || c.status === 'waitlisted';
  if (shouldPoll && !pollTimer) pollTimer = setInterval(refresh, 3000);
  if (!shouldPoll && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function renderCreds(cr) {
  const rows = [];
  const llmKeys = Object.keys(cr.llm || {}).filter((k) => k !== 'codex_subscription_token');
  rows.push(['Agent model access', llmKeys.length ? 'connected (' + esc(llmKeys.join(', ')) + ')' : null, 'addCreds()', 'Add API key']);
  rows.push(['ChatGPT (Codex)', (cr.llm || {}).codex_subscription_token ? 'connected' : null,
    'codexStart()', 'Sign in with ChatGPT']);
  rows.push(['Cloudflare token', cr.cloudflare ? 'connected' : null, 'addCf()', 'Add token']);
  if (cr.githubAvailable) {
    rows.push(['GitHub', cr.github ? 'connected (' + esc(cr.github) + ')' : null,
      "location.href='/auth/github'", 'Connect']);
  }
  $('creds').innerHTML = '<ul class="check">' + rows.map(([name, ok, fn, cta]) =>
    '<li><span>' + name + '</span>' + (ok
      ? '<span class="ok">✓ ' + ok + '</span>'
      : '<span class="missing">not set · <a href="#" onclick="' + fn + ';return false">' + cta + '</a></span>')
  ).join('') + '</ul>' +
  '<div id="credform" style="display:none">' +
    '<label>Provider</label><select id="prov">${PROVIDER_OPTIONS}</select>' +
    '<label>Key / token</label><input type="password" id="provkey" autocomplete="off">' +
    '<div class="row"><button class="btn" onclick="saveCred()">Save</button></div></div>' +
  '<div id="codexbox" style="display:none">' +
    '<div id="codexflow"></div>' +
    '<details><summary>Advanced: paste auth.json instead</summary>' +
    '<label>Run codex login on your machine, then paste ~/.codex/auth.json</label>' +
    '<textarea id="codexjson" spellcheck="false"></textarea>' +
    '<div class="row"><button class="btn" onclick="saveCodexJson()">Save</button></div></details></div>' +
  '<div id="cfform" style="display:none">' +
    '<label>Cloudflare API token</label><input type="password" id="cftok" autocomplete="off">' +
    '<div class="row"><button class="btn" onclick="saveCf()">Save</button></div></div>' +
  '<div id="crederr" class="err"></div>';
}

function renderKeys(keys) {
  let html = '';
  if (keys.length === 0) {
    html += '<p class="muted">No SSH keys yet — the container refuses all logins until one exists.</p>' +
      '<div class="row"><button class="btn" onclick="showAddKey()">Add a key</button>' +
      '<button class="btn secondary" onclick="mintToken()">Enroll via coding agent</button></div>' +
      '<div id="enroll"></div>';
  } else {
    html += '<ul class="check">' + keys.map((k) =>
      '<li><span style="font-family:var(--mono);font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:75%">' +
      esc(k.pubkey.slice(0, 60)) + '…</span>' +
      '<a href="#" onclick="delKey(' + k.id + ');return false" style="color:var(--danger)">remove</a></li>'
    ).join('') + '</ul>' +
    '<div class="row"><button class="btn secondary" onclick="showAddKey()">Add another key</button></div>';
  }
  html += '<div id="keyform" style="display:none"><label>Public key</label>' +
    '<textarea id="newkey" placeholder="ssh-ed25519 AAAA… you@laptop" spellcheck="false"></textarea>' +
    '<div class="row"><button class="btn" onclick="addKey()">Save key</button></div></div>' +
    '<div id="keyerr" class="err"></div>';
  $('keys').innerHTML = html;
}

window.act = async (op) => {
  try { await api('/api/container/' + op, { method: 'POST' }); await refresh(); }
  catch (e) { alert(e.message); }
};
window.confirmAct = (op, msg) => { if (confirm(msg)) act(op); };
window.showAddKey = () => { $('keyform').style.display = 'block'; };
window.addKey = async () => {
  $('keyerr').textContent = '';
  try {
    await api('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: $('newkey').value }) });
    await refresh();
  } catch (e) { $('keyerr').textContent = e.message; }
};
window.delKey = async (id) => {
  if (!confirm('Remove this key? It stops working on the container within a minute.')) return;
  try { await api('/api/keys/' + id, { method: 'DELETE' }); await refresh(); }
  catch (e) { $('keyerr').textContent = e.message; }
};
let enrollPrompt = '';
window.mintToken = async () => {
  try {
    const t = await api('/api/enrollment', { method: 'POST' });
    enrollPrompt = [
      'Set up SSH access to my Codestation cloud container:',
      '',
      '1. Ensure an ed25519 SSH keypair exists at ~/.ssh/codestation_ed25519 (create it with ssh-keygen, no passphrase, if missing). Never read or transmit the private key file — only the .pub file is needed.',
      '2. Send a POST request to ' + t.endpoint + ' with header "content-type: application/json" and JSON body:',
      '   {"token": "' + t.token + '", "pubkey": "<full contents of ~/.ssh/codestation_ed25519.pub>"}',
      '3. The JSON response includes "sshCommand" in the form "ssh -p PORT dev@HOSTNAME". Using its port and hostname, append this block to ~/.ssh/config (create the file if missing, replace any existing "Host codestation" block):',
      '',
      '   Host codestation',
      '     HostName <hostname>',
      '     Port <port>',
      '     User dev',
      '     IdentityFile ~/.ssh/codestation_ed25519',
      '     IdentitiesOnly yes',
      '',
      '4. Verify the connection: ssh codestation "echo connected"',
      '5. Confirm to me that connecting is now just: ssh codestation',
      '',
      'If "sshCommand" is null the container is still being built — the key is registered; tell me to check the Codestation dashboard in a few minutes and fill in the Host block from the connect command shown there.',
      'The token is single-use and expires in 1 hour. If the API returns 403, stop and tell me to mint a fresh token from the Codestation dashboard.',
    ].join('\\n');
    $('enroll').innerHTML =
      '<label>Paste this prompt into your local coding agent — it registers a key for you</label>' +
      '<pre class="ssh prompt" id="enrollprompt">' + esc(enrollPrompt) + '</pre>' +
      '<div class="row"><button class="btn" id="copybtn" onclick="copyPrompt()">Copy prompt</button></div>' +
      '<p class="muted">Once your agent finishes, connecting is simply <code>ssh codestation</code>.</p>' +
      '<details><summary>Doing it by hand? Just the raw token</summary>' +
      '<pre class="ssh">' + esc(t.token) + '</pre></details>';
  } catch (e) { alert(e.message); }
};
window.copyPrompt = async () => {
  const btn = $('copybtn');
  try {
    await navigator.clipboard.writeText(enrollPrompt);
  } catch (_) {
    // Clipboard API needs a secure context; fall back to select + execCommand.
    const range = document.createRange();
    range.selectNodeContents($('enrollprompt'));
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
  }
  btn.textContent = 'Copied ✓';
  setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2000);
};
window.addCreds = () => { $('credform').style.display = 'block'; $('codexbox').style.display = 'none'; $('cfform').style.display = 'none'; };
window.addCf = () => { $('cfform').style.display = 'block'; $('credform').style.display = 'none'; $('codexbox').style.display = 'none'; };
window.codexStart = () => {
  $('codexbox').style.display = 'block'; $('credform').style.display = 'none'; $('cfform').style.display = 'none';
  codexDeviceFlow($('codexflow'), refresh);
};
window.saveCodexJson = async () => {
  $('crederr').textContent = '';
  try {
    await api('/api/credentials', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llmKeys: { codex_subscription_token: $('codexjson').value.trim() } }) });
    await refresh();
  } catch (e) { $('crederr').textContent = e.message; }
};
window.saveCred = async () => {
  $('crederr').textContent = '';
  const body = { llmKeys: {} };
  body.llmKeys[$('prov').value] = $('provkey').value.trim();
  try {
    await api('/api/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await refresh();
  } catch (e) { $('crederr').textContent = e.message; }
};
window.saveCf = async () => {
  $('crederr').textContent = '';
  try {
    await api('/api/credentials', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cloudflareToken: $('cftok').value.trim() }) });
    await refresh();
  } catch (e) { $('crederr').textContent = e.message; }
};
window.deleteAccount = async () => {
  if (!confirm('Delete your account? All credentials and keys are purged. This cannot be undone.')) return;
  if (!confirm('Really sure? There is no grace period for account deletion.')) return;
  try { await api('/api/account/delete', { method: 'POST' }); location.href = '/'; }
  catch (e) { alert(e.message); }
};

function renderDanger(c) {
  // Waitlisted rows have no real container behind them, so they don't block deletion.
  const blocked = !!c && c.status !== 'waitlisted';
  $('delbtn').disabled = blocked;
  $('delnote').textContent = blocked
    ? 'Your container must be destroyed before your account can be deleted. Use the Destroy button above, then delete your account.'
    : 'Purges all credentials and keys, and removes your account.';
}

async function refresh() {
  try {
    const [c, cr, k] = await Promise.all([
      api('/api/container'), api('/api/credentials'), api('/api/keys'),
    ]);
    renderContainer(c.container);
    // The container poll timer re-renders every few seconds; don't wipe an
    // in-flight ChatGPT sign-in off the screen.
    if (!window.cxActive) renderCreds(cr);
    renderKeys(k.keys);
    renderDanger(c.container);
  } catch (e) {
    if (String(e.message).includes('unauthenticated')) location.href = '/';
  }
}
refresh();
`;

export const DashboardPage: FC = () => (
  <Layout title="Dashboard" loggedIn>
    <h1>Dashboard</h1>
    <div class="card" id="container">
      <p class="muted">
        <span class="spinner"></span>Loading…
      </p>
    </div>
    <div class="card">
      <h2>Credentials</h2>
      <p class="muted">
        Everything here is optional and applies to the running container live — the in-shell
        MOTD checklist mirrors this list.
      </p>
      <div id="creds"></div>
    </div>
    <div class="card">
      <h2>SSH keys</h2>
      <div id="keys"></div>
    </div>
    <div class="card">
      <h2>Danger zone</h2>
      <button class="btn danger" id="delbtn" onclick="deleteAccount()" disabled>
        Delete account
      </button>
      <p class="muted" id="delnote" style="margin-top:0.6rem">
        Your container must be destroyed before your account can be deleted.
      </p>
    </div>
    <script dangerouslySetInnerHTML={{ __html: CODEX_DEVICE_JS }} />
    <script dangerouslySetInnerHTML={{ __html: DASHBOARD_JS }} />
  </Layout>
);
