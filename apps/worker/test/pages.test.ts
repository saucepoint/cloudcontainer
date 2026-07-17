import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { app as workerApp } from "../src/index.js";
import { DashboardPage } from "../src/pages/dashboard.js";
import { LandingPage, OnboardingPage } from "../src/pages/views.js";
import { createSession } from "../src/sessions.js";
import { makeEnv, seedUser } from "./helpers/env.js";

const workerPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: { "build:client": string } };

function inlineScriptsOf(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.trim());
}

const landingClient = readFileSync(new URL("../client/landing.ts", import.meta.url), "utf8");
const onboardingClient = readFileSync(new URL("../client/onboarding.ts", import.meta.url), "utf8");
const authFlowsClient = readFileSync(new URL("../client/auth-flows.tsx", import.meta.url), "utf8");
const dashboardClient = readFileSync(new URL("../client/dashboard.tsx", import.meta.url), "utf8");

const pages: Array<[string, () => unknown]> = [
  ["landing", () => LandingPage({ devAuth: false, worldIdEnvironment: "production" })],
  ["onboarding", () => OnboardingPage({})],
  ["dashboard", () => DashboardPage({})],
];

describe("compiled page clients", () => {
  for (const [name, render] of pages) {
    it(`${name} uses external modules without inline behavior`, () => {
      const html = String(render());
      expect(html).toContain(`<script type="module" src="/${name}.js"></script>`);
      expect(inlineScriptsOf(html)).toEqual([]);
      expect(html).not.toContain("onclick=");
    });
  }
});

describe("World ID environment wiring", () => {
  it("renders the configured environment independently of dev auth", () => {
    const html = String(LandingPage({ devAuth: true, worldIdEnvironment: "production" }));
    expect(html).toContain('data-world-id-environment="production"');
    expect(landingClient).toContain('button!.dataset.worldIdEnvironment === "staging"');
    expect(html).toContain("Dev login");
  });

  it("discards stale non-v4 session IDs before calling proveSession", () => {
    expect(landingClient).toContain("/^session_[0-9a-f]{128}$/i");
    expect(landingClient).toContain("localStorage.removeItem(SESSION_STORAGE_KEY)");
  });

  it("sends World ID's documented proof-of-human session constraint tree", () => {
    expect(landingClient).toContain('constraints(any(CredentialRequest("proof_of_human")))');
  });

  it("bundles typed IDKit and QR dependencies without a runtime CDN global", () => {
    const html = String(LandingPage({ devAuth: false, worldIdEnvironment: "production" }));
    expect(landingClient).toContain('from "@worldcoin/idkit-core"');
    expect(landingClient).toContain('import QRCode from "qrcode"');
    expect(html).not.toContain("cdn.jsdelivr.net");
  });

  it("ships the IDKit WebAssembly sidecar at the URL used by the bundle", () => {
    expect(workerPackage.scripts["build:client"]).toContain(
      "@worldcoin/idkit-core/dist/idkit_wasm_bg.wasm public/idkit_wasm_bg.wasm",
    );
  });
});

describe("landing page call to action", () => {
  it("shows server information before the World ID sign-in", () => {
    const html = String(LandingPage({ devAuth: false, worldIdEnvironment: "production" }));
    expect(html.indexOf("free tier")).toBeLessThan(html.indexOf("Continue with World ID"));
  });
});

