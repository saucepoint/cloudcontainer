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
const PROVIDER_LABELS = ${JSON.stringify(LLM_PROVIDER_LABELS)};
const STATUS_LABELS = {
  waitlisted: 'Waiting for capacity', provisioning: 'Building', running: 'Ready',
  stopped: 'Stopped', suspended: 'Suspended', upgrade_pending: 'Upgrade pending',
  error: 'Needs attention', destroying: 'Deleting',
};
const KEY_HELP = 'ssh-keygen -t ed25519\\ncat ~/.ssh/id_ed25519.pub';
let pollTimer = null;
let pollInFlight = false;
let actionInFlight = false;
let statusRefreshNeeded = false;
let currentContainer = null;
let knownKeys = [];
let currentSshCommand = '';
let enrollPrompt = '';

async function api(path, opts) {
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('request failed: ' + res.status));
  return json;
}

function agentName(a) {
  return AGENT_LABELS[a] || a;
}

function providerName(p) {
  return PROVIDER_LABELS[p] || p;
}

function errorMessage(error, fallback) {
  const message = error && error.message ? error.message : '';
  return message && message !== 'internal error' ? message : fallback;
}

function redirectIfSignedOut(error) {
  if (String(error && error.message).includes('unauthenticated')) {
    location.href = '/';
    return true;
  }
  return false;
}

function showPageError(message) {
  $('page-error-message').textContent = message;
  $('page-error').hidden = !message;
}

function showActionError(message) {
  $('action-error').textContent = message;
  $('action-error').hidden = !message;
}

function showKeyError(message) {
  const el = $('keyerr');
  if (el) el.textContent = message || '';
}

function showCredentialError(message) {
  const el = $('crederr');
  if (el) el.textContent = message || '';
}

function setButtonBusy(btn, label) {
  if (!btn) return () => {};
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + esc(label);
  return () => {
    if (!btn.isConnected) return;
    btn.disabled = false;
    btn.innerHTML = original;
  };
}

function setContainerButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll('[data-container-action]')) {
    button.disabled = disabled;
  }
}

function isBusy(c) {
  return !!c && (c.status === 'provisioning' || c.status === 'destroying' ||
    (c.job && (c.job.status === 'queued' || c.job.status === 'running')));
}

