import type { Child, FC } from "hono/jsx";
import {
  AGENT_LABELS,
  AGENTS,
  type Agent,
  type LlmProvider,
} from "@workbench/contract";
import { ExternalLinkIcon, GitHubLogoIcon } from "./icons.js";
import { Layout } from "./layout.js";

const AGENT_DESCRIPTIONS: Record<Agent, string> = {
  pi: "A minimal agent harness. Adapt Pi to your workflows.",
  claude: "Anthropic's coding agent.",
  codex: "OpenAI's coding agent.",
  opencode: "The open source AI coding agent.",
};

export const LandingPage: FC<{ devAuth: boolean }> = ({ devAuth }) => (
  <Layout>
    <div class="landing-hero">
      <h1 class="landing-title">A cloud workbench <br/>for agents</h1>
      <p class="lead">
        free for each unique person
        <br />
        an always-on container for long running coding agents
        <br />
        access from any terminal client on any device
      </p>
    </div>
    <div class="card">
      <ul class="check spec-list">
        <li>
          1 vCPU · 2 GB RAM · 5 GB Storage · Debian 13
          <span class="ok">free tier</span>
        </li>
        <li>
          2 vCPU · 4 GB RAM · 8 GB Storage · Debian 13
          <span class="muted tier-label">coming soon</span>
        </li>
        <li>
          Pi, Claude Code, Codex, OpenCode
        </li>
        <li>
          SSH, tmux, git, bash, curl, and more
        </li>
        <li>
          <i>Your repos and agents, preconfigured and ready in less than 5 mins</i>
        </li>
      </ul>
    </div>
    <div class="card landing-signin">
      <div class="landing-signin-content" role="region" aria-label="Sign in or create an account">
        <div id="landing-auth-root"></div>
        {devAuth ? (
          <div class="auth-dev-option">
            <a class="btn secondary" href="/auth/dev">
              Dev login
            </a>
          </div>
        ) : null}
        <script type="module" src="/landing.js"></script>
      </div>
    </div>
  </Layout>
);

export const VerificationPage: FC<{ worldIdAvailable: boolean }> = ({ worldIdAvailable }) => (
  <Layout title="Verify your account" loggedIn>
    <h1>Verify your account.</h1>
    <p class="lead">
      The free tier is limited to one account per person. {worldIdAvailable
        ? "Verify with World ID or redeem a single-use invite"
        : "Redeem a single-use invite"} before creating your workbench.
    </p>
    <div
      id="account-verification-root"
      class={worldIdAvailable ? "verification-grid" : undefined}
      data-world-id-available={String(worldIdAvailable)}
    ></div>
    <script type="module" src="/account.js"></script>
  </Layout>
);

export const SecurityPage: FC<{
  passkeyCount: number;
  continueHref: string;
  welcome: boolean;
}> = ({ passkeyCount, continueHref, welcome }) => (
  <Layout title="Account security" loggedIn>
    <h1>{welcome ? "Your account is ready." : "Account security."}</h1>
    <p class="lead">
      This account uses passkeys to sign in. Add another passkey from a second device or password manager if you want a backup.
    </p>
    <section class="card" aria-labelledby="passkeys-heading">
      <div class="card-head">
        <h2 id="passkeys-heading">Passkeys</h2>
        <span id="passkey-count" class="badge running">
          {passkeyCount} {passkeyCount === 1 ? "passkey" : "passkeys"}
        </span>
      </div>
      <p class="muted">
        Your fingerprint, face, or device PIN stays on your device. usebench.dev stores only the public credential needed to verify sign-in.
      </p>
      <button id="add-passkey-btn" class="btn primary" type="button">
        {passkeyCount > 0 ? "Add another passkey" : "Add a passkey"} →
      </button>
      <p id="passkey-setup-status" class="muted" role="status" aria-live="polite"></p>
    </section>
    <div class="row">
      <a id="security-continue" class="btn primary" href={continueHref}>
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
  icon?: Child;
}> = ({ id, title, hint, button, connected, icon }) => (
  <div class="provider">
    <div class="provider-head">
      <div>
        <strong>{title}</strong>
        <small>{hint}</small>
      </div>
      <button type="button" id={`${id}-signin`} class="btn secondary">
        {icon}{button}
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
        {linkLabel}<ExternalLinkIcon />
      </a>
    </div>
    <label for={id} class="sr-only">{title}</label>
    <input id={id} type="password" name={name} autocomplete="off" placeholder={title} />
  </div>
);

