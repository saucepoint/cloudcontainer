import {
  checkbox,
  confirm,
  input,
  password,
  select,
} from "@inquirer/prompts";
import { openBrowser } from "./browser.js";
import {
  AGENT_DESCRIPTIONS,
  AGENT_LABELS,
  AGENTS,
  GITHUB_REPOSITORY_LIMIT,
  PASTEABLE_PROVIDERS,
  PROVIDER_LABELS,
  type Agent,
  type PasteableProvider,
} from "./catalog.js";
import { ApiClient, ApiError, errorMessage, wait } from "./http.js";
import { BACK, promptWithBack, type Back } from "./navigation.js";
import { maybeConfigureSshShortcut, chooseSshKey, type SelectedSshKey } from "./ssh.js";
import { verifyWithWorldId } from "./world-id.js";
import type { SessionState } from "./session.js";

interface CredentialsView {
  github: string | null;
}

interface Repository {
  fullName: string;
  private: boolean;
  archived: boolean;
  description?: string | null;
}

interface ContainerView {
  status: string;
  statusDetail: string | null;
  sshCommand: string | null;
  hostKeyFingerprints: string[];
}

interface ProvisionInput {
  agents: Agent[];
  sshPubkey?: string;
  llmKeys: Record<string, string>;
  cloudflareToken?: string;
  supabaseToken?: string;
  convexToken?: string;
  githubRepos: string[];
}

interface AdditionalTools {
  llmKeys: Record<string, string>;
  cloudflareToken?: string;
  supabaseToken?: string;
  convexToken?: string;
}

type AuthTarget =
  | { kind: "claude"; agent: "claude" | "pi" | "opencode" }
  | { kind: "chatgpt"; agent: "codex" | "pi" | "opencode" };

function agentAuthTargets(agents: Agent[]): AuthTarget[] {
  return agents.flatMap((agent): AuthTarget[] => {
    if (agent === "claude") return [{ kind: "claude", agent }];
    if (agent === "codex") return [{ kind: "chatgpt", agent }];
    return [
      { kind: "chatgpt", agent },
      { kind: "claude", agent },
    ];
  });
}

function authTargetLabel(target: AuthTarget): string {
  return `${target.kind === "claude" ? "Claude" : "ChatGPT"} for ${AGENT_LABELS[target.agent]}`;
}

async function chooseAgents(): Promise<Agent[] | Back> {
  const selected = await promptWithBack(checkbox<Agent>, {
    message: "Choose at least one coding agent",
    choices: AGENTS.map((agent) => ({
      name: AGENT_LABELS[agent],
      value: agent,
      description: AGENT_DESCRIPTIONS[agent],
    })),
    required: true,
  });
  if (selected === BACK) return BACK;
  return AGENTS.filter((agent) => selected.includes(agent));
}

async function runClaudeSignIn(api: ApiClient, agent: AuthTarget["agent"]): Promise<void | Back> {
  const start = await api.post<{ authorizeUrl: string }>("/api/claude/oauth/start", { agent });
  console.log(`\nOpening Claude sign-in…\n${start.authorizeUrl}`);
  openBrowser(start.authorizeUrl);
  const code = await promptWithBack(input, { message: "Paste the Claude authorization code (CODE#STATE)" });
  if (code === BACK) return BACK;
  await api.post("/api/claude/oauth/finish", { code, agent });
  console.log("Claude connected.");
}

async function pollDevice(
  start: { expiresInSec: number; intervalSec: number },
  poll: () => Promise<{ status?: string }>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + start.expiresInSec * 1_000;
  while (Date.now() < deadline) {
    await wait(start.intervalSec * 1_000);
    const result = await poll();
    if (result.status === "connected") {
      console.log(`${label} connected.`);
      return;
    }
  }
  throw new Error(`${label} sign-in expired.`);
}