function pollDelay(c) {
  if (!c) return null;
  if (c.status === 'waitlisted') return 30000;
  if (isBusy(c)) return 5000;
  return null;
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll(c) {
  stopPolling();
  const delay = statusRefreshNeeded ? 5000 : pollDelay(c);
  if (delay === null || document.hidden) return;
  pollTimer = setTimeout(pollContainer, delay);
}

function renderContainer(c) {
  const el = $('container');
  if (!c) {
    el.setAttribute('aria-busy', 'false');
    el.innerHTML = '<h2>No coding server yet</h2>' +
      '<p class="muted">Create one to get a ready-to-use Debian environment.</p>' +
      '<a class="btn" href="/onboarding">Set one up</a>';
    return;
  }

  const busy = isBusy(c);
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
  const statusLabel = STATUS_LABELS[c.status] || c.status;
  let html = '<div class="card-head"><h2>' + c.agents.map(agentName).join(' + ') +
    ' server</h2><span class="badge ' + esc(c.status) + '" aria-label="Container status: ' +
    esc(statusLabel) + '">' + (busy ? '<span class="spinner" aria-hidden="true"></span>' : '') +
    esc(statusLabel) + '</span></div>';
  html += '<p class="muted">' + c.cpu + ' vCPU · ' + Math.round(c.ramMb / 1024) +
    ' GB RAM · ' + c.diskGb + ' GB home + ' + (c.rootDiskGb || c.diskGb) +
    ' GB system disk · ' + esc(c.tier) + ' tier</p>';

  if (c.status === 'provisioning') {
    html += '<p><span class="spinner" aria-hidden="true"></span>Building your coding server — usually under 3 minutes. You can safely leave this page.</p>';
  } else if (c.status === 'waitlisted') {
    html += '<p>Every host is full right now. Your place is saved and this page checks for capacity automatically.</p>';
  } else if (c.status === 'stopped') {
    html += '<p>Your files are safe, but SSH is unavailable until you start the server.</p>';
  } else if (c.status === 'suspended') {
    html += '<p class="notice error">This server is suspended. Your files are not currently accessible.</p>';
  } else if (c.status === 'upgrade_pending') {
    html += '<p class="notice warning">Your upgrade is waiting for host capacity. No action is needed.</p>';
  } else if (c.status === 'destroying') {
    html += '<p><span class="spinner" aria-hidden="true"></span>Deleting the server and its data…</p>';
  } else if (c.status === 'error') {
    html += '<p class="notice error">The last operation did not finish successfully.</p>';
    if (c.statusDetail) {
      html += '<details><summary>Technical details</summary><pre class="ssh prompt">' + esc(c.statusDetail) + '</pre></details>';
    }
    html += '<button type="button" class="btn" data-container-action onclick="act(\\'retry\\', this)">Try again</button>';
  }

  const operations = c.allowedOps || [];
  const buttons = [];
  if (operations.includes('stop')) buttons.push('<button type="button" class="btn secondary" data-container-action onclick="act(\\'stop\\', this)">Stop</button>');
  if (operations.includes('start')) buttons.push('<button type="button" class="btn" data-container-action onclick="act(\\'start\\', this)">Start</button>');
  if (operations.includes('rebuild')) buttons.push('<button type="button" class="btn secondary" data-container-action onclick="confirmAct(\\'rebuild\\', \\'Rebuild resets everything outside /home/dev. Continue?\\', this)">Rebuild</button>');
  if (operations.includes('destroy')) buttons.push('<button type="button" class="btn danger" data-container-action onclick="confirmAct(\\'destroy\\', \\'Destroy the server and ALL its data? This cannot be undone.\\', this)">Destroy</button>');
  if (buttons.length) html += '<div class="row">' + buttons.join('') + '</div>';
  if (c.job && c.job.status === 'failed' && c.status !== 'error') {
    html += '<p class="notice error">Last operation (' + esc(c.job.op) + ') failed: ' + esc(c.job.error || 'unknown error') + '</p>';
  }
  el.innerHTML = html;
}

function renderConnection(c) {
  const el = $('connection');
  currentSshCommand = c && c.sshCommand ? c.sshCommand : '';
  if (!c) {
    el.innerHTML = '<p class="muted">Connection details appear after you create a server.</p>';
    return;
  }
  if (c.sshCommand) {
    let html = '<p><strong>Run this in your terminal</strong></p>' +
      '<div class="command-row"><pre class="ssh">' + esc(c.sshCommand) + '</pre>' +
      '<button type="button" class="btn secondary" onclick="copySsh(this)">Copy SSH command</button></div>';
    if (knownKeys.length === 0) {
      html += '<p class="notice warning"><strong>One more step:</strong> add an SSH key below before this command can connect.</p>';
    }
    const fingerprints = c.hostKeyFingerprints || [];
    if (fingerprints.length) {
      html += '<details><summary>Verify this server on your first connection</summary>' +
        '<p class="muted">SSH may ask whether you trust this host. The fingerprint it shows must match one below.</p>' +
        '<pre class="ssh">' + fingerprints.map(esc).join('\\n') + '</pre></details>';
    }
    el.innerHTML = html;
    return;
  }
  if (c.status === 'stopped') {
    el.innerHTML = '<p class="muted">Start the server to see its SSH command.</p>';
  } else if (c.status === 'provisioning' || c.status === 'waitlisted') {
    el.innerHTML = '<p class="muted">Your SSH command will appear here when the server is ready. You can set up your key now.</p>';
  } else {
    el.innerHTML = '<p class="muted">SSH is not available in the current server state.</p>';
  }
}

function applyContainer(c) {
  currentContainer = c;
  renderContainer(c);
  renderConnection(c);
  renderDanger(c);
}

function renderCreds(cr) {
  const rows = [];
  const llmKeys = Object.keys(cr.llm || {}).filter((k) => k !== 'codex_subscription_token');
  const llmStatus = llmKeys.length ? 'connected (' + llmKeys.map(providerName).join(', ') + ')' : null;
  rows.push(['Agent model access', llmStatus, 'addCreds()', 'Add API key']);
  rows.push(['ChatGPT (Codex)', (cr.llm || {}).codex_subscription_token ? 'connected' : null,
    'codexStart()', 'Sign in with ChatGPT']);
  rows.push(['Cloudflare token', cr.cloudflare ? 'connected' : null, 'addCf()', 'Add token']);
  if (cr.githubAvailable) {
    rows.push(['GitHub', cr.github ? 'connected (' + cr.github + ')' : null,
      "location.href='/auth/github'", 'Connect']);
  }
  $('creds').innerHTML = '<ul class="check">' + rows.map(([name, ok, fn, cta]) =>
    '<li><span>' + esc(name) + '</span>' + (ok
      ? '<span><span class="ok">✓ ' + esc(ok) + '</span> · ' +
        '<button type="button" class="link-btn" onclick="' + fn + '">Update</button></span>'
      : '<span class="missing">not set · <button type="button" class="link-btn" onclick="' + fn + '">' + esc(cta) + '</button></span>')
  ).join('') + '</ul>' +
  '<div id="credform" hidden>' +
    '<label for="prov">Provider</label><select id="prov">${PROVIDER_OPTIONS}</select>' +
    '<label for="provkey">Key or token</label><input type="password" id="provkey" autocomplete="off">' +
    '<p class="muted">Save an empty value to remove the selected managed credential.</p>' +
    '<div class="row"><button type="button" class="btn" onclick="saveCred(this)">Save</button></div></div>' +
  '<div id="codexbox" hidden>' +
    '<div id="codexflow" role="status" aria-live="polite"></div>' +
    '<details><summary>Advanced: paste auth.json instead</summary>' +
    '<label for="codexjson">Run codex login on your machine, then paste ~/.codex/auth.json</label>' +
    '<textarea id="codexjson" spellcheck="false"></textarea>' +
    '<div class="row"><button type="button" class="btn" onclick="saveCodexJson(this)">Save</button></div></details></div>' +
  '<div id="cfform" hidden>' +
    '<label for="cftok">Cloudflare API token</label><input type="password" id="cftok" autocomplete="off">' +
    '<p class="muted">Use a narrowly scoped token. Save an empty value to remove it.</p>' +
    '<div class="row"><button type="button" class="btn" onclick="saveCf(this)">Save</button></div></div>' +
  '<div id="crederr" class="err" role="alert" aria-live="assertive"></div>';
}

function renderKeys(keys) {
  knownKeys = Array.isArray(keys) ? keys : [];
  let html = '';
  if (knownKeys.length === 0) {
    html += '<p class="notice warning"><strong>SSH is locked until you add a public key.</strong> The guided option lets your local coding agent do this for you.</p>';
  } else {
    html += '<ul class="check">' + knownKeys.map((key) =>
      '<li><span style="font-family:var(--mono);font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:75%">' +
      esc(key.pubkey.slice(0, 60)) + '…</span>' +
      '<button type="button" class="link-btn" style="color:var(--danger)" onclick="delKey(' + key.id + ', this)">Remove</button></li>'
    ).join('') + '</ul>';
  }
  html += '<div class="row">' +
    '<button type="button" class="btn" onclick="mintToken(this)">' +
      (knownKeys.length ? 'Enroll another device with my agent' : 'Set up SSH with my coding agent') + '</button>' +
    '<button type="button" class="btn secondary" onclick="showAddKey()">' +
      (knownKeys.length ? 'Add another key manually' : 'Add a key manually') + '</button></div>' +
    '<div id="enroll"></div>' +
    '<div id="keyform" hidden>' +
      '<p class="muted">First create a key if needed, then print the public half:</p>' +
      '<div class="command-row"><pre class="ssh">ssh-keygen -t ed25519\\ncat ~/.ssh/id_ed25519.pub</pre>' +
      '<button type="button" class="btn secondary" onclick="copyKeyCommands(this)">Copy commands</button></div>' +
      '<p class="muted">Paste only the output from the <code>.pub</code> file. Never paste your private key.</p>' +
      '<label for="newkey">SSH public key</label>' +
      '<textarea id="newkey" placeholder="ssh-ed25519 AAAA… you@laptop" spellcheck="false"></textarea>' +
      '<div class="row"><button type="button" class="btn" onclick="addKey(this)">Save key</button></div></div>' +
    '<div id="keyerr" class="err" role="alert" aria-live="assertive"></div>';
  $('keys').innerHTML = html;
  renderConnection(currentContainer);
}

async function copyValue(value, btn, restoredLabel) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (_) {
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  const old = btn.textContent;
  btn.textContent = 'Copied ✓';
  $('copy-status').textContent = 'Copied to clipboard.';
  setTimeout(() => { if (btn.isConnected) btn.textContent = restoredLabel || old; }, 2000);
}

window.copySsh = (btn) => copyValue(currentSshCommand, btn, 'Copy SSH command');
window.copyPrompt = (btn) => copyValue(enrollPrompt, btn, 'Copy prompt');
window.copyKeyCommands = (btn) => copyValue(KEY_HELP, btn, 'Copy commands');

async function pollContainer() {
  pollTimer = null;
  if (pollInFlight || document.hidden) return;
  pollInFlight = true;
  try {
    const result = await api('/api/container');
    statusRefreshNeeded = false;
    applyContainer(result.container);
    showActionError('');
  } catch (error) {
    if (!redirectIfSignedOut(error)) {
      showActionError('Could not refresh the server status. We will try again automatically.');
    }
  } finally {
    pollInFlight = false;
    schedulePoll(currentContainer);
  }
}

window.act = async (op, btn) => {
  if (actionInFlight) return;
  actionInFlight = true;
  showActionError('');
  setContainerButtonsDisabled(true);
  const restore = setButtonBusy(btn, 'Working…');
  try {
    await api('/api/container/' + op, { method: 'POST' });
    statusRefreshNeeded = true;
    const result = await api('/api/container');
    statusRefreshNeeded = false;
    applyContainer(result.container);
    schedulePoll(result.container);
  } catch (error) {
    if (!redirectIfSignedOut(error)) {
      showActionError(statusRefreshNeeded
        ? 'The action started, but its latest status is unavailable. We will try again automatically.'
        : errorMessage(error, 'That action did not complete. Please try again.'));
      if (statusRefreshNeeded) {
        schedulePoll(currentContainer);
      } else {
        restore();
        setContainerButtonsDisabled(false);
      }
    }
  } finally {
    actionInFlight = false;
  }
};

window.confirmAct = (op, message, btn) => {
  if (confirm(message)) act(op, btn);
};

window.showAddKey = () => {
  $('keyform').hidden = false;
  $('newkey').focus();
};

window.refreshKeys = async (btn) => {
  const restore = setButtonBusy(btn, 'Refreshing…');
  showKeyError('');
  try {
    const result = await api('/api/keys');
    renderKeys(result.keys);
  } catch (error) {
    showKeyError(errorMessage(error, 'Could not refresh SSH keys.'));
    restore();
  }
};

window.addKey = async (btn) => {
  const restore = setButtonBusy(btn, 'Saving…');
  showKeyError('');
  try {
    await api('/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: $('newkey').value }) });
    const result = await api('/api/keys');
    renderKeys(result.keys);
  } catch (error) {
    showKeyError(errorMessage(error, 'Could not save that SSH key.'));
    restore();
  }
};

window.delKey = async (id, btn) => {
  if (!confirm('Remove this key? It stops working on the server within a minute.')) return;
  const restore = setButtonBusy(btn, 'Removing…');
  showKeyError('');
  try {
    await api('/api/keys/' + id, { method: 'DELETE' });
    const result = await api('/api/keys');
    renderKeys(result.keys);
  } catch (error) {
    showKeyError(errorMessage(error, 'Could not remove that SSH key.'));
    restore();
  }
};

window.mintToken = async (btn) => {
  const restore = setButtonBusy(btn, 'Creating prompt…');
  showKeyError('');
  try {
    const token = await api('/api/enrollment', { method: 'POST' });
    enrollPrompt = [
      'Set up SSH access to my Codestation cloud container:',
      '',
      '1. Ensure an ed25519 SSH keypair exists at ~/.ssh/codestation_ed25519 (create it with ssh-keygen, no passphrase, if missing). Never read or transmit the private key file — only the .pub file is needed.',
      '2. Send a POST request to ' + token.endpoint + ' with header "content-type: application/json" and JSON body:',
      '   {"token": "' + token.token + '", "pubkey": "<full contents of ~/.ssh/codestation_ed25519.pub>"}',
      '3. The JSON response includes "sshCommand" in the form "ssh -p PORT dev@HOSTNAME". Using its port and hostname, append this block to ~/.ssh/config (replace any existing "Host codestation" block):',
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
      'If "sshCommand" is null the server is still being built — the key is registered. Tell me to check the dashboard in a few minutes.',
      'The token is single-use and expires in 1 hour. If the API returns 403, stop and tell me to mint a fresh token.',
    ].join('\\n');
    $('enroll').innerHTML =
      '<div class="notice"><strong>Paste this prompt into your local coding agent</strong>' +
      '<p class="muted">It creates a dedicated key, registers only the public half, and configures the short command <code>ssh codestation</code>.</p></div>' +
      '<pre class="ssh prompt" id="enrollprompt">' + esc(enrollPrompt) + '</pre>' +
      '<div class="row"><button type="button" class="btn" onclick="copyPrompt(this)">Copy prompt</button>' +
      '<button type="button" class="btn secondary" onclick="refreshKeys(this)">I finished — refresh keys</button></div>' +
      '<details><summary>Doing it by hand? Show the one-time token</summary>' +
      '<pre class="ssh">' + esc(token.token) + '</pre></details>';
  } catch (error) {
    showKeyError(errorMessage(error, 'Could not create an enrollment prompt. Please try again.'));
  } finally {
    restore();
  }
};

window.addCreds = () => {
  $('credform').hidden = false;
  $('codexbox').hidden = true;
  $('cfform').hidden = true;
  $('prov').focus();
};

window.addCf = () => {
  $('cfform').hidden = false;
  $('credform').hidden = true;
  $('codexbox').hidden = true;
  $('cftok').focus();
};

async function refreshCreds() {
  const result = await api('/api/credentials');
  renderCreds(result);
}

window.codexStart = () => {
  if (window.cxActive) return;
  $('codexbox').hidden = false;
  $('credform').hidden = true;
  $('cfform').hidden = true;
  codexDeviceFlow($('codexflow'), refreshCreds);
};

window.saveCodexJson = async (btn) => {
  const restore = setButtonBusy(btn, 'Saving…');
  showCredentialError('');
  try {
    await api('/api/credentials', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llmKeys: { codex_subscription_token: $('codexjson').value.trim() } }) });
    await refreshCreds();
  } catch (error) {
    showCredentialError(errorMessage(error, 'Could not save the Codex sign-in.'));
    restore();
  }
};

