import type { FC } from "hono/jsx";
import {
  AGENT_LABELS,
  AGENTS,
  INPUT_LIMITS,
  LLM_PROVIDERS,
  OAUTH_ONLY_LLM_PROVIDERS,
} from "@codestation/contract";
import { AUTH_FLOWS_JS } from "./authflows.js";
import { Layout } from "./layout.js";

/** Providers the wizard form can submit directly; OAuth-only ones are stored
 * server-side the moment their sign-in flow completes. */
const PASTEABLE_PROVIDERS = LLM_PROVIDERS.filter(
  (p) => !(OAUTH_ONLY_LLM_PROVIDERS as readonly string[]).includes(p),
);

const IDKIT_SRC = "https://cdn.jsdelivr.net/npm/@worldcoin/idkit-core@4.2.1/dist/idkit.global.js";
const QRCODE_ESM = "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";
const WORLD_ID_SESSION_KEY = "cs_world_id_session";

const AGENT_GUIDANCE: Record<(typeof AGENTS)[number], string> = {
  pi: "Flexible terminal agent; works with several model providers.",
  claude: "Best if you use Claude Pro/Max or an Anthropic API key.",
  codex: "Easiest start if you already have a ChatGPT plan.",
  opencode: "Open-source interface with broad model-provider support.",
};

const worldIdJs = (environment: "production" | "staging") => `
const btn = document.getElementById('worldid-btn');
const status = document.getElementById('worldid-status');
const qrWrap = document.getElementById('worldid-qr');

async function startWorldIdSignIn() {
  if (typeof IDKit === 'undefined') {
    status.textContent = 'Could not load World ID. Check your connection and reload.';
    return;
  }
  btn.disabled = true;
  status.textContent = 'Connecting to World ID…';
  qrWrap.innerHTML = '';
  try {
    const contextRes = await fetch('/auth/session/rp-context');
    const context = await contextRes.json().catch(() => ({}));
    if (!contextRes.ok) throw new Error(context.error || 'Could not start World ID sign-in.');
    const { app_id, rp_context } = context;
    let savedSessionId = null;
    try { savedSessionId = localStorage.getItem('${WORLD_ID_SESSION_KEY}'); } catch (_) {}
    const config = { app_id, rp_context, environment: '${environment}' };
    const builder = savedSessionId
      ? IDKit.proveSession(savedSessionId, config)
      : IDKit.createSession(config);
    const request = await builder.constraints(IDKit.any(IDKit.CredentialRequest('proof_of_human')));

    if (request.connectorURI) {
      if (/Mobi|Android/i.test(navigator.userAgent)) {
        status.textContent = 'Opening World App…';
        window.location.href = request.connectorURI;
      } else {
        status.textContent = 'Scan with World App';
        const { default: QRCode } = await import('${QRCODE_ESM}');
        const canvas = document.createElement('canvas');
        qrWrap.appendChild(canvas);
        await QRCode.toCanvas(canvas, request.connectorURI, { width: 220, margin: 1 });
      }
    }

    const completion = await request.pollUntilCompletion({ timeout: 180000 });
    if (!completion.success) {
      const messages = {
        timeout: 'Timed out waiting for World App.',
        cancelled: 'Cancelled in World App.',
        user_rejected: 'Cancelled in World App.',
        verification_rejected: 'Cancelled in World App.',
        invalid_network: 'World ID environment mismatch. This site must use production with the real World App.',
        invalid_rp_signature: 'World ID rejected this site’s RP signing key.',
        unknown_rp: 'World ID does not recognize this site’s RP ID.',
        inactive_rp: 'This site’s World ID registration is not active yet.',
        world_id_4_not_available: 'Your World App does not have a World ID 4.0 credential yet.',
        credential_unavailable: 'Your World App does not have the required proof-of-human credential.',
        malformed_request: 'World ID rejected this site’s request configuration.',
        connection_failed: 'The connection to World App was lost. Please try again.',
      };
      throw new Error(messages[completion.error] || ('World ID error: ' + completion.error));
    }

    status.textContent = 'Verifying…';
    qrWrap.innerHTML = '';
    const res = await fetch('/auth/session/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idkitResponse: completion.result }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Sign-in failed.');

    try { localStorage.setItem('${WORLD_ID_SESSION_KEY}', completion.result.session_id); } catch (_) {}
    location.href = json.redirect;
  } catch (e) {
    status.textContent = e.message || 'Something went wrong. Please try again.';
    btn.disabled = false;
  }
}

btn.addEventListener('click', startWorldIdSignIn);
`;