async function runChatGptSignIn(api: ApiClient, agent: AuthTarget["agent"]): Promise<void | Back> {
  const start = await api.post<{
    verificationUrl: string;
    userCode: string;
    deviceAuthId: string;
    intervalSec: number;
    expiresInSec: number;
  }>("/api/codex/device", { agent });
  console.log(`\nOpen ${start.verificationUrl} and enter code ${start.userCode}.`);
  openBrowser(start.verificationUrl);
  await pollDevice(
    start,
    () => api.post<{ status?: string }>("/api/codex/device/poll", {
      deviceAuthId: start.deviceAuthId,
      userCode: start.userCode,
      agent,
    }),
    `ChatGPT for ${AGENT_LABELS[agent]}`,
  );
}

async function configureAgentAuth(api: ApiClient, agents: Agent[]): Promise<void | Back> {
  const targets = agentAuthTargets(agents);
  if (!targets.length) return;
  const selected = await promptWithBack(checkbox<AuthTarget>, {
    message: "Optional agent sign-ins",
    choices: targets.map((target) => ({ name: authTargetLabel(target), value: target })),
    required: false,
  });
  if (selected === BACK) return BACK;
  for (const target of selected) {
    const result = target.kind === "claude"
      ? await runClaudeSignIn(api, target.agent)
      : await runChatGptSignIn(api, target.agent);
    if (result === BACK) return BACK;
  }
}

async function verifyAccount(api: ApiClient, state: SessionState): Promise<SessionState> {
  if (state.verified) return state;
  while (true) {
    const method = await promptWithBack(select, {
      message: "Verify your usebench account",
      choices: [
        ...(state.worldIdAvailable ? [{ name: "Verify with World ID (QR code)", value: "world" as const }] : []),
        { name: "Enter an invite code", value: "invite" as const },
      ],
    });
    if (method === BACK) continue;
    if (method === "world") {
      await verifyWithWorldId(api);
    } else {
      const code = await promptWithBack(input, {
        message: "Eight-character invite code",
        validate: (value) => /^[A-Za-z0-9]{8}$/.test(value.trim()) || "Enter exactly eight letters or numbers.",
      });
      if (code === BACK) continue;
      await api.post("/api/account/invite/verify", { code: code.trim().toUpperCase() });
    }
    console.log("Account verified.");
    return api.get<SessionState>("/api/cli/session");
  }
}

async function runCopilotSignIn(api: ApiClient): Promise<void> {
  const start = await api.post<{
    verificationUrl: string;
    userCode: string;
    deviceCode: string;
    intervalSec: number;
    expiresInSec: number;
  }>("/api/copilot/device");
  console.log(`\nOpen ${start.verificationUrl} and enter code ${start.userCode}.`);
  openBrowser(start.verificationUrl);
  await pollDevice(
    start,
    () => api.post<{ status?: string }>("/api/copilot/device/poll", { deviceCode: start.deviceCode }),
    "GitHub Copilot",
  );
}

async function runWranglerSignIn(api: ApiClient): Promise<void | Back> {
  const start = await api.post<{ authorizeUrl: string }>("/api/wrangler/oauth/start");
  console.log(`\nOpening Cloudflare sign-in…\n${start.authorizeUrl}`);
  openBrowser(start.authorizeUrl);
  const callbackUrl = await promptWithBack(input, { message: "Paste the full localhost callback URL" });
  if (callbackUrl === BACK) return BACK;
  await api.post("/api/wrangler/oauth/finish", { callbackUrl });
  console.log("Cloudflare connected.");
}

async function runConvexSignIn(api: ApiClient): Promise<void | Back> {
  const start = await api.post<{ authorizeUrl: string }>("/api/convex/oauth/start");
  console.log(`\nOpening Convex sign-in…\n${start.authorizeUrl}`);
  openBrowser(start.authorizeUrl);
  const authorizationToken = await promptWithBack(password, { message: "Paste the Convex authorization token" });
  if (authorizationToken === BACK) return BACK;
  await api.post("/api/convex/oauth/finish", { authorizationToken });
  console.log("Convex connected.");
}

type OptionalIntegration = "cloudflare" | "supabase" | "convex";