window.saveCred = async (btn) => {
  const restore = setButtonBusy(btn, 'Saving…');
  showCredentialError('');
  const body = { llmKeys: {} };
  body.llmKeys[$('prov').value] = $('provkey').value.trim();
  try {
    await api('/api/credentials', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await refreshCreds();
  } catch (error) {
    showCredentialError(errorMessage(error, 'Could not save that credential.'));
    restore();
  }
};

window.saveCf = async (btn) => {
  const restore = setButtonBusy(btn, 'Saving…');
  showCredentialError('');
  try {
    await api('/api/credentials', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cloudflareToken: $('cftok').value.trim() }) });
    await refreshCreds();
  } catch (error) {
    showCredentialError(errorMessage(error, 'Could not save that Cloudflare token.'));
    restore();
  }
};

window.deleteAccount = async (btn) => {
  if (!confirm('Delete your account? All credentials and keys are purged. This cannot be undone.')) return;
  if (!confirm('Really sure? There is no grace period for account deletion.')) return;
  const restore = setButtonBusy(btn, 'Deleting…');
  showActionError('');
  try {
    await api('/api/account/delete', { method: 'POST' });
    location.href = '/';
  } catch (error) {
    showActionError(errorMessage(error, 'Could not delete the account.'));
    restore();
  }
};

