import type { FC } from "hono/jsx";
import {
  AGENT_LABELS,
  AGENTS,
  type Agent,
  type LlmProvider,
} from "@codestation/contract";
import { Layout } from "./layout.js";

const AGENT_DESCRIPTIONS: Record<Agent, string> = {
  pi: "A minimal agent harness. Adapt Pi to your workflows.",
  claude: "Anthropic's coding agent.",
  codex: "OpenAI's coding agent.",
  opencode: "The open source AI coding agent.",
};

export const LandingPage: FC<{ devAuth: boolean; worldIdEnvironment: "production" | "staging" }> = ({
  devAuth,
  worldIdEnvironment,
}) => (
  <Layout>
    <h1 class="landing-title">A cloud machine for coding.</h1>
    <p class="lead">Linux, your coding agents, and SSH. Free with World ID or an invite.</p>
    <div class="card">
      <ul class="check spec-list">
        <li>
          Debian 13 · 1 vCPU · 2 GB RAM · 8 GB persistent disk
          <span class="ok">free tier</span>
        </li>
        <li>
          Pi, Claude Code, Codex, and/or OpenCode
        </li>
        <li>
          SSH, tmux, git, Node, Python, and more
        </li>
      </ul>
    </div>
    <div class="card landing-signin" aria-labelledby="signin-heading">
      <h2 id="signin-heading">Sign in or create an account</h2>
      <div id="landing-auth-root" data-world-id-environment={worldIdEnvironment}></div>
      {devAuth ? (
        <div class="auth-dev-option">
          <a class="btn secondary" href="/auth/dev">
            Dev login
          </a>
        </div>
      ) : null}
      <script type="module" src="/landing.js"></script>
    </div>
  </Layout>
);

export const SecurityPage: FC<{
  signupMethod: "world_id" | "invite" | "dev";
  passkeyCount: number;
  continueHref: string;
  welcome: boolean;
}> = ({ signupMethod, passkeyCount, continueHref, welcome }) => (
  <Layout title="Account security" loggedIn>
    <h1>{welcome ? "Your account is ready." : "Account security."}</h1>
    <p class="lead">
      {signupMethod === "world_id"
        ? "World ID remains available whenever you need it. A passkey gives you a faster, phishing-resistant way to sign in."
        : "This account uses passkeys to sign in. Add another passkey from a second device or password manager if you want a backup."}
    </p>
    <section class="card" aria-labelledby="passkeys-heading">
      <div class="card-head">
        <h2 id="passkeys-heading">Passkeys</h2>
        <span id="passkey-count" class="badge running">
          {passkeyCount} {passkeyCount === 1 ? "passkey" : "passkeys"}
        </span>
      </div>
      <p class="muted">
        Your fingerprint, face, or device PIN stays on your device. Codestation stores only the public credential needed to verify sign-in.
      </p>
      <button id="add-passkey-btn" class="btn" type="button">
        {passkeyCount > 0 ? "Add another passkey" : "Add a passkey"} →
      </button>
      <p id="passkey-setup-status" class="muted" role="status" aria-live="polite"></p>
    </section>
    <div class="row">
      <a id="security-continue" class="btn secondary" href={continueHref}>
        {welcome && passkeyCount === 0 ? "Skip for now" : "Continue"} →
      </a>
    </div>
    <script type="module" src="/security.js"></script>
  </Layout>
);

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

/** One pasteable API-key field, keeping labels, help links, and autocomplete behavior uniform. */
const ApiKeyProvider: FC<{
  id: string;
  name: `llm_${LlmProvider}`;
  title: string;
  keyUrl: string;
  linkLabel?: string;
}> = ({ id, name, title, keyUrl, linkLabel = "Get key" }) => (
  <div class="provider">
    <div class="provider-head">
      <strong>{title}</strong>
      <a class="btn secondary" href={keyUrl} target="_blank" rel="noreferrer">
        {linkLabel}
      </a>
    </div>
    <label for={id} class="sr-only">{title}</label>
    <input id={id} type="password" name={name} autocomplete="off" placeholder={title} />
  </div>
);

const AgentSignin: FC<{
  id: "claude" | "codex";
  button: string;
  connected: string;
}> = ({ id, button, connected }) => (
  <>
    <div class="agent-signin">
      <button type="button" id={`${id}-signin`} class="btn secondary">
        {button}
      </button>
      <span id={`${id}-connected`} class="ok" style="display:none" role="status" aria-live="polite">
        ✓ {connected}
      </span>
    </div>
    <div id={`${id}-flow`} role="status" aria-live="polite"></div>
  </>
);