async function configureAdditionalTools(api: ApiClient): Promise<AdditionalTools | Back> {
  const result: AdditionalTools = { llmKeys: {} };
  const selectedProviders = await promptWithBack(checkbox<PasteableProvider>, {
    message: "Optional model API keys",
    choices: PASTEABLE_PROVIDERS.map((provider) => ({
      name: PROVIDER_LABELS[provider],
      value: provider,
    })),
    required: false,
  });
  if (selectedProviders === BACK) return BACK;
  for (const provider of selectedProviders) {
    const value = await promptWithBack(password, { message: `${PROVIDER_LABELS[provider]} API key` });
    if (value === BACK) return BACK;
    if (value.trim()) result.llmKeys[provider] = value.trim();
  }

  const copilot = await promptWithBack(confirm, { message: "Connect GitHub Copilot?", default: false });
  if (copilot === BACK) return BACK;
  if (copilot) await runCopilotSignIn(api);

  const integrations = await promptWithBack(checkbox<OptionalIntegration>, {
    message: "Optional integrations",
    choices: [
      { name: "Cloudflare", value: "cloudflare" as const, description: "Deploy and manage Cloudflare projects." },
      { name: "Supabase", value: "supabase" as const, description: "Connect to Supabase projects." },
      { name: "Convex", value: "convex" as const, description: "Connect to Convex projects." },
    ],
    required: false,
  });
  if (integrations === BACK) return BACK;

  for (const integration of integrations) {
    if (integration === "cloudflare") {
      const cloudflare = await promptWithBack(select, {
        message: "Cloudflare access",
        choices: [
          { name: "Sign in with Cloudflare / Wrangler", value: "oauth" as const },
          { name: "Paste a Cloudflare API token", value: "token" as const },
        ],
      });
      if (cloudflare === BACK) return BACK;
      if (cloudflare === "oauth") {
        const signInResult = await runWranglerSignIn(api);
        if (signInResult === BACK) return BACK;
      }
      if (cloudflare === "token") {
        const value = await promptWithBack(password, { message: "Cloudflare API token" });
        if (value === BACK) return BACK;
        if (value.trim()) result.cloudflareToken = value.trim();
      }
      continue;
    }

    if (integration === "supabase") {
      const value = await promptWithBack(password, { message: "Supabase personal or OAuth access token" });
      if (value === BACK) return BACK;
      if (value.trim()) result.supabaseToken = value.trim();
      continue;
    }

    const convex = await promptWithBack(select, {
      message: "Convex access",
      choices: [
        { name: "Sign in with Convex", value: "oauth" as const },
        { name: "Paste a Convex personal token", value: "token" as const },
      ],
    });
    if (convex === BACK) return BACK;
    if (convex === "oauth") {
      const signInResult = await runConvexSignIn(api);
      if (signInResult === BACK) return BACK;
    }
    if (convex === "token") {
      const value = await promptWithBack(password, { message: "Convex personal access token" });
      if (value === BACK) return BACK;
      if (value.trim()) result.convexToken = value.trim();
    }
  }
  return result;
}

async function connectedGithub(api: ApiClient): Promise<boolean> {
  const credentials = await api.get<CredentialsView>("/api/credentials");
  return Boolean(credentials.github);
}

async function connectGithub(api: ApiClient, baseUrl: string): Promise<void> {
  console.log("\nOpening GitHub repository authorization…");
  const url = `${baseUrl}/auth/github?return_to=/onboarding`;
  console.log(`If it does not open, visit:\n${url}`);
  openBrowser(url);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await connectedGithub(api)) {
      console.log("GitHub connected.");
      return;
    }
    await wait(5_000);
  }
  throw new Error("GitHub authorization did not finish before the sign-in window expired.");
}