function renderDanger(c) {
  const blocked = !!c && c.status !== 'waitlisted';
  $('delbtn').disabled = blocked;
  $('delnote').textContent = blocked
    ? 'Destroy your server first. When deletion finishes, you can delete the account.'
    : 'Purges all credentials and keys, and removes your account.';
}

window.loadDashboard = async (btn) => {
  stopPolling();
  showPageError('');
  showActionError('');
  const restore = setButtonBusy(btn, 'Loading…');
  try {
    const snapshot = await api('/api/dashboard');
    statusRefreshNeeded = false;
    knownKeys = Array.isArray(snapshot.keys) ? snapshot.keys : [];
    renderCreds(snapshot.credentials);
    renderKeys(knownKeys);
    applyContainer(snapshot.container);
    schedulePoll(snapshot.container);
  } catch (error) {
    if (!redirectIfSignedOut(error)) {
      $('container').setAttribute('aria-busy', 'false');
      $('container').innerHTML = '<h2>Dashboard unavailable</h2><p class="muted">Your server has not been changed.</p>';
      showPageError(errorMessage(error, 'We could not load your dashboard. Check your connection and try again.'));
    }
    restore();
  }
};

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else if (statusRefreshNeeded || pollDelay(currentContainer) !== null) {
    pollContainer();
  }
});

