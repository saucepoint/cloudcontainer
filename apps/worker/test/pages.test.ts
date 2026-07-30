import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { app as workerApp } from "../src/index.js";
import { DashboardPage } from "../src/pages/dashboard.js";
import {
  LandingPage,
  NotFoundPage,
  OnboardingPage,
  SecurityPage,
  VerificationPage,
} from "../src/pages/views.js";
import { PAGE_STYLES } from "../src/pages/styles.js";
import { createTestSession, makeEnv, seedUser } from "./helpers/env.js";

function inlineScriptsOf(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.trim());
}

const landingClient = readFileSync(new URL("../client/landing.tsx", import.meta.url), "utf8");
const accountClient = readFileSync(new URL("../client/account.tsx", import.meta.url), "utf8");
const securityClient = readFileSync(new URL("../client/security.ts", import.meta.url), "utf8");
const onboardingClient = readFileSync(new URL("../client/onboarding.ts", import.meta.url), "utf8");
const authFlowsClient = readFileSync(new URL("../client/auth-flows.tsx", import.meta.url), "utf8");
const dashboardClient = [
  "dashboard.tsx",
  "dashboard-model.ts",
  "dashboard-ssh.tsx",
].map((file) => readFileSync(new URL(`../client/${file}`, import.meta.url), "utf8")).join("\n");
const uiClient = readFileSync(new URL("../client/ui.tsx", import.meta.url), "utf8");