export const LandingPage: FC<{ devAuth: boolean; worldIdEnvironment: "production" | "staging" }> = ({
  devAuth,
  worldIdEnvironment,
}) => (
  <Layout>
    <h1>
      Your ready-to-code cloud server,
      <br />
      set up in minutes.
    </h1>
    <p class="lead">
      Pick a coding agent and we install the Debian environment, developer tools, and secure SSH
      access for you. One World ID-verified human gets one free server.
    </p>
    <div class="card">
      <button id="worldid-btn" class="btn" type="button">
        Sign in with World ID
      </button>
      {devAuth ? (
        <span style="margin-left:0.75rem">
          <a class="btn secondary" href="/auth/dev">
            Dev login
          </a>
        </span>
      ) : null}
      <p id="worldid-status" class="muted" style="margin-top:1rem" role="status" aria-live="polite">
        World ID proves you're a unique human — it's the only signup requirement. No credit
        card, no email.
      </p>
      <div id="worldid-qr" class="qr" role="status" aria-live="polite"></div>
      <script src={IDKIT_SRC}></script>
      <script type="module" dangerouslySetInnerHTML={{ __html: worldIdJs(worldIdEnvironment) }} />
    </div>
    <div class="card">
      <h2>What you get</h2>
      <ul class="check">
        <li>
          Debian 13, 1 vCPU / 2 GB RAM / 8 GB persistent home + 8 GB system disk
          <span class="ok">free</span>
        </li>
        <li>
          Any mix of Pi, Claude Code, Codex, and OpenCode preinstalled
          <span class="ok">✓</span>
        </li>
        <li>
          git, gh, node, python + uv, tmux, ripgrep and friends
          <span class="ok">✓</span>
        </li>
        <li>
          SSH-key access; bring your own LLM API keys
          <span class="ok">✓</span>
        </li>
      </ul>
    </div>
  </Layout>
);

const ONBOARDING_JS = `
const form = document.getElementById('wizard');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('go');
  const err = document.getElementById('err');
  err.textContent = '';
  const data = new FormData(form);
  const llmKeys = {};
  for (const k of ${JSON.stringify(PASTEABLE_PROVIDERS)}) {
    const v = (data.get('llm_' + k) || '').toString().trim();
    if (v) llmKeys[k] = v;
  }
  const body = {
    agents: data.getAll('agent').map((a) => a.toString()),
    sshPubkey: (data.get('sshPubkey') || '').toString().trim(),
    llmKeys,
    cloudflareToken: (data.get('cloudflareToken') || '').toString().trim() || undefined,
    githubRepos: data.getAll('githubRepo').map((repo) => repo.toString()),
  };
  if (body.agents.length === 0) {
    err.textContent = 'Pick at least one agent first.';
    err.focus();
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Starting…';
  try {
    const res = await fetch('/api/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'provisioning failed');
    location.href = '/dashboard';
  } catch (e2) {
    err.textContent = e2.message;
    err.focus();
    btn.disabled = false;
    btn.textContent = 'Create my coding server';
  }
});

// Sign-in flows store their credential server-side the moment they complete,
// so they need no field in the provision body.
function wireSignin(id, flowFn) {
  const btn = document.getElementById(id + '-signin');
  btn.addEventListener('click', () => {
    if (window.afActive) return;
    flowFn(document.getElementById(id + '-flow'), () => {
      document.getElementById(id + '-flow').innerHTML = '';
      btn.style.display = 'none';
      document.getElementById(id + '-connected').style.display = '';
    });
  });
}
wireSignin('claude', window.claudeOauthFlow);
wireSignin('codex', window.codexDeviceFlow);
wireSignin('copilot', window.copilotDeviceFlow);
wireSignin('wrangler', window.wranglerOauthFlow);

const githubConnect = document.getElementById('github-connect');
if (githubConnect) {
  let savedAgents = [];
  try { savedAgents = JSON.parse(sessionStorage.getItem('codestation-github-agents') || '[]'); }
  catch (_) { savedAgents = []; }
  sessionStorage.removeItem('codestation-github-agents');
  for (const agent of savedAgents) {
    const input = form.querySelector('input[name="agent"][value="' + CSS.escape(agent) + '"]');
    if (input) input.checked = true;
  }
  githubConnect.addEventListener('click', () => {
    sessionStorage.setItem('codestation-github-agents', JSON.stringify(
      new FormData(form).getAll('agent').map((agent) => agent.toString())
    ));
  });
}

async function loadGithubRepositories() {
  const list = document.getElementById('github-repos');
  if (!list) return;
  const status = document.getElementById('github-status');
  status.innerHTML = '<span class="spinner" aria-hidden="true"></span>Checking GitHub…';
  try {
    const res = await fetch('/api/github/repos');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409) {
        status.textContent = 'Connect GitHub to choose repositories.';
        return;
      }
      throw new Error(json.error || 'Could not load repositories');
    }
    const repositories = Array.isArray(json.repositories) ? json.repositories : [];
    status.textContent = repositories.length
      ? 'GitHub connected. Choose up to ${INPUT_LIMITS.githubReposPerProvision} repositories.'
      : 'GitHub connected, but this app cannot access any repositories yet.';
    if (!repositories.length) return;
    list.innerHTML = repositories.map((repo, index) => {
      const visibility = repo.private ? 'private' : 'public';
      const archived = repo.archived ? ' · archived' : '';
      const description = repo.description ? '<small>' + onEsc(repo.description) + '</small>' : '';
      return '<label class="repo-choice" for="github-repo-' + index + '">' +
        '<input type="checkbox" id="github-repo-' + index + '" name="githubRepo" value="' +
          onEsc(repo.fullName) + '">' +
        '<span><strong>' + onEsc(repo.fullName) + '</strong>' +
          '<small>' + visibility + archived + '</small>' + description + '</span></label>';
    }).join('');
    list.addEventListener('change', () => {
      const checked = list.querySelectorAll('input:checked').length;
      for (const input of list.querySelectorAll('input:not(:checked)')) {
        input.disabled = checked >= ${INPUT_LIMITS.githubReposPerProvision};
      }
    });
  } catch (error) {
    status.textContent = error.message || 'Could not load GitHub repositories.';
  }
}

const onEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
loadGithubRepositories();
`;