loadDashboard();
`;

export const DashboardPage: FC = () => (
  <Layout title="Dashboard" loggedIn>
    <h1>Dashboard</h1>
    <div id="page-error" class="notice error" role="alert" aria-live="assertive" hidden>
      <span id="page-error-message"></span>{" "}
      <button type="button" class="link-btn" onclick="loadDashboard(this)">
        Try again
      </button>
    </div>
    <div class="card" id="container" aria-live="polite" aria-busy="true">
      <p class="muted">
        <span class="spinner" aria-hidden="true"></span>Loading your server…
      </p>
    </div>
    <div id="action-error" class="notice error" role="alert" aria-live="assertive" hidden></div>

    <section class="card" aria-labelledby="ssh-heading">
      <h2 id="ssh-heading">SSH access</h2>
      <div id="connection" role="status" aria-live="polite">
        <p class="muted">Loading connection details…</p>
      </div>
      <div id="keys" aria-live="polite"></div>
      <div id="copy-status" class="sr-only" role="status" aria-live="polite"></div>
    </section>

    <section class="card" aria-labelledby="credentials-heading">
      <h2 id="credentials-heading">Optional credentials</h2>
      <p class="muted">
        Add model, GitHub, or Cloudflare access now or later. Updates apply to the running server
        without a restart. Code running in your server can use these credentials, so keep them
        narrowly scoped.
      </p>
      <div id="creds" aria-live="polite"></div>
    </section>

    <section class="card" aria-labelledby="danger-heading">
      <h2 id="danger-heading">Danger zone</h2>
      <button
        type="button"
        class="btn danger"
        id="delbtn"
        onclick="deleteAccount(this)"
        disabled
      >
        Delete account
      </button>
      <p class="muted" id="delnote" style="margin-top:0.6rem">
        Your server must be destroyed before your account can be deleted.
      </p>
    </section>
    <script dangerouslySetInnerHTML={{ __html: CODEX_DEVICE_JS }} />
    <script dangerouslySetInnerHTML={{ __html: DASHBOARD_JS }} />
  </Layout>
);