const pages: Array<[string, () => unknown]> = [
  ["landing", () => LandingPage({ devAuth: false })],
  ["security", () => SecurityPage({
    passkeyCount: 0,
    continueHref: "/onboarding",
    welcome: true,
  })],
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

describe("landing page call to action", () => {
  it("uses the workbench value proposition before the client-rendered sign-in choices", () => {
    const html = String(LandingPage({ devAuth: false }));
    expect(html).toContain("<title>usebench.dev</title>");
    expect(html).toContain('work<span class="logo-bench">bench</span>');
    expect(html).toContain("A cloud workbench");
    expect(html).toContain("an always-on container for long running coding agents");
    expect(html).toContain("free for each unique person");
    expect(html.indexOf("free tier")).toBeLessThan(html.indexOf('id="landing-auth-root"'));
  });

  it("presents the free capacity first and labels the larger tier as upcoming", () => {
    const html = String(LandingPage({ devAuth: false }));
    const freeTier = "1 vCPU · 1.5 GB RAM · 1 GB Swap · 5 GB Storage · Debian 13";
    const premiumTier = "2 vCPU · 4 GB RAM · 8 GB Storage · Debian 13";
    expect(html).toContain(freeTier);
    expect(html).toContain(premiumTier);
    expect(html).toContain('<span class="muted tier-label">coming soon</span>');
    expect(html.indexOf(freeTier)).toBeLessThan(html.indexOf(premiumTier));
  });

  it("offers Google, GitHub, and passkey entry points", () => {
    const html = String(LandingPage({ devAuth: false }));
    expect(html).toContain('id="landing-auth-root"');
    for (const label of [
      "Sign in with Google",
      "Sign in with GitHub",
      "Create passkey",
      "Use passkey",
    ]) expect(landingClient).toContain(label);
    expect(landingClient).not.toContain("Sign in with Apple");
    expect(landingClient).toContain("authClient.signIn.social");
    expect(landingClient).toContain("authClient.passkey.addPasskey");
    expect(landingClient).toContain("authClient.signIn.passkey");
  });
});

describe("sign-in button icons", () => {
  it("pairs landing SSO buttons with Radix and brand icons", () => {
    expect(landingClient).toContain('from "@radix-ui/react-icons"');
    expect(landingClient).toContain("GitHubLogoIcon");
    expect(landingClient).toContain("LockClosedIcon");
    expect(landingClient).toContain("GoogleIcon");
    expect(landingClient).not.toContain("AppleIcon");
    expect(landingClient).toContain('from "./icons.js"');
  });

  it("inlines Radix icons into the GitHub onboarding actions", () => {
    const html = String(OnboardingPage({ githubAvailable: true }));
    const copilot = html.slice(
      html.indexOf('id="copilot-signin"'),
      html.indexOf('id="copilot-signin"') + 2000,
    );
    expect(copilot).toContain('viewBox="0 0 15 15"');
    expect(copilot).toContain("Sign in with GitHub");
    const connect = html.slice(
      html.indexOf('id="github-connect"'),
      html.indexOf('id="github-connect"') + 2000,
    );
    expect(connect).toContain('viewBox="0 0 15 15"');
    expect(connect).toContain("Connect or update GitHub");
    expect(html).toContain(".btn svg, .link-btn svg { width: 1em; height: 1em;");
  });
});

describe("account eligibility verification", () => {
  it("offers World ID and invite verification before onboarding", () => {
    const html = String(VerificationPage({ worldIdAvailable: true }));
    expect(html).toContain('id="account-verification-root"');
    expect(html).toContain('data-world-id-available="true"');
    expect(html).toContain('src="/account.js"');
    expect(html).toContain("World ID");
    expect(html).toContain("invite");
  });

  it("omits the World ID action when the deployment is not configured", () => {
    const html = String(VerificationPage({ worldIdAvailable: false }));
    expect(html).toContain('data-world-id-available="false"');
    expect(accountClient).toContain('root.dataset.worldIdAvailable === "true"');
    expect(accountClient).toContain("worldIdAvailable ? (");
  });

  it("requests only current World ID 4 Proof of Human credentials", () => {
    expect(accountClient).toContain("World ID verification failed (${code})");
    expect(accountClient).toContain("worldIdErrorMessage(completion.error)");
    expect(accountClient).toContain('idKit.CredentialRequest("proof_of_human", { signal })');
    expect(accountClient).not.toContain("proofOfHuman");
    expect(accountClient).not.toContain("orbLegacy");
    expect(accountClient).toContain('postJson("/api/account/world-id/verify", completion.result)');
  });

  it("opens World App on mobile and presents an inline QR code on desktop", () => {
    expect(accountClient).toContain('window.matchMedia("(max-width: 700px)").matches');
    expect(accountClient).toContain('window.open("", "_blank")');
    expect(accountClient).toContain("mobileTarget.location.replace(request.connectorURI)");
    expect(accountClient).toContain("toDataURL(request.connectorURI");
    expect(accountClient).toContain('className="world-id-qr"');
    expect(accountClient).toContain('alt="QR code to continue verification in World App"');
  });

  it("reports World ID progress and errors under the action without a confirmation dialog", () => {
    const action = accountClient.indexOf("Continue with World ID →</button>");
    const status = accountClient.indexOf("{worldStatus}</p>");
    expect(action).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(action);
    expect(accountClient).toContain('role={worldError ? "alert" : "status"}');
    expect(accountClient).not.toContain('from "@base-ui/react/dialog"');
    expect(accountClient).not.toContain("<Dialog.");
  });

  it("loads pinned IDKit assets externally instead of shipping WebAssembly", () => {
    expect(accountClient).toContain("cdn.jsdelivr.net/npm/@worldcoin/idkit-core@4.2.2");
    expect(accountClient).toContain("IDKIT_SCRIPT_INTEGRITY");
    expect(accountClient).not.toContain('from "@worldcoin/idkit"');
  });
});

describe("passkey security page", () => {
  it("encourages users to add a backup passkey", () => {
    const security = String(SecurityPage({
      passkeyCount: 1,
      continueHref: "/dashboard",
      welcome: false,
    }));
    expect(security).toContain('src="/security.js"');
    expect(securityClient).toContain("authClient.passkey.addPasskey");
    expect(security).toContain("This account uses passkeys to sign in");
    expect(security).toContain("Add another passkey");
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

  it("places the collapsed API-key section directly below agent selection", () => {
    const html = String(OnboardingPage({}));
    const agents = html.indexOf("1. Coding agents");
    const apiKeys = html.indexOf("Add API keys");
    const advanced = html.indexOf("2. Advanced");
    expect(html).not.toContain("Add API keys or sign in to a provider");
    expect(apiKeys).toBeGreaterThan(agents);
    expect(apiKeys).toBeLessThan(advanced);
    expect(html.indexOf('<div class="card">', apiKeys)).toBeGreaterThan(apiKeys);
    const section = html.slice(apiKeys, html.indexOf("</details>", apiKeys));
    expect(section).toContain("Sign in with GitHub");
    expect(section).toContain('name="llm_opencode_go"');
    expect(section).toContain('name="llm_anthropic"');
    expect(section).toContain('href="https://console.anthropic.com/settings/keys"');
    expect(section).toContain('href="https://platform.openai.com/api-keys"');
    for (const [name, keyUrl] of [
      ["llm_deepseek", "https://platform.deepseek.com/api_keys"],
      ["llm_kimi", "https://platform.kimi.com/"],
      ["llm_minimax", "https://platform.minimax.io/account/api-keys"],
      ["llm_zai", "https://z.ai/manage-apikey"],
      ["llm_vercel_ai_gateway", "https://vercel.com/ai-gateway"],
    ]) {
      expect(section).toContain(`name="${name}"`);
      expect(section).toContain(`href="${keyUrl}"`);
    }
  });

  it("gives the ChatGPT device code a dedicated copy affordance", () => {
    const codexFlow = authFlowsClient.slice(
      authFlowsClient.indexOf("export const codexDeviceFlow"),
      authFlowsClient.indexOf("export const copilotDeviceFlow"),
    );
    expect(codexFlow).toContain("copyCode: true");
    expect(authFlowsClient).toContain('"Copy code"');
    expect(authFlowsClient).toContain("device-flow-code");
  });

  it("keeps the Claude authorization-code field visible inside the agent card", () => {
    expect(PAGE_STYLES).toContain(".agent-choice input {");
    expect(PAGE_STYLES).not.toContain(".agent input {");
    expect(authFlowsClient).toContain('id={config.inputId}');
  });

  it("keeps Claude sign-in instructions aligned with the flow container", () => {
    expect(PAGE_STYLES).toContain(".flow-steps { margin: 0.6rem 0; padding-left: 1.2rem; }");
    expect(PAGE_STYLES).not.toContain(".flow-steps { margin: 0.6rem 0 0.6rem 1.2rem; }");
  });

  it("dashboard omits credential management after server creation", () => {
    const html = String(DashboardPage({}));
    for (const flow of ["claudeOauthFlow", "codexDeviceFlow", "copilotDeviceFlow", "wranglerOauthFlow"]) {
      expect(html).not.toContain(flow);
    }
    expect(dashboardClient).not.toContain("CredentialsCard");
    expect(dashboardClient).not.toContain("/api/credentials");
    expect(html).not.toContain("Changes apply without a restart");
  });
});

describe("onboarding wizard order", () => {
  it("keeps API keys below agents and SSH keys inside Advanced", () => {
    const html = String(OnboardingPage({}));
    const agents = html.indexOf("1. Coding agents");
    const apiKeys = html.indexOf("Add API keys");
    const advanced = html.indexOf("2. Advanced");
    expect(agents).toBeGreaterThan(-1);
    expect(apiKeys).toBeGreaterThan(agents);
    expect(advanced).toBeGreaterThan(apiKeys);
    // The SSH key field stays behind the Advanced section.
    expect(html.indexOf('name="sshPubkey"')).toBeGreaterThan(advanced);
    expect(html.slice(advanced)).toContain("Add an SSH public key manually");
    expect(html.slice(advanced, html.indexOf('name="sshPubkey"'))).toContain("<details>");
  });

  it("places provider access between agent selection and optional GitHub setup", () => {
    const html = String(OnboardingPage({ githubAvailable: true }));
    const agents = html.indexOf("1. Coding agents");
    const apiKeys = html.indexOf("Add API keys");
    const github = html.indexOf("2. GitHub");

    expect(apiKeys).toBeGreaterThan(agents);
    expect(apiKeys).toBeLessThan(github);
  });

  it("uses workbench terminology for the immutable setup warning", () => {
    const html = String(OnboardingPage({ githubAvailable: true }));
    expect(html).toContain("Set up a workbench.");
    expect(html).toContain("After it is provisioned, changes require manual terminal commands.");
  });
});

describe("GitHub repository onboarding", () => {
  it("offers one combined GitHub connection action and repository selection", () => {
    const enabled = String(OnboardingPage({ githubAvailable: true }));
    expect(enabled).toContain("Connect or update GitHub");
    expect(enabled).toContain("/auth/github?return_to=/onboarding");
    expect(enabled).not.toContain("Reauthorize GitHub");
    expect(enabled).not.toContain("/auth/github/install");
    expect(onboardingClient).not.toContain("/auth/github/reauth");
    expect(onboardingClient).toContain("/api/github/repos");
    expect(onboardingClient).toContain('name="githubRepo"');
    expect(enabled).toContain("~/repos");
    expect(enabled).toContain('id="github-repo-search"');

    const disabled = String(OnboardingPage({ githubAvailable: false }));
    expect(disabled).not.toContain("Connect or update GitHub");
    expect(disabled).not.toContain('id="github-repos"');
  });

  it("keeps repository selection visible when GitHub is configured", () => {
    const enabled = String(OnboardingPage({ githubAvailable: true }));
    expect(enabled).toContain("Connect or update GitHub");
    expect(enabled).toContain("/auth/github?return_to=/onboarding");
    expect(enabled).toContain('id="github-repo-search"');
    expect(enabled).toContain('id="github-repos"');
  });

  it("hides GitHub setup from onboarding without an App slug", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-id",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
      GITHUB_APP_SLUG: "",
    });
    const user = await seedUser(env);
    const sessionCookie = await createTestSession(env, user.id);
    const response = await workerApp.request(
      "/onboarding",
      { headers: { cookie: sessionCookie } },
      env,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).not.toContain('id="github-connect"');
    expect(html).not.toContain('id="github-repos"');
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
  it("shows SSH access and only unlocks key setup after a successful build", () => {
    const renderedDashboard = dashboardClient.slice(dashboardClient.indexOf("if (!loaded)"));
    expect(renderedDashboard).toContain('id="ssh-heading"');
    expect(renderedDashboard).not.toContain("<CredentialsCard");
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
    expect(dashboardClient).toContain("SSH setup unlocks after the workbench is ready");
    expect(dashboardClient).not.toContain("Finish building the server before adding keys or creating an agent setup prompt");
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
    expect(dashboardClient).toContain('height: 0');
    expect(dashboardClient).toContain('height: "auto"');
    expect(dashboardClient).toContain('aria-pressed={enrollmentMode === "agent"}');
    expect(dashboardClient).toContain('aria-pressed={enrollmentMode === "manual"}');
    expect(dashboardClient).not.toContain('{enrollment ? <div>');
    expect(dashboardClient).not.toContain('{showForm ? <div id="keyform">');
  });

  it("keeps the agent prompt collapsed until requested and prioritizes copying it", () => {
    const enrollmentView = dashboardClient.slice(
      dashboardClient.indexOf('enrollmentMode === "agent" && enrollment'),
      dashboardClient.indexOf(') : enrollmentMode === "manual" ? ('),
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

  it("allows Claude and ChatGPT sign-in flows to be active independently", () => {
    expect(authFlowsClient).toContain("const activeFlows = new WeakSet<HTMLElement>();");
    expect(authFlowsClient).toContain("const flowRoots = new WeakMap<HTMLElement, Root>();");
    expect(authFlowsClient).not.toContain("let active = false;");
    expect(authFlowsClient).not.toContain("let activeRoot: Root | null = null;");
    expect(onboardingClient).toContain("isAuthFlowActive(target)");
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

  it("has live status regions, visible retryable dashboard errors, and reduced-motion support", () => {
    const html = String(DashboardPage({}));
    expect(dashboardClient).toContain('role="alert" aria-live="assertive"');
    expect(dashboardClient).toContain('role="status" aria-live="polite"');
    expect(dashboardClient).toContain("Try again");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain(":focus-visible");
    expect(uiClient).toContain("HTMLDetailsElement");
    expect(uiClient).toContain("details.open = true");
    expect(uiClient).toContain("details.open = false");
  });
});

describe("interface foundation", () => {
  it.each(pages)("%s loads the shared Base UI and Motion client", (_name, render) => {
    const html = String(render());
    expect(html).toContain('<div id="ui-root"></div>');
    expect(html).toContain('<script type="module" src="/ui.js"></script>');
  });

  it("uses borderless actions with solid treatment reserved for primary CTAs", () => {
    const html = String(LandingPage({ devAuth: false }));
    expect(html).toContain("color-scheme: light");
    expect(html).toContain(".btn, .link-btn { padding: 0.35rem 0.2rem; border: 0;");
    expect(html).toContain(".btn.primary { padding: 0.45rem 0.95rem; border: 1px solid var(--accent);");
    expect(html).toContain("background: var(--accent); color: #fff");
    expect(html).toContain(".btn.danger { background: transparent; color: var(--danger); }");
    expect(html).toContain(".btn.danger-solid:hover { background: var(--danger-strong)");
    expect(html).toContain("text-decoration: underline;");
  });

  it("serves a self-hosted grotesque as the UI typeface", () => {
    const html = String(LandingPage({ devAuth: false }));
    expect(html).toContain("@font-face");
    expect(html).toContain('/fonts/ibm-plex-sans-latin.woff2');
    expect(html).toContain('--sans: "IBM Plex Sans", Arial, Helvetica, sans-serif;');
    expect(html).toContain("font: 15px/1.5 var(--sans);");
    expect(html).toContain('rel="preload" href="/fonts/ibm-plex-sans-latin.woff2"');
  });

  it("ships a favicon and serves a branded 404 page", async () => {
    const html = String(LandingPage({ devAuth: false }));
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg"');
    const notFound = String(NotFoundPage({}));
    expect(notFound).toContain("Page not found.");
    expect(notFound).toContain('href="/"');

    const pageResponse = await workerApp.request("/missing", {}, makeEnv());
    expect(pageResponse.status).toBe(404);
    expect(pageResponse.headers.get("content-type")).toContain("text/html");
    expect(await pageResponse.text()).toContain("Page not found.");

    const apiResponse = await workerApp.request("/api/missing", {}, makeEnv());
    expect(apiResponse.status).toBe(404);
    expect(apiResponse.headers.get("content-type")).toContain("application/json");
    await expect(apiResponse.json()).resolves.toEqual({ error: "not found" });
  });

  it("left-aligns the landing hero", () => {
    const html = String(LandingPage({ devAuth: false }));
    expect(html).toContain('class="landing-hero"');
    expect(html).toContain(".landing-hero { text-align: left; }");
  });

  it("accents bench in the workbench wordmark and groups compact landing auth actions", () => {
    const html = String(LandingPage({ devAuth: false }));
    expect(html).toContain('work<span class="logo-bench">bench</span>');
    expect(html).toContain(".logo-bench { color: var(--accent); }");
    expect(html).toContain(".auth-provider-list { display: grid; width: min(100%, 25rem);");
    expect(html).toContain("border: 1px solid var(--line); border-radius: var(--radius);");
    expect(html).toContain(".auth-provider { width: min(100%, 18rem); justify-self: center;");
  });

  it("reserves sign-in space only on agent tiles that have one", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain(".agent:has(.agent-signin) .agent-choice { padding-right: 9.5rem; }");
    expect(html).toContain(".agent:has(.agent-signin) .agent-choice { padding-right: 1rem; }");
  });

  it("shows a skeleton while the dashboard loads", () => {
    const html = String(DashboardPage({}));
    expect(html).toContain('class="skel skel-title"');
    expect(html).toContain("aria-busy");
    expect(html).toContain(".skel::after");
  });

  it("renders destructive confirmations with a solid danger action", () => {
    expect(uiClient).toContain('confirmation.danger ? "btn danger-solid" : "btn primary"');
  });

  it("visually separates text fields from structural dividers", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain(
      "background: var(--field); color: var(--ink); border: 1px solid var(--line-strong);",
    );
    expect(html).toContain("border-radius: var(--radius); padding: 0.64rem 0.7rem;");
    expect(html).toContain("input:hover, textarea:hover, select:hover { border-color: var(--line-strong); }");
    expect(html).toContain(
      "input:focus, textarea:focus, select:focus { background: #fff; border-color: var(--focus);",
    );
  });

  it("centers the compact auth group within the full-width landing section", () => {
    const html = String(LandingPage({ devAuth: false }));
    expect(html).toContain('class="card landing-signin"');
    expect(html).toContain('class="landing-signin-content" role="region"');
    expect(html).not.toContain('>Sign in or create an account</h2>');
    expect(html).toContain(".landing-signin-content { width: 100%; }");
    expect(html).toContain("margin: 1rem auto 0;");
  });

  it("uses spacing, bullets, and grouped surfaces instead of row dividers", () => {
    const html = String(OnboardingPage({ githubAvailable: true }));
    expect(html).toContain('.check li::before { content: "";');
    expect(html).toContain('.provider::before { content: "";');
    expect(html).toContain("grid-template-columns: 0.34rem minmax(0, 1fr) auto;");
    expect(html).toContain(".provider > * { grid-column: 2; }");
    expect(html).toContain(".repo-choice input { flex: 0 0 auto; margin: 0.2rem 0 0;");
    expect(html).toContain(".repo-list { display: grid; gap: 0.3rem;");
    expect(html).toContain("background: var(--surface); border: 0; border-radius: var(--radius);");
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