export const OnboardingPage: FC<{
  githubAvailable?: boolean;
  githubInstallationAvailable?: boolean;
}> = ({ githubAvailable = false, githubInstallationAvailable = false }) => (
  <Layout title="Set up" loggedIn>
    <h1>Set up a server.</h1>
    <p class="notice">
      Choose agents and credentials before creating your server. After it is provisioned, changes require
      manual terminal commands.
    </p>
    <form id="wizard">
      <div class="card">
        <fieldset>
          <legend>1. Coding agents <span class="muted">required</span></legend>
          <div class="agents">
            {AGENTS.map((a) => (
              <div class="agent">
                <label class="agent-choice" for={`agent-${a}`}>
                  <input type="checkbox" name="agent" value={a} id={`agent-${a}`} />
                  <span class="agent-checkbox" aria-hidden="true">✓</span>
                  <span class="agent-copy">
                    <span class="agent-title">{AGENT_LABELS[a]}</span>
                    <small>{AGENT_DESCRIPTIONS[a]}</small>
                  </span>
                </label>
                {a === "claude" ? (
                  <AgentSignin id="claude" button="Sign in with Claude" connected="Claude connected" />
                ) : null}
                {a === "codex" ? (
                  <AgentSignin id="codex" button="Sign in with ChatGPT" connected="ChatGPT connected" />
                ) : null}
              </div>
            ))}
          </div>
        </fieldset>
      </div>

      <div class="card">
        <details>
          <summary>Add API keys or sign in to a provider</summary>
          <SigninProvider
            id="copilot"
            title="GitHub Copilot"
            hint="For OpenCode."
            button="Sign in with GitHub"
            connected="GitHub Copilot connected"
          />
          <ApiKeyProvider
            id="llm-opencode-go"
            name="llm_opencode_go"
            title="OpenCode Go API key"
            keyUrl="https://opencode.ai/auth"
            linkLabel="Get key from OpenCode"
          />
          <ApiKeyProvider
            id="llm-anthropic"
            name="llm_anthropic"
            title="Anthropic API key"
            keyUrl="https://console.anthropic.com/settings/keys"
          />
          <ApiKeyProvider
            id="llm-openai"
            name="llm_openai"
            title="OpenAI API key"
            keyUrl="https://platform.openai.com/api-keys"
          />
          <ApiKeyProvider
            id="llm-gemini"
            name="llm_gemini"
            title="Google (Gemini) API key"
            keyUrl="https://aistudio.google.com/apikey"
          />
          <ApiKeyProvider
            id="llm-openrouter"
            name="llm_openrouter"
            title="OpenRouter API key"
            keyUrl="https://openrouter.ai/keys"
          />
        </details>
      </div>

      {githubAvailable ? (
        <div class="card">
          <h2>2. GitHub <span class="muted">optional</span></h2>
          <p class="muted">
            {githubInstallationAvailable
              ? "Install the GitHub App for a personal or organization account, to clone repositories into "
              : "Connect GitHub, then choose repositories to clone into "}
            <code>~/repos</code>.
          </p>
          <div class="row">
            <a
              id="github-connect"
              class="btn secondary"
              href={githubInstallationAvailable
                ? "/auth/github/install?return_to=/onboarding"
                : "/auth/github?return_to=/onboarding"}
            >
              {githubInstallationAvailable ? "Install or manage GitHub access" : "Connect GitHub"}
            </a>
            <button id="github-reauthorize" class="btn secondary" type="button">
              Reauthorize GitHub
            </button>
          </div>
          <p id="github-status" class="muted" role="status" aria-live="polite">
            Search by repository name, or enter an exact owner/repository.
          </p>
          <label for="github-repo-search">Search repositories</label>
          <input id="github-repo-search" type="search" placeholder="repository name or owner/repository" maxLength={256} autocomplete="off" />
          <fieldset id="github-repos" class="repo-list" aria-label="Repositories to clone"></fieldset>
        </div>
      ) : null}


      <div class="card">
        <h2>{githubAvailable ? "3" : "2"}. Advanced <span class="muted">optional</span></h2>
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
          <summary>Connect Cloudflare</summary>
          <div class="provider" style="border-bottom:0">
            <div class="provider-head">
              <div>
                <strong>Wrangler sign-in</strong>
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
            or paste an API token. You can{" "}
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">
              create one in Cloudflare
            </a>
            .
          </label>
          <input id="cloudflare-token" type="password" name="cloudflareToken" autocomplete="off" />
        </details>
      </div>

      <button id="go" class="btn create-server-btn" type="submit">
        Create server →
      </button>
      <div id="err" class="err" role="alert" aria-live="assertive" tabindex={-1}></div>
    </form>
    <script type="module" src="/onboarding.js"></script>
  </Layout>
);