type PasteableLlmProvider = Exclude<
  LlmProvider,
  "claude_subscription_token" | "codex_subscription_token" | "github_copilot"
>;

const API_KEY_PROVIDERS: ReadonlyArray<{
  provider: PasteableLlmProvider;
  title: string;
  keyUrl: string;
  linkLabel?: string;
}> = [
  {
    provider: "opencode_go",
    title: "OpenCode Go API key",
    keyUrl: "https://opencode.ai/auth",
    linkLabel: "Get key from OpenCode",
  },
  {
    provider: "anthropic",
    title: "Anthropic API key",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    provider: "openai",
    title: "OpenAI API key",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    provider: "gemini",
    title: "Google (Gemini) API key",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    provider: "openrouter",
    title: "OpenRouter API key",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    provider: "deepseek",
    title: "DeepSeek API key",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    provider: "kimi",
    title: "Kimi API key",
    keyUrl: "https://platform.kimi.com/",
  },
  {
    provider: "minimax",
    title: "MiniMax API key",
    keyUrl: "https://platform.minimax.io/account/api-keys",
  },
  {
    provider: "zai",
    title: "Z.AI API key",
    keyUrl: "https://z.ai/manage-apikey",
  },
  {
    provider: "vercel_ai_gateway",
    title: "Vercel AI Gateway API key",
    keyUrl: "https://vercel.com/ai-gateway",
  },
];

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

export const NotFoundPage: FC = () => (
  <Layout title="Page not found">
    <h1>Page not found.</h1>
    <p class="lead">That page does not exist. It may have moved, or the link is wrong.</p>
    <a class="btn secondary" href="/">
      Back to usebench.dev →
    </a>
  </Layout>
);

export const OnboardingPage: FC<{
  githubAvailable?: boolean;
}> = ({ githubAvailable = false }) => (
  <Layout title="Set up" loggedIn>
    <h1>Set up a workbench.</h1>
    <p class="notice">
      Configure your workbench with agents, models, and credentials. After it is provisioned, changes require
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
        <details class="onboarding-api-keys">
          <summary>Add API keys</summary>
          <SigninProvider
            id="copilot"
            title="GitHub Copilot"
            hint="For OpenCode."
            button="Sign in with GitHub"
            connected="GitHub Copilot connected"
            icon={<GitHubLogoIcon />}
          />
          {API_KEY_PROVIDERS.map(({ provider, title, keyUrl, linkLabel }) => (
            <ApiKeyProvider
              id={`llm-${provider}`}
              name={`llm_${provider}`}
              title={title}
              keyUrl={keyUrl}
              {...(linkLabel ? { linkLabel } : {})}
            />
          ))}
        </details>
      </div>

      {githubAvailable ? (
        <div class="card">
          <h2>2. GitHub <span class="muted">optional</span></h2>
          <p class="muted">
            Connect GitHub and choose personal or organization repositories. usebench.dev uses the
            resulting short-lived access to search, clone into <code>~/repos</code>, and sign in <code>gh</code>.
          </p>
          <div class="row">
            <a
              id="github-connect"
              class="btn secondary"
              href="/auth/github?return_to=/onboarding"
            >
              <GitHubLogoIcon />Connect or update GitHub
            </a>
          </div>
          <p id="github-status" class="muted" role="status" aria-live="polite">
            After connecting, search by repository name or enter an exact owner/repository.
          </p>
          <label for="github-repo-search">Search repositories</label>
          <input id="github-repo-search" type="search" placeholder="repository name or owner/repository" maxLength={256} autocomplete="off" />
          <fieldset id="github-repos" class="repo-list" aria-label="Repositories to clone"></fieldset>
        </div>
      ) : null}


      <div class="card">
        <h2>{githubAvailable ? "3" : "2"}. Advanced <span class="muted">optional</span></h2>
        <details>
          <summary>Add an SSH public key manually</summary>
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
            without <code>.pub</code>). Until a key exists the workbench accepts no logins.
          </p>
        </details>
        <details>
          <summary>Connect Cloudflare</summary>
          <div class="provider">
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

      <button id="go" class="btn primary create-workbench-btn" type="submit">
        Create workbench →
      </button>
      <div id="err" class="err" role="alert" aria-live="assertive" tabindex={-1}></div>
    </form>
    <script type="module" src="/onboarding.js"></script>
  </Layout>
);
