/**
 * Render smoke tests for the server-rendered pages: the inline <script>
 * payloads are plain strings that tsc never sees, so parse each one with the
 * Function constructor to catch syntax errors at test time.
 */
import { describe, expect, it } from "vitest";
import { DashboardPage } from "../src/pages/dashboard.js";
import { LandingPage, OnboardingPage } from "../src/pages/views.js";

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.trim());
}

const pages: Array<[string, () => unknown]> = [
  ["landing", () => LandingPage({ devAuth: false, worldIdEnvironment: "production" })],
  ["onboarding", () => OnboardingPage({})],
  ["dashboard", () => DashboardPage({})],
];

describe("inline page JS parses", () => {
  for (const [name, render] of pages) {
    it(name, () => {
      const html = String(render());
      const scripts = scriptsOf(html);
      expect(scripts.length).toBeGreaterThan(0);
      for (const s of scripts) {
        expect(() => new Function(s)).not.toThrow();
      }
    });
  }
});

describe("World ID environment wiring", () => {
  it("renders the configured environment independently of dev auth", () => {
    const html = String(LandingPage({ devAuth: true, worldIdEnvironment: "production" }));
    expect(html).toContain("environment: 'production'");
    expect(html).toContain("Dev login");
  });
});

describe("subscription sign-in wiring", () => {
  it("onboarding offers every subscription sign-in and no auth.json paste path", () => {
    const html = String(OnboardingPage({}));
    for (const flow of ["claudeOauthFlow", "codexDeviceFlow", "copilotDeviceFlow", "wranglerOauthFlow"]) {
      expect(html).toContain(flow);
    }
    expect(html).toContain("Sign in with Claude");
    expect(html).toContain("Sign in with ChatGPT");
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain("Sign in with Cloudflare");
    expect(html).toContain('name="llm_opencode_go"');
    expect(html).not.toContain("llm_claude_subscription_token");
    expect(html).not.toContain("llm_codex_subscription_token");
    expect(html).not.toContain("auth.json");
  });

  it("keeps API keys inside the model card", () => {
    const html = String(OnboardingPage({}));
    const apiKeys = html.indexOf("Or paste an API key");
    expect(html).not.toContain("Use a subscription you already pay for");
    expect(apiKeys).toBeGreaterThan(-1);
    expect(html.slice(apiKeys)).toContain('name="llm_anthropic"');
  });

  it("dashboard keeps credentials read-only after server creation", () => {
    const html = String(DashboardPage({}));
    for (const flow of ["claudeOauthFlow", "codexDeviceFlow", "copilotDeviceFlow", "wranglerOauthFlow"]) {
      expect(html).not.toContain(flow);
    }
    expect(html).toContain("Set during setup");
    expect(html).toContain("manual terminal commands");
    expect(html).not.toContain("/api/credentials");
    expect(html).not.toContain("Changes apply without a restart");
  });
});

describe("onboarding wizard order", () => {
  it("goes agents → model access → advanced config, with SSH keys inside Advanced", () => {
    const html = String(OnboardingPage({}));
    const agents = html.indexOf("1. Coding agents");
    const model = html.indexOf("2. Model access");
    const advanced = html.indexOf("3. Advanced");
    expect(agents).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(agents);
    expect(advanced).toBeGreaterThan(model);
    // The SSH key field stays behind the Advanced section.
    expect(html.indexOf('name="sshPubkey"')).toBeGreaterThan(advanced);
    expect(html.slice(advanced)).toContain("Add an SSH public key myself");
    expect(html.slice(advanced, html.indexOf('name="sshPubkey"'))).toContain("<details>");
  });

  it("warns that credentials can only be changed from the server terminal after setup", () => {
    const html = String(OnboardingPage({ githubAvailable: true }));
    expect(html).toContain("Preconfigure your workbench now");
    expect(html).toContain("Once its provisioned, modifications require manual terminal commands");
  });
});

describe("GitHub repository onboarding", () => {
  it("offers OAuth and repository selection only when the GitHub App is configured", () => {
    const enabled = String(OnboardingPage({ githubAvailable: true }));
    expect(enabled).toContain("Connect GitHub");
    expect(enabled).toContain("Reauthorize GitHub");
    expect(enabled).toContain("/auth/github/reauth");
    expect(enabled).toContain("/auth/github?return_to=/onboarding");
    expect(enabled).toContain("/api/github/repos");
    expect(enabled).toContain('name=\"githubRepo\"');
    expect(enabled).toContain("~/repos");
    expect(enabled).toContain('id=\"github-repo-search\"');

    const disabled = String(OnboardingPage({ githubAvailable: false }));
    expect(disabled).not.toContain("Connect or reconnect GitHub");
    expect(disabled).not.toContain('id=\"github-repos\"');
  });
});