async function chooseGithubRepositories(api: ApiClient): Promise<string[] | Back> {
  const selected = new Set<string>();
  while (selected.size < GITHUB_REPOSITORY_LIMIT) {
    const query = await promptWithBack(input, {
      message: selected.size
        ? `Search another GitHub repository, or press Enter when done (${selected.size}/${GITHUB_REPOSITORY_LIMIT})`
        : "Search GitHub repositories (press Enter to finish)",
    });
    if (query === BACK) return BACK;
    if (!query.trim()) break;
    const response = await api.get<{ repositories?: Repository[] }>(`/api/github/repos?q=${encodeURIComponent(query.trim())}`);
    const repositories = response.repositories ?? [];
    if (!repositories.length) {
      console.log("No accessible repositories matched that search.");
      continue;
    }
    const choices = repositories.map((repository) => ({
      name: `${repository.fullName}${repository.private ? " (private)" : ""}${repository.archived ? " (archived)" : ""}`,
      value: repository.fullName,
      ...(repository.description ? { description: repository.description } : {}),
      checked: selected.has(repository.fullName),
    }));
    const picked = await promptWithBack(checkbox<string>, {
      message: "Choose repositories to clone",
      choices,
      required: false,
      validate: (values) => values.length <= GITHUB_REPOSITORY_LIMIT - selected.size
        || `Choose at most ${GITHUB_REPOSITORY_LIMIT - selected.size} more.`,
    });
    if (picked === BACK) return BACK;
    for (const repository of picked) selected.add(repository);
  }
  return [...selected];
}

async function configureGithub(api: ApiClient, state: SessionState): Promise<string[] | Back> {
  if (!state.githubAvailable) {
    console.log("GitHub repository setup is unavailable on this deployment; skipping it.");
    return [];
  }
  const alreadyConnected = await connectedGithub(api);
  if (!alreadyConnected) {
    const shouldConnect = await promptWithBack(confirm, { message: "Connect GitHub for repository access?", default: true });
    if (shouldConnect === BACK) return BACK;
    if (!shouldConnect) return [];
  }
  if (!alreadyConnected) await connectGithub(api, api.baseUrl);
  return chooseGithubRepositories(api);
}

async function review(inputValue: ProvisionInput): Promise<"create" | Back> {
  console.log("\nReview your workbench setup:");
  console.log(`Agents: ${inputValue.agents.map((agent) => AGENT_LABELS[agent]).join(", ")}`);
  console.log(`Repositories: ${inputValue.githubRepos.length || "none"}`);
  console.log(`Model API keys: ${Object.keys(inputValue.llmKeys).length || "none"}`);
  console.log(`SSH: ${inputValue.sshPubkey ? "public key configured" : "no key (SSH disabled until later)"}`);
  const choice = await promptWithBack(select, {
    message: "Create this workbench?",
    choices: [
      { name: "Create this workbench", value: "create" as const },
    ],
  });
  return choice;
}

async function waitForReady(api: ApiClient): Promise<ContainerView> {
  let lastStatus = "";
  while (true) {
    const response = await api.get<{ container: ContainerView | null }>("/api/container");
    const container = response.container;
    if (!container) throw new Error("The workbench disappeared while provisioning.");
    const statusText = container.statusDetail ? `${container.status}: ${container.statusDetail}` : container.status;
    if (statusText !== lastStatus) {
      console.log(`Workbench status: ${statusText}`);
      lastStatus = statusText;
    }
    if (container.status === "running") return container;
    if (container.status === "error") {
      if (!(await confirm({ message: "Provisioning failed. Retry?", default: true }))) {
        throw new Error(container.statusDetail ?? "Provisioning failed.");
      }
      await api.post("/api/container/retry");
      continue;
    }
    await wait(container.status === "waitlisted" ? 30_000 : 5_000);
  }
}

export interface OnboardingResult {
  status: "ready";
  agents: Agent[];
  githubRepos: string[];
  sshCommand: string | null;
  hostKeyFingerprints: string[];
  sshShortcutConfigured: boolean;
}

