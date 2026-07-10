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
    expect(html).not.toContain("llm_codex_subscription_token");
    expect(html).not.toContain("auth.json");
  });

  it("onboarding separates subscriptions from API keys inside the model card", () => {
    const html = String(OnboardingPage({}));
    const subscriptions = html.indexOf("Use a subscription you already pay for");
    const apiKeys = html.indexOf("Or paste an API key");
    expect(subscriptions).toBeGreaterThan(-1);
    expect(apiKeys).toBeGreaterThan(subscriptions);
    expect(html.slice(apiKeys)).toContain('name="llm_anthropic"');
  });

  it("dashboard has sign-in rows for every subscription and an API-key-only dropdown", () => {
    const html = String(DashboardPage({}));
    for (const flow of ["claudeOauthFlow", "codexDeviceFlow", "copilotDeviceFlow", "wranglerOauthFlow"]) {
      expect(html).toContain(flow);
    }
    expect(html).toContain("Sign in with ChatGPT");
    expect(html).toContain("OpenCode Go");
    expect(html).toContain('<option value="anthropic">');
    for (const sub of ["opencode_go", "claude_subscription_token", "codex_subscription_token", "github_copilot"]) {
      expect(html).not.toContain(`<option value="${sub}">`);
    }
    expect(html).not.toContain("auth.json");
  });
});

describe("onboarding wizard order", () => {
  it("goes agents → model access → advanced config, with SSH keys inside Advanced", () => {
    const html = String(OnboardingPage({}));
    const agents = html.indexOf("1. Pick your coding agents");
    const model = html.indexOf("2. Give your agents a model");
    const advanced = html.indexOf("3. Advanced config");
    expect(agents).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(agents);
    expect(advanced).toBeGreaterThan(model);
    // The SSH key field lives behind the Advanced Config card, after a
    // steer toward the agent-driven enrollment prompt.
    expect(html.indexOf('name="sshPubkey"')).toBeGreaterThan(advanced);
    expect(html.slice(advanced)).toContain("Add an SSH public key myself");
    expect(html.slice(advanced, html.indexOf('name="sshPubkey"'))).toContain("<details>");
    expect(html.slice(advanced)).toContain("ssh codestation");
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
  it("puts SSH access before optional credentials and provides copyable guided setup", () => {
    const html = String(DashboardPage({}));
    expect(html.indexOf("SSH access")).toBeLessThan(html.indexOf("Optional credentials"));
    expect(html).toContain("Copy SSH command");
    expect(html).toContain("Set up SSH with my coding agent");
    expect(html).toContain("Enroll another device with my agent");
    expect(html).toContain("ssh-keygen -t ed25519");
    expect(html).toContain("Never paste your private key");
    expect(html).toContain('id="enroll"');
    expect(html).toContain("waitlisted: 'Waiting for capacity'");
    expect(html).toContain("running: 'Ready'");
    expect(html).toContain("statusRefreshNeeded");
  });

  it("explains agent choices and gives beginners a recommendation", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain("Easiest start if you already have a ChatGPT plan");
    expect(html).toContain("works with several model providers");
    expect(html).toContain("easy start");
    expect(html).toContain("Not sure? Pick Codex if you have ChatGPT");
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
    expect(html).toContain("<legend>1. Pick your coding agents");
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