describe("dashboard loading and polling", () => {
  it("loads one dashboard snapshot, then polls only container state without replacing forms", () => {
    const html = String(DashboardPage({}));
    const script = scriptsOf(html).find((value) => value.includes("loadDashboard")) ?? "";
    const load = script.slice(script.indexOf("window.loadDashboard"), script.indexOf("document.addEventListener"));
    const poll = script.slice(script.indexOf("async function pollContainer"), script.indexOf("window.act"));

    expect(load).toContain("api('/api/dashboard')");
    expect(load).toContain("renderCreds(snapshot.credentials)");
    expect(load).toContain("renderKeys(knownKeys)");
    expect(poll).toContain("api('/api/container')");
    expect(poll).not.toContain("renderCreds(");
    expect(poll).not.toContain("renderKeys(");
    expect(poll).not.toContain("/api/credentials");
    expect(poll).not.toContain("/api/keys");
  });

  it("uses non-overlapping, visibility-aware polling with distinct build and waitlist delays", () => {
    const html = String(DashboardPage({}));
    expect(html).toContain("if (c.status === 'waitlisted') return 30000");
    expect(html).toContain("if (isBusy(c)) return 5000");
    expect(html).toContain("setTimeout(pollContainer, delay)");
    expect(html).toContain("pollInFlight");
    expect(html).toContain("document.hidden");
    expect(html).toContain("visibilitychange");
    expect(html).not.toContain("setInterval(");
  });
});

describe("beginner-friendly provisioning UI", () => {
  it("puts SSH access before credentials and only unlocks key setup after a successful build", () => {
    const html = String(DashboardPage({}));
    expect(html.indexOf("SSH access")).toBeLessThan(html.indexOf("Credentials"));
    expect(html).toContain("Copy SSH command");
    expect(html).toContain("Set up SSH with an agent");
    expect(html).toContain("Enroll another device");
    expect(html).toContain("ssh-keygen -t ed25519");
    expect(html).toContain("Never paste your private key");
    expect(html).toContain('id="enroll"');
    expect(html).toContain("waitlisted: 'Waiting for capacity'");
    expect(html).toContain("running: 'Ready'");
    expect(html).toContain("statusRefreshNeeded");
    expect(html).toContain("function canManageSshKeys(c)");
    expect(html).toContain("c.status === 'running'");
    expect(html).toContain("SSH setup unlocks after the server is ready");
    expect(html).toContain("Finish building your server before creating an SSH setup prompt");
    expect(html).toContain("c.status === 'running' && knownKeys.length === 0");
    expect(html).toContain("Add an SSH key to reveal your connection command");
    expect(html).toContain("You cannot see the SSH host or port until a key has been added");
    expect(html.indexOf("c.status === 'running' && knownKeys.length === 0")).toBeLessThan(
      html.indexOf("if (currentSshCommand)"),
    );
    expect(html).toContain("refreshKeysAndConnection");
  });

  it("explains agent choices and gives beginners a recommendation", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain("common choice");
    expect(html).toContain("1. Coding agents");
    expect(html).toContain("required");
  });
});

describe("page accessibility and recovery affordances", () => {
  it.each(pages)("%s has a main landmark and skip link", (_name, render) => {
    const html = String(render());
    expect(html).toContain('<main id="main-content">');
    expect(html).toContain('class="skip-link" href="#main-content"');
  });

  it("groups onboarding choices, associates the SSH field, and announces errors", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend>1. Coding agents");
    expect(html).toContain('for="ssh-pubkey"');
    expect(html).toContain('id="err" class="err" role="alert" aria-live="assertive"');
  });

  it("has live status regions and visible retryable dashboard errors", () => {
    const html = String(DashboardPage({}));
    expect(html).toContain('id="page-error"');
    expect(html).toContain('id="action-error"');
    expect(html).toContain('role="alert" aria-live="assertive"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain("Try again");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain(":focus-visible");
  });
});

describe("interface foundation", () => {
  it.each(pages)("%s loads the shared Base UI and Motion client", (_name, render) => {
    const html = String(render());
    expect(html).toContain('<div id="ui-root"></div>');
    expect(html).toContain('<script type="module" src="/ui.js"></script>');
  });

  it("uses the light, borderless action system", () => {
    const html = String(LandingPage({ devAuth: false, worldIdEnvironment: "production" }));
    expect(html).toContain("color-scheme: light");
    expect(html).toContain(".btn.secondary, .btn.danger { border: 0");
    expect(html).toContain("color: var(--accent)");
  });

  it("uses understated underline text fields", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain(
      "background: transparent; color: var(--ink); border: 0; border-bottom: 1px solid var(--line);",
    );
    expect(html).toContain("input:hover, textarea:hover, select:hover { border-color: var(--line-strong); }");
    expect(html).toContain(
      "input:focus, textarea:focus, select:focus { border-color: var(--focus); box-shadow: 0 1px 0 var(--focus); }",
    );
  });

  it("keeps iOS Safari from zooming when mobile text fields receive focus", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain("@media (max-width: 600px)");
    expect(html).toContain(
      "input[type=text], input[type=password], input[type=search], textarea, select { font-size: 16px; }",
    );
  });
});