/** One "Sign in with …" subscription block, shared markup for the wizard. */
const SigninProvider: FC<{
  id: string;
  title: string;
  hint: string;
  button: string;
  connected: string;
}> = ({ id, title, hint, button, connected }) => (
  <div class="provider">
    <div class="provider-head">
      <div>
        <strong>{title}</strong>
        <small>{hint}</small>
      </div>
      <button type="button" id={`${id}-signin`} class="btn secondary">
        {button}
      </button>
      <span id={`${id}-connected`} class="ok" style="display:none" role="status" aria-live="polite">
        ✓ {connected}
      </span>
    </div>
    <div id={`${id}-flow`} role="status" aria-live="polite"></div>
  </div>
);

export const OnboardingPage: FC<{ githubAvailable?: boolean }> = ({ githubAvailable = false }) => (
  <Layout title="Set up" loggedIn>
    <h1>Set up your coding server</h1>
    <p class="lead">
      One required choice, everything else optional — you can add credentials later from the
      dashboard.
    </p>
    <form id="wizard">
      <div class="card">
        <fieldset aria-describedby="agent-help">
          <legend>1. Pick your coding agents (at least one)</legend>
          <div class="agents">
            {AGENTS.map((a) => (
              <div class="agent">
                <input type="checkbox" name="agent" value={a} id={`agent-${a}`} />
                <label for={`agent-${a}`}>
                  <span class="agent-title">
                    {AGENT_LABELS[a]}
                    {a === "codex" ? <span class="recommend">easy start</span> : null}
                  </span>
                  <small>{AGENT_GUIDANCE[a]}</small>
                </label>
              </div>
            ))}
          </div>
          <p id="agent-help" class="muted" style="margin-top:0.9rem">
            Not sure? Pick Codex if you have ChatGPT, Claude Code if you use Claude, or Pi/OpenCode
            if you want to choose among API providers. You can pick more than one.
          </p>
        </fieldset>
      </div>

      {githubAvailable ? (
        <div class="card">
          <h2>2. Connect GitHub and clone repositories (optional)</h2>
          <p class="muted">
            Authorize GitHub to preconfigure <code>gh</code> and Git. Selected repositories are
            cloned into <code>~/repos/owner/name</code> while your server is created.
          </p>
          <div class="row">
            <a id="github-connect" class="btn secondary" href="/auth/github?return_to=/onboarding">
              Connect or reconnect GitHub
            </a>
          </div>
          <p id="github-status" class="muted" role="status" aria-live="polite">
            Checking GitHub…
          </p>
          <fieldset id="github-repos" class="repo-list" aria-label="Repositories to clone"></fieldset>
        </div>
      ) : null}

      <div class="card">
        <h2>{githubAvailable ? "3" : "2"}. Give your agents a model (optional)</h2>
        <p class="muted">
          Agents need an LLM to work. Credentials are stored encrypted; code running in your
          server can use them, so keep API tokens narrowly scoped.
        </p>

        <h3 class="group-label">Use a subscription you already pay for</h3>
        <SigninProvider
          id="claude"
          title="Claude"
          hint="Claude Pro or Max plan — powers Claude Code."
          button="Sign in with Claude"
          connected="Claude connected — Claude Code will use your plan"
        />
        <SigninProvider
          id="codex"
          title="ChatGPT"
          hint="ChatGPT plan — powers Codex. Approve a one-time code, nothing to paste."
          button="Sign in with ChatGPT"
          connected="ChatGPT connected — Codex will use your plan"
        />
        <SigninProvider
          id="copilot"
          title="GitHub Copilot"
          hint="Copilot plan — usable from OpenCode."
          button="Sign in with GitHub"
          connected="GitHub Copilot connected"
        />
        <div class="provider">
          <div class="provider-head">
            <div>
              <strong>OpenCode Go</strong>
              <small>
                OpenCode's model subscription — copy your key from{" "}
                <a href="https://opencode.ai/auth" target="_blank" rel="noreferrer">
                  opencode.ai/auth
                </a>
                .
              </small>
            </div>
          </div>
          <label for="llm-opencode-go" class="sr-only">
            OpenCode Go API key
          </label>
          <input
            id="llm-opencode-go"
            type="password"
            name="llm_opencode_go"
            autocomplete="off"
            placeholder="OpenCode Go API key"
          />
        </div>

        <h3 class="group-label">Or paste an API key</h3>
        <details>
          <summary>Add API keys (Anthropic, OpenAI, Gemini, OpenRouter)</summary>
          <label for="llm-anthropic">
            Anthropic API key (
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              get key
            </a>
            )
          </label>
          <input id="llm-anthropic" type="password" name="llm_anthropic" autocomplete="off" />
          <label for="llm-openai">
            OpenAI API key (
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
              get key
            </a>
            )
          </label>
          <input id="llm-openai" type="password" name="llm_openai" autocomplete="off" />
          <label for="llm-gemini">
            Google (Gemini) API key (
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              get key
            </a>
            )
          </label>
          <input id="llm-gemini" type="password" name="llm_gemini" autocomplete="off" />
          <label for="llm-openrouter">
            OpenRouter API key (
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              get key
            </a>
            )
          </label>
          <input id="llm-openrouter" type="password" name="llm_openrouter" autocomplete="off" />
          <label for="llm-claude-token">
            Claude subscription token, if you prefer <code>claude setup-token</code> over the
            sign-in above
          </label>
          <input
            id="llm-claude-token"
            type="password"
            name="llm_claude_subscription_token"
            autocomplete="off"
          />
        </details>
      </div>

      <div class="card">
        <h2>{githubAvailable ? "4" : "3"}. Advanced config (optional)</h2>
        <p class="muted">
          Most people skip this: after setup, the dashboard hands you a prompt for your local
          coding agent that creates an SSH key, registers it, and configures{" "}
          <code>ssh codestation</code> for you.
        </p>
        <details>
          <summary>Add an SSH public key myself</summary>
          <label for="ssh-pubkey">Public key</label>
          <textarea
            id="ssh-pubkey"
            name="sshPubkey"
            placeholder="ssh-ed25519 AAAA… you@laptop"
            spellcheck={false}
            aria-describedby="ssh-key-help"
          ></textarea>
          <p id="ssh-key-help" class="muted">
            Run <code>ssh-keygen -t ed25519</code> if you do not have a key, then paste the output
            of <code>cat ~/.ssh/id_ed25519.pub</code>. Never paste the private key (the file
            without <code>.pub</code>). Until a key exists the container accepts no logins.
          </p>
        </details>
        <details>
          <summary>Connect Cloudflare for deploys</summary>
          <div class="provider" style="border-bottom:0">
            <div class="provider-head">
              <div>
                <strong>Wrangler sign-in</strong>
                <small>Log wrangler in with your Cloudflare account — no token to create.</small>
              </div>
              <button type="button" id="wrangler-signin" class="btn secondary">
                Sign in with Cloudflare
              </button>
              <span
                id="wrangler-connected"
                class="ok"
                style="display:none"
                role="status"
                aria-live="polite"
              >
                ✓ Cloudflare connected — wrangler is signed in
              </span>
            </div>
            <div id="wrangler-flow" role="status" aria-live="polite"></div>
          </div>
          <label for="cloudflare-token">
            Or paste a scoped API token (
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">
              create one
            </a>
            {" — Workers Scripts:Edit + DNS:Edit is a good template)"}
          </label>
          <input id="cloudflare-token" type="password" name="cloudflareToken" autocomplete="off" />
        </details>
      </div>

      <button id="go" class="btn" type="submit">
        Create my coding server
      </button>
      <div id="err" class="err" role="alert" aria-live="assertive" tabindex={-1}></div>
    </form>
    <script dangerouslySetInnerHTML={{ __html: AUTH_FLOWS_JS }} />
    <script dangerouslySetInnerHTML={{ __html: ONBOARDING_JS }} />
  </Layout>
);