describe("subscription sign-in wiring", () => {
  it("onboarding offers every subscription sign-in and no auth.json paste path", () => {
    const html = String(OnboardingPage({}));
    for (const flow of ["claudeOauthFlow", "codexDeviceFlow", "copilotDeviceFlow", "wranglerOauthFlow"]) {
      expect(authFlowsClient).toContain(`export const ${flow}`);
      expect(onboardingClient).toContain(flow);
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

  it("keeps provider sign-ins and API keys inside one collapsed section", () => {
    const html = String(OnboardingPage({}));
    const apiKeys = html.indexOf("Add API keys or sign in to a provider");
    expect(html).not.toContain("Model access");
    expect(apiKeys).toBeGreaterThan(-1);
    const section = html.slice(apiKeys, html.indexOf("</details>", apiKeys));
    expect(section).toContain("Sign in with GitHub");
    expect(section).toContain('name="llm_opencode_go"');
    expect(section).toContain('name="llm_anthropic"');
    expect(section).toContain('href="https://console.anthropic.com/settings/keys"');
    expect(section).toContain('href="https://platform.openai.com/api-keys"');
  });

  it("dashboard keeps credentials read-only after server creation", () => {
    const html = String(DashboardPage({}));
    for (const flow of ["claudeOauthFlow", "codexDeviceFlow", "copilotDeviceFlow", "wranglerOauthFlow"]) {
      expect(html).not.toContain(flow);
    }
    expect(dashboardClient).toContain("Set during setup");
    expect(dashboardClient).toContain("manual terminal commands");
    expect(dashboardClient).not.toContain("/api/credentials");
    expect(html).not.toContain("Changes apply without a restart");
  });
});

describe("onboarding wizard order", () => {
  it("goes agents → collapsed provider access → advanced config, with SSH keys inside Advanced", () => {
    const html = String(OnboardingPage({}));
    const agents = html.indexOf("1. Coding agents");
    const apiKeys = html.indexOf("Add API keys or sign in to a provider");
    const advanced = html.indexOf("2. Advanced");
    expect(agents).toBeGreaterThan(-1);
    expect(apiKeys).toBeGreaterThan(agents);
    expect(advanced).toBeGreaterThan(apiKeys);
    // The SSH key field stays behind the Advanced section.
    expect(html.indexOf('name="sshPubkey"')).toBeGreaterThan(advanced);
    expect(html.slice(advanced)).toContain("Add an SSH public key myself");
    expect(html.slice(advanced, html.indexOf('name="sshPubkey"'))).toContain("<details>");
  });

  it("places provider access between agent selection and optional GitHub setup", () => {
    const html = String(OnboardingPage({ githubAvailable: true }));
    const agents = html.indexOf("1. Coding agents");
    const apiKeys = html.indexOf("Add API keys or sign in to a provider");
    const github = html.indexOf("2. GitHub");

    expect(apiKeys).toBeGreaterThan(agents);
    expect(apiKeys).toBeLessThan(github);
  });

  it("warns that credentials can only be changed from the server terminal after setup", () => {
    const html = String(OnboardingPage({ githubAvailable: true }));
    expect(html).toContain("Choose agents and credentials before creating your server");
    expect(html).toContain("After it is provisioned, changes require manual terminal commands");
  });
});

describe("GitHub repository onboarding", () => {
  it("offers App installation, separate OAuth reauthorization, and repository selection", () => {
    const enabled = String(OnboardingPage({
      githubAvailable: true,
      githubInstallationAvailable: true,
    }));
    expect(enabled).toContain("Install or manage GitHub access");
    expect(enabled).toContain("Reauthorize GitHub");
    expect(onboardingClient).toContain("/auth/github/reauth");
    expect(enabled).toContain("/auth/github/install?return_to=/onboarding");
    expect(onboardingClient).toContain("/api/github/repos");
    expect(onboardingClient).toContain('name="githubRepo"');
    expect(enabled).toContain("~/repos");
    expect(enabled).toContain('id=\"github-repo-search\"');

    const disabled = String(OnboardingPage({ githubAvailable: false }));
    expect(disabled).not.toContain("Connect or reconnect GitHub");
    expect(disabled).not.toContain('id=\"github-repos\"');
  });

  it("keeps repository selection visible when only GitHub OAuth is configured", () => {
    const enabled = String(OnboardingPage({ githubAvailable: true }));
    expect(enabled).toContain("Connect GitHub");
    expect(enabled).toContain("/auth/github?return_to=/onboarding");
    expect(enabled).toContain('id=\"github-repo-search\"');
    expect(enabled).toContain('id=\"github-repos\"');
    expect(enabled).not.toContain("/auth/github/install?return_to=/onboarding");
  });

  it("renders repository selection from the onboarding route without an App slug", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_SLUG: "",
    });
    const user = await seedUser(env);
    const sessionId = await createSession(env, user.id);
    const response = await workerApp.request(
      "/onboarding",
      { headers: { cookie: `cs_session=${sessionId}` } },
      env,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('id="github-repo-search"');
    expect(html).toContain('id="github-repos"');
  });

  it("restores agent choices after GitHub authorization without replacing the server-rendered controls", () => {
    expect(onboardingClient).toContain("const selected = new Set(");
    expect(onboardingClient).toContain("input.checked = selected.has(input.value)");
    expect(onboardingClient).toContain("sessionStorage.removeItem(agentSelectionKey)");
    expect(String(OnboardingPage({ githubAvailable: true }))).not.toContain("data-checked");
  });
});

describe("dashboard loading and polling", () => {
  it("loads one dashboard snapshot, then polls only container state without replacing forms", () => {
    const load = dashboardClient.slice(
      dashboardClient.indexOf("const loadDashboard"),
      dashboardClient.indexOf("React.useEffect(() => { void loadDashboard()"),
    );
    const poll = dashboardClient.slice(
      dashboardClient.indexOf("const pollContainer = async"),
      dashboardClient.indexOf("const act"),
    );

    expect(load).toContain('api<DashboardSnapshot>("/api/dashboard")');
    expect(load).toContain("setCredentials(snapshot.credentials)");
    expect(load).toContain("setKeys(snapshot.keys)");
    expect(poll).toContain('api<{ container: ContainerView | null }>("/api/container")');
    expect(poll).not.toContain("/api/credentials");
    expect(poll).not.toContain("/api/keys");
  });

  it("uses non-overlapping, visibility-aware polling with distinct build and waitlist delays", () => {
    expect(dashboardClient).toContain('if (container.status === "waitlisted") return 30_000');
    expect(dashboardClient).toContain("if (isBusy(container)) return 5_000");
    expect(dashboardClient).toContain("setTimeout(pollContainer, delay)");
    expect(dashboardClient).toContain("pollInFlight");
    expect(dashboardClient).toContain("document.hidden");
    expect(dashboardClient).toContain("visibilitychange");
    expect(dashboardClient).not.toContain("setInterval(");
  });
});

describe("beginner-friendly provisioning UI", () => {
  it("puts SSH access before credentials and only unlocks key setup after a successful build", () => {
    const renderedDashboard = dashboardClient.slice(dashboardClient.indexOf("if (!loaded)"));
    expect(renderedDashboard.indexOf('id="ssh-heading"')).toBeLessThan(
      renderedDashboard.indexOf("<CredentialsCard"),
    );
    expect(dashboardClient).toContain("Copy SSH command");
    expect(dashboardClient).toContain("Set up SSH with an agent");
    expect(dashboardClient).toContain("Enroll another device");
    expect(dashboardClient).toContain("ssh-keygen -t ed25519");
    expect(dashboardClient).toContain("Never paste your private key");
    expect(dashboardClient).toContain('id="enroll"');
    expect(dashboardClient).toContain('waitlisted: "Waiting for capacity"');
    expect(dashboardClient).toContain('running: "Ready"');
    expect(dashboardClient).toContain("refreshNeeded");
    expect(dashboardClient).toContain("function canManageSshKeys(container");
    expect(dashboardClient).toContain('container?.status === "running"');
    expect(dashboardClient).toContain("SSH setup unlocks after the server is ready");
    expect(dashboardClient).toContain("Finish building the server before adding keys or creating an agent setup prompt");
    expect(dashboardClient).toContain('container.status === "running" && !hasKeys');
    expect(dashboardClient).toContain("Add an SSH key to reveal your connection command");
    expect(dashboardClient).toContain("You cannot see the SSH host or port until a key has been added");
    expect(dashboardClient.indexOf('container.status === "running" && !hasKeys')).toBeLessThan(
      dashboardClient.indexOf("if (container.sshCommand)"),
    );
    expect(dashboardClient).toContain("refreshKeysAndConnection");
  });

  it("keeps agent enrollment and manual key entry as exclusive, animated paths", () => {
    expect(dashboardClient).toContain('import { AnimatePresence, motion, useReducedMotion } from "motion/react"');
    expect(dashboardClient).toContain('type EnrollmentMode = "agent" | "manual";');
    expect(dashboardClient).toContain('const [enrollmentMode, setEnrollmentMode] = React.useState<EnrollmentMode | null>(null);');
    expect(dashboardClient).toContain('enrollmentMode === "agent" && enrollment');
    expect(dashboardClient).toContain('enrollmentMode === "manual"');
    expect(dashboardClient).toContain('<AnimatePresence initial={false} mode="wait">');
    expect(dashboardClient).toContain('initial={reducedMotion ? false : { opacity: 0, y: 4 }}');
    expect(dashboardClient).not.toContain('{enrollment ? <div>');
    expect(dashboardClient).not.toContain('{showForm ? <div id="keyform">');
  });

  it("keeps the agent prompt collapsed until requested and prioritizes copying it", () => {
    const enrollmentView = dashboardClient.slice(
      dashboardClient.indexOf('enrollmentMode === "agent" && enrollment'),
      dashboardClient.indexOf('enrollmentMode === "manual"'),
    );
    expect(enrollmentView.indexOf('Copy prompt')).toBeLessThan(enrollmentView.indexOf('<details>'));
    expect(enrollmentView).toContain('<summary>Review the setup prompt</summary>');
    expect(enrollmentView).toContain('<pre className="ssh prompt" id="enrollprompt">{prompt}</pre>');
  });

  it("explains agent choices without recommending one", () => {
    const html = String(OnboardingPage({}));
    expect(html).not.toContain("common choice");
    expect(html).toContain("1. Coding agents");
    expect(html).toContain("Sign in with Claude");
    expect(html).toContain("Sign in with ChatGPT");
    expect(html).toContain(".agent-signin { grid-column: 1; grid-row: 1;");
    expect(html).toContain("align-self: start; justify-self: end;");
    expect(html.indexOf("Sign in with Claude")).toBeGreaterThan(html.indexOf("Claude Code"));
    expect(html.indexOf("Sign in with ChatGPT")).toBeGreaterThan(html.indexOf("Codex"));
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
    for (const agent of ["pi", "claude", "codex", "opencode"]) {
      expect(html).toContain(`name="agent" value="${agent}" id="agent-${agent}"`);
      expect(html).toContain(`for="agent-${agent}"`);
    }
    expect(html).toContain('for="ssh-pubkey"');
    expect(html).toContain('id="err" class="err" role="alert" aria-live="assertive"');
  });

  it("has live status regions and visible retryable dashboard errors", () => {
    const html = String(DashboardPage({}));
    expect(dashboardClient).toContain('role="alert" aria-live="assertive"');
    expect(dashboardClient).toContain('role="status" aria-live="polite"');
    expect(dashboardClient).toContain("Try again");
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

  it("visually separates text fields from structural dividers", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain(
      "background: var(--field); color: var(--ink); border: 1px solid var(--line-strong);",
    );
    expect(html).toContain("border-radius: 5px; padding: 0.64rem 0.7rem;");
    expect(html).toContain("input:hover, textarea:hover, select:hover { border-color: var(--line-strong); }");
    expect(html).toContain(
      "input:focus, textarea:focus, select:focus { background: #fff; border-color: var(--focus);",
    );
  });

  it("uses spacing, bullets, and grouped surfaces instead of row dividers", () => {
    const html = String(OnboardingPage({ githubAvailable: true }));
    expect(html).toContain('.check li::before { content: "";');
    expect(html).toContain('.provider::before { content: "";');
    expect(html).toContain("grid-template-columns: 0.34rem minmax(0, 1fr) auto;");
    expect(html).toContain(".provider > * { grid-column: 2; }");
    expect(html).toContain(".repo-choice input { flex: 0 0 auto; margin: 0.2rem 0 0;");
    expect(html).toContain(".repo-list { display: grid; gap: 0.3rem;");
    expect(html).toContain("background: var(--surface); border: 0; border-radius: 4px;");
    expect(html).not.toContain(".check li:last-child { border-bottom: 0; }");
  });

  it("keeps iOS Safari from zooming when mobile text fields receive focus", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain("@media (max-width: 600px)");
    expect(html).toContain(
      "input[type=text], input[type=password], input[type=search], textarea, select { font-size: 16px; }",
    );
  });
});
