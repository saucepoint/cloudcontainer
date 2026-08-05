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

async function chooseAgents(): Promise<Agent[]> {
  const selected = await checkbox<Agent>({
    message: "Choose at least one coding agent",
    choices: AGENTS.map((agent) => ({
      name: AGENT_LABELS[agent],
      value: agent,
      description: AGENT_DESCRIPTIONS[agent],
    })),
    required: true,
  });
  return AGENTS.filter((agent) => selected.includes(agent));
}

async function runClaudeSignIn(api: ApiClient, agent: AuthTarget["agent"]): Promise<void> {
  const start = await api.post<{ authorizeUrl: string }>("/api/claude/oauth/start", { agent });
  console.log(`\nOpening Claude sign-in…\n${start.authorizeUrl}`);
  openBrowser(start.authorizeUrl);
  const code = await input({ message: "Paste the Claude authorization code (CODE#STATE)" });
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

async function runChatGptSignIn(api: ApiClient, agent: AuthTarget["agent"]): Promise<void> {
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

async function configureAgentAuth(api: ApiClient, agents: Agent[]): Promise<void> {
  const targets = agentAuthTargets(agents);
  if (!targets.length) return;
  const selected = await checkbox<AuthTarget>({
    message: "Optional agent sign-ins",
    choices: targets.map((target) => ({ name: authTargetLabel(target), value: target })),
    required: false,
  });
  for (const target of selected) {
    if (target.kind === "claude") await runClaudeSignIn(api, target.agent);
    else await runChatGptSignIn(api, target.agent);
  }
}

async function verifyAccount(api: ApiClient, state: SessionState): Promise<SessionState> {
  if (state.verified) return state;
  const method = await select({
    message: "Verify your usebench account",
    choices: [
      ...(state.worldIdAvailable ? [{ name: "Verify with World ID (QR code)", value: "world" as const }] : []),
      { name: "Enter an invite code", value: "invite" as const },
    ],
  });
  if (method === "world") {
    await verifyWithWorldId(api);
  } else {
    const code = await input({
      message: "Eight-character invite code",
      validate: (value) => /^[A-Za-z0-9]{8}$/.test(value.trim()) || "Enter exactly eight letters or numbers.",
    });
    await api.post("/api/account/invite/verify", { code: code.trim().toUpperCase() });
  }
  console.log("Account verified.");
  return api.get<SessionState>("/api/cli/session");
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

async function runWranglerSignIn(api: ApiClient): Promise<void> {
  const start = await api.post<{ authorizeUrl: string }>("/api/wrangler/oauth/start");
  console.log(`\nOpening Cloudflare sign-in…\n${start.authorizeUrl}`);
  openBrowser(start.authorizeUrl);
  const callbackUrl = await input({ message: "Paste the full localhost callback URL" });
  await api.post("/api/wrangler/oauth/finish", { callbackUrl });
  console.log("Cloudflare connected.");
}

async function runConvexSignIn(api: ApiClient): Promise<void> {
  const start = await api.post<{ authorizeUrl: string }>("/api/convex/oauth/start");
  console.log(`\nOpening Convex sign-in…\n${start.authorizeUrl}`);
  openBrowser(start.authorizeUrl);
  const authorizationToken = await password({ message: "Paste the Convex authorization token" });
  await api.post("/api/convex/oauth/finish", { authorizationToken });
  console.log("Convex connected.");
}

async function configureAdditionalTools(api: ApiClient): Promise<AdditionalTools> {
  const result: AdditionalTools = { llmKeys: {} };
  const selectedProviders = await checkbox<PasteableProvider>({
    message: "Optional model API keys",
    choices: PASTEABLE_PROVIDERS.map((provider) => ({
      name: PROVIDER_LABELS[provider],
      value: provider,
    })),
    required: false,
  });
  for (const provider of selectedProviders) {
    const value = await password({ message: `${PROVIDER_LABELS[provider]} API key` });
    if (value.trim()) result.llmKeys[provider] = value.trim();
  }

  if (await confirm({ message: "Connect GitHub Copilot?", default: false })) await runCopilotSignIn(api);

  const cloudflare = await select({
    message: "Cloudflare access",
    choices: [
      { name: "Skip", value: "skip" as const },
      { name: "Sign in with Cloudflare / Wrangler", value: "oauth" as const },
      { name: "Paste a Cloudflare API token", value: "token" as const },
    ],
  });
  if (cloudflare === "oauth") await runWranglerSignIn(api);
  if (cloudflare === "token") {
    const value = await password({ message: "Cloudflare API token" });
    if (value.trim()) result.cloudflareToken = value.trim();
  }

  if (await confirm({ message: "Connect Supabase?", default: false })) {
    const value = await password({ message: "Supabase personal or OAuth access token" });
    if (value.trim()) result.supabaseToken = value.trim();
  }

  const convex = await select({
    message: "Convex access",
    choices: [
      { name: "Skip", value: "skip" as const },
      { name: "Sign in with Convex", value: "oauth" as const },
      { name: "Paste a Convex personal token", value: "token" as const },
    ],
  });
  if (convex === "oauth") await runConvexSignIn(api);
  if (convex === "token") {
    const value = await password({ message: "Convex personal access token" });
    if (value.trim()) result.convexToken = value.trim();
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

async function chooseGithubRepositories(api: ApiClient): Promise<string[]> {
  const selected = new Set<string>();
  while (selected.size < GITHUB_REPOSITORY_LIMIT) {
    const query = await input({
      message: selected.size
        ? `Search another GitHub repository or paste a URL, or press Enter when done (${selected.size}/${GITHUB_REPOSITORY_LIMIT})`
        : "Search GitHub repositories or paste a URL (press Enter to finish)",
    });
    if (!query.trim()) break;
    const response = await api.get<{ repositories?: Repository[]; githubRequired?: boolean }>(
      `/api/github/repos?q=${encodeURIComponent(query.trim())}`,
    );
    const repositories = response.repositories ?? [];
    if (!repositories.length) {
      console.log(response.githubRequired === true
        ? "If this repository is private, connect GitHub to access it."
        : "No accessible repositories matched that search.");
      continue;
    }
    const choices = repositories.map((repository) => ({
      name: `${repository.fullName}${repository.private ? " (private)" : ""}${repository.archived ? " (archived)" : ""}`,
      value: repository.fullName,
      ...(repository.description ? { description: repository.description } : {}),
      checked: selected.has(repository.fullName),
    }));
    const picked = await checkbox<string>({
      message: "Choose repositories to clone",
      choices,
      required: false,
      validate: (values) => values.length <= GITHUB_REPOSITORY_LIMIT - selected.size
        || `Choose at most ${GITHUB_REPOSITORY_LIMIT - selected.size} more.`,
    });
    for (const repository of picked) selected.add(repository);
  }
  return [...selected];
}

async function configureGithub(api: ApiClient, state: SessionState): Promise<string[]> {
  if (!state.githubAvailable) {
    console.log("GitHub repository setup is unavailable on this deployment; skipping it.");
    return [];
  }
  const alreadyConnected = await connectedGithub(api);
  if (!alreadyConnected && await confirm({ message: "Connect GitHub for private repository access?", default: true })) {
    await connectGithub(api, api.baseUrl);
  }
  return chooseGithubRepositories(api);
}

async function review(inputValue: ProvisionInput): Promise<void> {
  console.log("\nReview your workbench setup:");
  console.log(`Agents: ${inputValue.agents.map((agent) => AGENT_LABELS[agent]).join(", ")}`);
  console.log(`Repositories: ${inputValue.githubRepos.length || "none"}`);
  console.log(`Model API keys: ${Object.keys(inputValue.llmKeys).length || "none"}`);
  console.log(`SSH: ${inputValue.sshPubkey ? "public key configured" : "no key (SSH disabled until later)"}`);
  if (!(await confirm({ message: "Create this workbench?", default: true }))) throw new Error("Onboarding cancelled.");
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
  let state = await verifyAccount(api, initialState);
  if (state.hasWorkbench) {
    console.log(`This account already has a workbench. Continue at ${api.baseUrl}${state.redirect}`);
    return { status: "existing", redirect: state.redirect };
  }

  console.log("\nWelcome to usebench.dev. Set up your cloud workbench.\n");
  const agents = await chooseAgents();
  await configureAgentAuth(api, agents);
  const githubRepos = await configureGithub(api, state);
  let tools = await configureAdditionalTools(api);
  const sshKey: SelectedSshKey = await chooseSshKey();
  let container: ContainerView;
  while (true) {
    const provisionInput: ProvisionInput = {
      agents,
      ...(sshKey.publicKey ? { sshPubkey: sshKey.publicKey } : {}),
      llmKeys: tools.llmKeys,
      ...(tools.cloudflareToken ? { cloudflareToken: tools.cloudflareToken } : {}),
      ...(tools.supabaseToken ? { supabaseToken: tools.supabaseToken } : {}),
      ...(tools.convexToken ? { convexToken: tools.convexToken } : {}),
      githubRepos,
    };
    try {
      await review(provisionInput);
      await api.post("/api/provision", provisionInput);
      container = await waitForReady(api);
      break;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 400 || error.status === 503)) {
        console.error(`\n${error.message}`);
        if (await confirm({ message: "Review optional tools and try again?", default: true })) {
          tools = await configureAdditionalTools(api);
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