export async function runOnboarding(
  api: ApiClient,
  initialState: SessionState,
): Promise<OnboardingResult | { status: "existing"; redirect: string }> {
  let state = initialState;
  if (state.hasWorkbench) {
    console.log(`This account already has a workbench. Open ${api.baseUrl}${state.redirect}`);
    return { status: "existing", redirect: state.redirect };
  }
  state = await verifyAccount(api, state);
  if (state.hasWorkbench) {
    console.log(`This account already has a workbench. Open ${api.baseUrl}${state.redirect}`);
    return { status: "existing", redirect: state.redirect };
  }

  console.log("\nWelcome to usebench.dev. Set up your cloud workbench.");
  console.log("Press Shift+Left at any prompt to return to the previous section.\n");
  let agents: Agent[] = [];
  let githubRepos: string[] = [];
  let tools: AdditionalTools = { llmKeys: {} };
  let sshKey: SelectedSshKey = { publicKey: undefined, privatePath: undefined };
  let container: ContainerView | undefined;
  let step = 0;
  while (!container) {
    if (step === 0) {
      const selectedAgents = await chooseAgents();
      if (selectedAgents === BACK) continue;
      agents = selectedAgents;
      step = 1;
      continue;
    }

    if (step === 1) {
      const result = await configureAgentAuth(api, agents);
      step = result === BACK ? 0 : 2;
      continue;
    }

    if (step === 2) {
      const result = await configureGithub(api, state);
      if (result === BACK) {
        step = 1;
        continue;
      }
      githubRepos = result;
      step = 3;
      continue;
    }

    if (step === 3) {
      const result = await configureAdditionalTools(api);
      if (result === BACK) {
        step = 2;
        continue;
      }
      tools = result;
      step = 4;
      continue;
    }

    if (step === 4) {
      const result = await chooseSshKey();
      if (result === BACK) {
        step = 3;
        continue;
      }
      sshKey = result;
      step = 5;
      continue;
    }

    const provisionInput: ProvisionInput = {
      agents,
      ...(sshKey.publicKey ? { sshPubkey: sshKey.publicKey } : {}),
      llmKeys: tools.llmKeys,
      ...(tools.cloudflareToken ? { cloudflareToken: tools.cloudflareToken } : {}),
      ...(tools.supabaseToken ? { supabaseToken: tools.supabaseToken } : {}),
      ...(tools.convexToken ? { convexToken: tools.convexToken } : {}),
      githubRepos,
    };
    const reviewChoice = await review(provisionInput);
    if (reviewChoice === BACK) {
      step = 4;
      continue;
    }
    try {
      console.log("\nYour workbench is provisioning. This may take a few minutes.");
      await api.post("/api/provision", provisionInput);
      container = await waitForReady(api);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 400 || error.status === 503)) {
        console.error(`\n${error.message}`);
        const reviewTools = await promptWithBack(confirm, {
          message: "Review optional tools and try again?",
          default: true,
        });
        if (reviewTools === BACK) {
          step = 3;
          continue;
        }
        if (reviewTools) {
          step = 3;
          continue;
        }
      }
      throw error;
    }
  }

  let sshShortcutConfigured = false;
  if (container.sshCommand && sshKey.privatePath) {
    const result = await maybeConfigureSshShortcut(container.sshCommand, sshKey.privatePath);
    sshShortcutConfigured = result.configured;
    if (result.conflict) console.log(`A separate Host workbench block already exists in ${result.path}; it was not overwritten.`);
  }
  console.log("\nYour workbench is ready.");
  if (container.sshCommand) {
    console.log(`SSH: ${container.sshCommand}`);
    if (sshShortcutConfigured) console.log("Shortcut: ssh workbench");
    if (container.hostKeyFingerprints.length) console.log(`Host fingerprints: ${container.hostKeyFingerprints.join(", ")}`);
  } else {
    console.log("No SSH key is installed, so SSH remains disabled until you add one from the dashboard.");
  }
  return {
    status: "ready",
    agents,
    githubRepos,
    sshCommand: container.sshCommand,
    hostKeyFingerprints: container.hostKeyFingerprints,
    sshShortcutConfigured,
  };
}

export function formatFailure(error: unknown): string {
  return error instanceof ApiError ? error.message : errorMessage(error);
}
