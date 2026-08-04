import type { Child, FC } from "hono/jsx";
import {
  AGENT_LABELS,
  AGENTS,
  OAUTH_ONLY_LLM_PROVIDERS,
  type Agent,
  type LlmProvider,
} from "@workbench/contract";
import type { NotificationView } from "../notifications.js";
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
      <h1 class="landing-title">A cloud terminal <br/>for agents</h1>
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
          1 vCPU · 1.5 GB RAM · 5 GB Storage
          <span class="ok">free tier</span>
        </li>
        <li>
          2 vCPU · 4 GB RAM · 8 GB Storage
          <span class="muted tier-label">coming soon</span>
        </li>
        <li>
          Pi, Claude Code, Codex, OpenCode
        </li>
        <li>
          Debian 13, ssh, tmux, git, bash, curl, and more
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

export const VerificationPage: FC<{
  worldIdAvailable: boolean;
  notificationCount?: number;
}> = ({ worldIdAvailable, notificationCount = 0 }) => (
  <Layout
    title="Verify your account"
    loggedIn
    notificationCount={notificationCount}
    footerLinks={
      <a
        class="site-formality"
        href="http://x.com/messages/compose?recipient_id=1488260920564490242"
        target="_blank"
        rel="noopener noreferrer"
      >Request Invite</a>
    }
  >
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

export const AccountPage: FC<{
  passkeyCount: number;
  continueHref: string;
  welcome: boolean;
  containerStatus?: string | null;
  hasCredentials?: boolean;
  worldIdVerified?: boolean;
  notifications?: NotificationView[];
  unreadNotificationCount?: number;
}> = ({
  passkeyCount,
  continueHref,
  welcome,
  containerStatus = null,
  hasCredentials = false,
  worldIdVerified = false,
  notifications = [],
  unreadNotificationCount = notifications.filter((notification) => notification.readAt === null).length,
}) => {
  const containerMustBeDestroyed = containerStatus !== null && containerStatus !== "waitlisted";
  return (
    <Layout title="Account" loggedIn notificationCount={unreadNotificationCount}>
      <h1>{welcome ? "Your account is ready." : "Account."}</h1>
      <p class="lead">Manage passkeys, credentials, and notifications for your account.</p>
      <section id="notifications" class="card" aria-labelledby="notifications-heading" data-unread-count={unreadNotificationCount}>
        <div class="card-head">
          <h2 id="notifications-heading">Notifications</h2>
          {unreadNotificationCount > 0 ? (
            <span class="badge notification-count">
              {unreadNotificationCount} unread
            </span>
          ) : <span class="muted">All caught up</span>}
        </div>
        {notifications.length > 0 ? (
          <div class="notification-list" role="list">
            {notifications.map((notification) => {
              const unread = notification.readAt === null;
              return (
                <article
                  class={`notification${unread ? " unread" : ""}`}
                  data-notification-id={notification.id}
                  role="listitem"
                >
                  <div class="notification-head">
                    <h3>{notification.title}</h3>
                    <span class={`notification-severity ${notification.severity}`}>{notification.severity}</span>
                  </div>
                  {unread ? <span class="notification-unread" data-notification-new>New</span> : null}
                  <p class="notification-message">{notification.message}</p>
                  <div class="notification-meta">
                    <time class="muted" dateTime={new Date(notification.createdAt).toISOString()}>
                      {new Date(notification.createdAt).toISOString().slice(0, 10)}
                    </time>
                    {unread ? (
                      <button class="btn secondary" type="button" data-notification-read={notification.id}>
                        Mark as read
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <p class="muted">No notifications.</p>}
        {unreadNotificationCount > 0 ? (
          <div class="row">
            <button id="mark-notifications-read" class="btn secondary" type="button">
              Mark all as read
            </button>
          </div>
        ) : null}
        <p id="notifications-status" class="muted" role="status" aria-live="polite"></p>
      </section>
      <section class="card" aria-labelledby="passkeys-heading">
        <div class="card-head">
          <h2 id="passkeys-heading">Passkeys</h2>
          <span id="passkey-count" class="badge running">
            {passkeyCount} {passkeyCount === 1 ? "passkey" : "passkeys"}
          </span>
        </div>
        <p class="muted">
          Add a backup passkey for faster logins
        </p>
        <button id="add-passkey-btn" class="btn primary" type="button">
          {passkeyCount > 0 ? "Add another passkey" : "Add a passkey"} →
        </button>
        <p id="passkey-setup-status" class="muted" role="status" aria-live="polite"></p>
      </section>
      <section class="card" aria-labelledby="credentials-heading">
        <h2 id="credentials-heading">Saved credentials</h2>
        <p class="muted">
          Remove OAuth tokens, API tokens, and other credentials saved for your workbench. Values are never shown here.
        </p>
        {!hasCredentials ? <p class="muted">No saved credentials.</p> : null}
        <button id="delete-credentials-btn" class="btn danger" type="button" disabled={!hasCredentials}>
          Delete saved credentials
        </button>
        <p id="credentials-delete-status" class="muted" role="status" aria-live="polite"></p>
      </section>
      <section class="card" aria-labelledby="delete-account-heading">
        <h2 id="delete-account-heading">Delete account</h2>
        <button id="delete-account-btn" class="btn danger" type="button" disabled={containerMustBeDestroyed}>
          Delete account
        </button>
        <p class="muted hint">
          {containerMustBeDestroyed
            ? "Destroy your workbench first. When deletion finishes, you can delete the account."
            : "Permanently deletes your account, credentials, and keys."}
        </p>
        {worldIdVerified ? (
          <p class="muted hint">Deleting a World-ID verified account will <strong>NOT allow you to re-verify with World ID</strong>.</p>
        ) : null}
        <p id="account-delete-status" class="muted" role="status" aria-live="polite"></p>
      </section>
      {welcome ? (
        <div class="row">
          <a id="security-continue" class="btn primary" href={continueHref}>
            {welcome && passkeyCount === 0 ? "Skip for now" : "Continue"} →
          </a>
        </div>
      ) : null}
      <script type="module" src="/security.js"></script>
    </Layout>
  );
};

// Kept as an export for callers that still use the old implementation name.
export const SecurityPage = AccountPage;

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
  (typeof OAUTH_ONLY_LLM_PROVIDERS)[number]
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
    linkLabel: "Get key",
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
  id: string;
  button: string;
  connected: string;
}> = ({ id, button, connected }) => (
  <div class="agent-auth">
    <div class="agent-signin">
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

const AgentSignins: FC<{ agent: Agent }> = ({ agent }) => {
  if (agent === "claude") {
    return <div class="agent-signins">
      <AgentSignin id="claude" button="Sign in with Claude" connected="Claude connected" />
    </div>;
  }
  if (agent === "codex") {
    return <div class="agent-signins">
      <AgentSignin id="codex" button="Sign in with ChatGPT" connected="ChatGPT connected" />
    </div>;
  }
  return <div class="agent-signins">
    <AgentSignin
      id={`${agent}-chatgpt`}
      button="Sign in with ChatGPT"
      connected="ChatGPT connected"
    />
    <AgentSignin
      id={`${agent}-claude`}
      button="Sign in with Claude"
      connected="Claude connected"
    />
  </div>;
};

export const TermsPage: FC<{ loggedIn?: boolean }> = ({ loggedIn = false }) => (
  <Layout title="Terms of Service" loggedIn={loggedIn}>
    <article class="terms">
      <h1>Terms of Service.</h1>
      <p class="terms-meta">Effective August 4, 2026</p>

      <p>
        These Terms of Service govern your use of usebench.dev. By creating an account, accessing a
        workbench, or using the site, you agree to these Terms. If you do not agree, do not use the service.
      </p>

      <h2>1. The service</h2>
      <p>
        usebench.dev provides persistent, remote Debian development environments with SSH access and
        preconfigured coding tools. A workbench is a shared-kernel Linux container, not a hardware-isolated
        virtual machine. We may change, suspend, or discontinue features, limits, images, or infrastructure.
      </p>
      <p>
        As of the effective date, there is no self-service paid subscription or automatic recurring billing.
        Free access and operator-entitled paid or dedicated access may be offered under
        separate plan information. If self-service subscriptions are introduced, the checkout flow and the
        subscription terms below will apply.
      </p>

      <h2>2. Accounts</h2>
      <p>
        You must provide accurate information, protect your sign-in methods, and promptly tell us about
        unauthorized access. You are responsible for activity under your account and for complying with the
        terms of any provider or integration you connect to the service.
      </p>
      <p>
        You may not create or use accounts to evade an eligibility limit, a suspension, or a force closure.
        We may require additional verification before granting or restoring access.
      </p>

      <h2>3. Acceptable use</h2>
      <p>
        You may use a workbench only for lawful development and related personal or business activities. You
        must not:
      </p>
      <ul>
        <li>use the service to violate law, court orders, sanctions, or another person’s rights;</li>
        <li>probe, attack, disrupt, overload, or gain unauthorized access to systems, networks, or accounts;</li>
        <li>send spam, phishing, malware, ransomware, abusive automation, or unsolicited bulk traffic;</li>
        <li>mine cryptocurrency, operate persistent high-impact workloads, or evade resource limits;</li>
        <li>store or distribute content that is unlawful, fraudulent, exploitative, or infringing;</li>
        <li>resell, sublicense, share, or transfer access without our written permission; or</li>
        <li>use credentials, tokens, repositories, or third-party services without authorization.</li>
      </ul>
      <p>
        We may investigate suspected abuse using reasonable operational and security signals. Do not place
        information in a workbench that you cannot risk losing or that requires a regulated hosting environment
        unless we have expressly agreed to those requirements in writing.
      </p>

      <h2>4. Your content and integrations</h2>
      <p>
        You retain your rights in code, files, repositories, and other content you place in a workbench. You
        grant us only the limited license needed to host, transmit, back up when explicitly provided, secure,
        and operate that content for you. You are responsible for your content, licenses, credentials, and
        actions taken by agents or programs running in your workbench.
      </p>
      <p>
        Third-party agents, model providers, source-control services, and cloud integrations have their own
        terms and policies. We do not control them and are not responsible for their availability, decisions,
        charges, or handling of your data.
      </p>

      <h2>5. Availability and data</h2>
      <p>
        The service is provided without a backup, disaster-recovery, or availability guarantee. Provisioning,
        maintenance, host failure, security response, or a lifecycle operation may make a workbench unavailable
        or permanently remove its data. Keep independent copies of anything important before rebuilding,
        stopping, or destroying a workbench.
      </p>
      <p>
        We use reasonable safeguards for the service, but no internet service is completely secure. Never place
        private keys, passwords, or other secrets in chat, tickets, repositories, or files that do not need them.
      </p>

      <h2>6. Suspension, termination, and force closure</h2>
      <p>
        We may suspend or terminate an account, restrict access, stop a workbench, remove content, or end a
        placement when we reasonably believe that you violated these Terms, created a security or legal risk,
        abused resources, used fraudulent credentials, failed to pay an amount due, or exposed us or another
        person to harm.
      </p>
      <p>
        A <strong>force closure</strong> may happen immediately and without advance notice when delay could
        increase the risk. It may stop and permanently delete the workbench, release its storage and network
        resources, and prevent replacement access. We will provide notice when reasonably practical, but notice
        is not required for urgent security, legal, or abuse responses. Except where the law requires otherwise,
        a force closure for abuse does not create a refund, credit, or data-recovery obligation.
      </p>
      <p>
        You may stop using the service at any time. Account deletion and workbench destruction are permanent;
        export anything you need first. Sections that should reasonably survive termination continue to apply.
      </p>

      <h2>7. Future subscriptions</h2>
      <p>
        If we offer a paid subscription, the price, billing interval, renewal date, taxes, and cancellation
        method will be shown before purchase. Unless the checkout terms say otherwise, a cancellation prevents
        the next renewal and does not automatically refund the current period.
      </p>
      <p>
        We may cancel a subscription immediately for abuse, a material violation of these Terms, fraud,
        nonpayment, or a security or legal risk. We may also suspend the associated workbench and permanently
        remove its data under Section 6. Except where required by law or the applicable checkout terms, an
        abuse-related cancellation is not eligible for a refund or credit for unused time.
      </p>

      <h2>8. Intellectual property</h2>
      <p>
        The site, service software, branding, documentation, and content supplied by us belong to us or our
        licensors. We grant you a limited, non-exclusive, revocable right to use them only as needed to use the
        service. You may send feedback, and we may use it without restriction or payment.
      </p>

      <h2>9. Disclaimers</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE.” WE DISCLAIM
        WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, SECURITY,
        ACCURACY, AND UNINTERRUPTED OR ERROR-FREE OPERATION. WE DO NOT PROMISE THAT A WORKBENCH WILL BE AVAILABLE,
        SAFE FROM ALL ATTACKS, OR SUITABLE FOR A PARTICULAR WORKLOAD.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, usebench.dev and its providers will not be liable for indirect,
        incidental, special, consequential, exemplary, or punitive damages, or for lost profits, revenue, data,
        goodwill, or business interruption. Our total liability arising from the service will not exceed the
        greater of the amounts you paid us for the service in the twelve months before the event or one hundred
        U.S. dollars. This section does not limit liability that cannot lawfully be limited.
      </p>

      <h2>11. Indemnity</h2>
      <p>
        To the extent permitted by law, you will defend and indemnify usebench.dev and its providers from claims,
        losses, liabilities, and reasonable costs arising from your content, your use of the service, your
        violation of these Terms, or your violation of another person’s rights or law.
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update these Terms by posting a revised version with a new effective date. For material changes,
        we will provide reasonable notice through the service or to the contact information associated with your
        account. Continuing to use the service after the effective date means you accept the revised Terms.
      </p>

      <h2>13. Governing law and venue</h2>
      <p>
        New York law governs these Terms, without regard to conflict-of-law rules. You and usebench.dev consent
        to the exclusive jurisdiction and venue of the state and federal courts located in New York County, New
        York, for disputes that are not otherwise required by law to be brought elsewhere.
      </p>

      <h2>14. General terms</h2>
      <p>
        These Terms are the agreement between you and usebench.dev about the service and replace earlier terms
        on the same subject. If a provision is unenforceable, the rest remains effective. Our failure to enforce
        a provision is not a waiver. You may not assign these Terms without our consent; we may assign them in
        connection with a reorganization, sale, or transfer of the service.
      </p>

      <h2>15. Contact</h2>
      <p>
        Authenticated users can use the Contact link in the footer for questions about these Terms.
      </p>
    </article>
  </Layout>
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
  notificationCount?: number;
}> = ({ githubAvailable = false, notificationCount = 0 }) => (
  <Layout title="Set up" loggedIn notificationCount={notificationCount}>
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
                <AgentSignins agent={a} />
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
              target="_blank"
              rel="noopener noreferrer"
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
          <div class="provider-head">
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
          <label for="cloudflare-token">
            or paste an API token. You can{" "}
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">
              create one in Cloudflare
            </a>
            .
          </label>
          <input id="cloudflare-token" type="password" name="cloudflareToken" autocomplete="off" />
        </details>
        <details>
          <summary>Connect Supabase</summary>
          <label for="supabase-token">
            Paste a personal or OAuth access token. You can{" "}
            <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer">
              create one in Supabase
            </a>
            . It will be available to the Supabase CLI as <code>SUPABASE_ACCESS_TOKEN</code>.
          </label>
          <input id="supabase-token" type="password" name="supabaseToken" autocomplete="off" />
        </details>
        <details>
          <summary>Connect Convex</summary>
          <div class="provider-head">
            <button type="button" id="convex-signin" class="btn secondary">
              Sign in with Convex
            </button>
            <span
              id="convex-connected"
              class="ok"
              style="display:none"
              role="status"
              aria-live="polite"
            >
              ✓ Convex connected — CLI signed in
            </span>
          </div>
          <div id="convex-flow" role="status" aria-live="polite"></div>
          <label for="convex-token">
            or paste a personal access token from an existing CLI login. It will sign in the Convex
            CLI for this workbench.
          </label>
          <input id="convex-token" type="password" name="convexToken" autocomplete="off" />
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
