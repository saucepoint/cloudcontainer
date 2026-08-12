import {
  AGENT_LABELS,
  INPUT_LIMITS,
  LLM_PROVIDER_LABELS,
  LLM_PROVIDERS,
  OAUTH_ONLY_LLM_PROVIDERS,
} from "@workbench/contract";
import {
  claudeOauthFlow,
  claudeOauthFlowFor,
  chatgptOauthFlow,
  codexDeviceFlow,
  copilotDeviceFlow,
  convexOauthFlow,
  isAuthFlowActive,
  wranglerOauthFlow,
} from "./auth-flows.js";
import { askConfirmation } from "./confirmation.js";
import { errorMessage, HttpError, requestJson } from "./http.js";

const PASTEABLE_PROVIDERS = LLM_PROVIDERS.filter(
  (provider) => !(OAUTH_ONLY_LLM_PROVIDERS as readonly string[]).includes(provider),
);

type SetupDraft = {
  step: "agents" | "agent-auth" | "github" | "tools" | "ssh" | "review";
  agents: string[];
  githubRepos: string[];
  sshKeyChoice: "none" | "default" | "dedicated" | "manual" | "github";
  updatedAt: number;
  expiresAt: number;
};

type DraftCategory = "agents" | "github" | "ssh";
type CredentialCategory = "agents" | "github" | "tools";

type CredentialsPresence = {
  llm: Record<string, boolean>;
  cloudflare: boolean;
  supabase: boolean;
  convex: boolean;
  wrangler: boolean;
  github: string | null;
};

type ConfigurationBody = {
  agents: string[];
  sshPubkey: string;
  sshKeyLabel?: string;
  sshKeys: Array<{ pubkey: string; label: string }>;
  llmKeys: Record<string, string>;
  cloudflareToken?: string;
  supabaseToken?: string;
  convexToken?: string;
  githubRepos: string[];
};

function element<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const found = element<T>(id);
  if (!found) throw new Error(`missing required configuration element: ${id}`);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const form = requiredElement<HTMLFormElement>("wizard");
let credentialsPresence: CredentialsPresence | null = null;
let setupDraft: SetupDraft | null = null;
let pendingConfiguration: ConfigurationBody | null = null;
let draftSaveTimer: ReturnType<typeof setTimeout> | undefined;

type SetupSshKey = {
  id: number;
  label: string;
  pubkey: string;
  created_at: number;
};

type ImportedSshKey = Pick<SetupSshKey, "label" | "pubkey"> & { selected: boolean };
const importedGithubKeys = new Map<string, ImportedSshKey>();

function hasSelectedGithubKeys(): boolean {
  return [...importedGithubKeys.values()].some((key) => key.selected);
}

function collectConfigurationBody(): ConfigurationBody {
  const data = new FormData(form);
  const llmKeys: Record<string, string> = {};
  for (const provider of PASTEABLE_PROVIDERS) {
    const value = (data.get(`llm_${provider}`) || "").toString().trim();
    if (value) llmKeys[provider] = value;
  }
  const cloudflareToken = (data.get("cloudflareToken") || "").toString().trim();
  const supabaseToken = (data.get("supabaseToken") || "").toString().trim();
  const convexToken = (data.get("convexToken") || "").toString().trim();
  return {
    agents: data.getAll("agent").map((agent) => agent.toString()),
    sshPubkey: (data.get("sshPubkey") || "").toString().trim(),
    ...((data.get("sshKeyLabel") || "").toString().trim()
      ? { sshKeyLabel: (data.get("sshKeyLabel") || "").toString().trim() }
      : {}),
    sshKeys: [...importedGithubKeys.values()]
      .filter((key) => key.selected)
      .map(({ pubkey, label }) => ({ pubkey, label })),
    llmKeys,
    ...(cloudflareToken ? { cloudflareToken } : {}),
    ...(supabaseToken ? { supabaseToken } : {}),
    ...(convexToken ? { convexToken } : {}),
    githubRepos: [...selectedGithubRepositories],
  };
}

function draftPayload(step: SetupDraft["step"] = "agents") {
  return {
    step,
    agents: new FormData(form).getAll("agent").map((agent) => agent.toString()),
    githubRepos: [...selectedGithubRepositories],
    // Public key values are deliberately not persisted in drafts. This records
    // only the selected path so the UI can explain what must be loaded again.
    sshKeyChoice: ((element<HTMLTextAreaElement>("ssh-pubkey")?.value.trim())
      ? "manual"
      : hasSelectedGithubKeys()
        ? "github"
        : "none") as SetupDraft["sshKeyChoice"],
  };
}

async function saveDraft(step: SetupDraft["step"] = "agents"): Promise<void> {
  await requestJson("/api/setup-draft", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draftPayload(step)),
  });
}

function scheduleDraftSave(): void {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    void saveDraft().catch(() => undefined);
  }, 350);
}

function reviewItems(body: ConfigurationBody): string[] {
  const newKeyCount = body.sshKeys.length + (body.sshPubkey ? 1 : 0);
  const items = [
    `Agents: ${body.agents.map((agent) => AGENT_LABELS[agent as keyof typeof AGENT_LABELS] ?? agent).join(", ")}`,
    `GitHub repositories: ${body.githubRepos.length ? body.githubRepos.join(", ") : "none"}`,
    `SSH: ${newKeyCount ? `${newKeyCount} public key${newKeyCount === 1 ? "" : "s"} ready` : "add a key after the workbench is ready"}`,
  ];
  const connected = new Set<string>();
  for (const provider of Object.keys(credentialsPresence?.llm ?? {})) {
    if (credentialsPresence?.llm[provider]) connected.add(provider);
  }
  for (const provider of Object.keys(body.llmKeys)) connected.add(provider);
  if (credentialsPresence?.cloudflare || body.cloudflareToken) connected.add("Cloudflare");
  if (credentialsPresence?.supabase || body.supabaseToken) connected.add("Supabase");
  if (credentialsPresence?.convex || body.convexToken) connected.add("Convex");
  if (credentialsPresence?.wrangler) connected.add("Cloudflare Wrangler");
  if (credentialsPresence?.github || body.githubRepos.length) connected.add("GitHub");
  const integrations = [...connected].map((provider) =>
    LLM_PROVIDER_LABELS[provider as keyof typeof LLM_PROVIDER_LABELS] ?? provider,
  );
  items.splice(1, 0, `Saved integrations: ${integrations.length ? integrations.join(", ") : "none"}`);
  return items;
}

function showReview(body: ConfigurationBody): void {
  const review = requiredElement<HTMLElement>("setup-review");
  const items = requiredElement<HTMLElement>("setup-review-items");
  items.replaceChildren(...reviewItems(body).map((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    return li;
  }));
  pendingConfiguration = body;
  review.hidden = false;
  requiredElement<HTMLButtonElement>("go").hidden = true;
  review.querySelector<HTMLElement>("h2")?.focus();
}

async function saveConfiguration(body: ConfigurationBody): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("review-confirm");
  const errorElement = requiredElement<HTMLElement>("err");
  errorElement.textContent = "";
  button.disabled = true;
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  button.replaceChildren(spinner, "Saving…");
  try {
    await saveDraft("review");
    await requestJson("/api/configuration", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, "configuration could not be saved");
    location.href = "/dashboard";
  } catch (error) {
    errorElement.textContent = errorMessage(error);
    errorElement.focus();
    button.disabled = false;
    button.textContent = "Save";
  }
}

form.addEventListener("submit", (event: SubmitEvent) => {
  event.preventDefault();
  const body = collectConfigurationBody();
  const errorElement = requiredElement<HTMLElement>("err");
  errorElement.textContent = "";
  if (body.agents.length === 0) {
    errorElement.textContent = "Pick at least one agent first.";
    errorElement.focus();
    return;
  }
  void saveDraft("review").catch(() => undefined);
  showReview(body);
});

requiredElement<HTMLButtonElement>("review-back").addEventListener("click", () => {
  requiredElement<HTMLElement>("setup-review").hidden = true;
  requiredElement<HTMLButtonElement>("go").hidden = false;
  requiredElement<HTMLButtonElement>("go").focus();
});

requiredElement<HTMLButtonElement>("review-confirm").addEventListener("click", () => {
  if (pendingConfiguration) void saveConfiguration(pendingConfiguration);
});

form.addEventListener("change", scheduleDraftSave);
form.addEventListener("input", (event: Event) => {
  if (event.target instanceof HTMLTextAreaElement && event.target.name === "sshPubkey") {
    scheduleDraftSave();
  }
  if (event.target instanceof HTMLInputElement && event.target.name === "sshKeyLabel") {
    scheduleDraftSave();
  }
});

function renderStoredSshKeys(keys: SetupSshKey[]): void {
  const list = requiredElement<HTMLElement>("stored-ssh-keys");
  const status = requiredElement<HTMLElement>("stored-ssh-status");
  if (keys.length === 0) {
    list.replaceChildren();
    status.textContent = "No SSH keys are saved yet.";
    return;
  }
  status.textContent = `${keys.length} saved SSH key${keys.length === 1 ? "" : "s"} will be available to this workbench.`;
  list.replaceChildren(...keys.map((key) => {
    const item = document.createElement("div");
    const copy = document.createElement("div");
    const title = document.createElement("div");
    const indicator = document.createElement("span");
    const name = document.createElement("strong");
    const meta = document.createElement("code");
    item.className = "ssh-key";
    copy.className = "ssh-key-copy";
    title.className = "ssh-key-title";
    indicator.className = "ssh-key-indicator";
    indicator.setAttribute("aria-hidden", "true");
    name.textContent = key.label || "Unnamed key";
    meta.className = "ssh-key-meta";
    meta.textContent = key.pubkey;
    title.append(indicator, name);
    copy.append(title, meta);
    item.append(copy);
    return item;
  }));
}

function renderGithubSshKeys(): void {
  const list = requiredElement<HTMLElement>("github-ssh-keys");
  const keys = [...importedGithubKeys.values()];
  list.replaceChildren(...keys.map((key, index) => {
    const choice = document.createElement("label");
    const input = document.createElement("input");
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    const meta = document.createElement("small");
    choice.className = "ssh-key-choice";
    input.type = "checkbox";
    input.id = `github-ssh-key-${index}`;
    input.value = key.pubkey;
    input.checked = key.selected;
    name.textContent = key.label || "Unnamed key";
    meta.textContent = key.pubkey;
    copy.append(name, meta);
    choice.append(input, copy);
    return choice;
  }));
}

async function loadGithubSshKeys(): Promise<void> {
  const username = requiredElement<HTMLInputElement>("github-ssh-username").value.trim();
  const status = requiredElement<HTMLElement>("github-ssh-status");
  const button = requiredElement<HTMLButtonElement>("load-github-ssh");
  if (!username) {
    status.textContent = "Enter a GitHub username first.";
    return;
  }
  button.disabled = true;
  status.textContent = "Loading public keys…";
  try {
    const result = await requestJson<{ keys?: unknown[] }>(
      `/api/keys/github?username=${encodeURIComponent(username)}`,
      undefined,
      "Could not load GitHub SSH keys",
    );
    importedGithubKeys.clear();
    for (const raw of result.keys ?? []) {
      if (!isRecord(raw) || typeof raw.pubkey !== "string" || typeof raw.label !== "string") continue;
      importedGithubKeys.set(raw.pubkey, {
        pubkey: raw.pubkey,
        label: raw.label,
        selected: true,
      });
    }
    renderGithubSshKeys();
    status.textContent = importedGithubKeys.size
      ? `Select the keys to save with this workbench configuration.`
      : "That GitHub account has no usable public SSH keys.";
    scheduleDraftSave();
  } catch (error) {
    status.textContent = errorMessage(error, "Could not load GitHub SSH keys.");
  } finally {
    button.disabled = false;
  }
}

element<HTMLButtonElement>("show-github-ssh-import")?.addEventListener("click", () => {
  const panel = requiredElement<HTMLElement>("github-ssh-import");
  const button = requiredElement<HTMLButtonElement>("show-github-ssh-import");
  const open = panel.hidden;
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) requiredElement<HTMLInputElement>("github-ssh-username").focus();
});
element<HTMLButtonElement>("load-github-ssh")?.addEventListener("click", () => void loadGithubSshKeys());
element<HTMLElement>("github-ssh-keys")?.addEventListener("change", (event: Event) => {
  if (!(event.target instanceof HTMLInputElement) || event.target.type !== "checkbox") return;
  const key = importedGithubKeys.get(event.target.value);
  if (!key) return;
  key.selected = event.target.checked;
  scheduleDraftSave();
});

// Sign-in flows store credentials server-side as soon as they complete.
function wireSignin(id: string, flow: (target: HTMLElement, done: () => void) => void): void {
  const button = requiredElement<HTMLButtonElement>(`${id}-signin`);
  const target = requiredElement<HTMLElement>(`${id}-flow`);
  const connected = requiredElement<HTMLElement>(`${id}-connected`);
  button.addEventListener("click", () => {
    if (isAuthFlowActive(target)) return;
    flow(target, () => {
      target.replaceChildren();
      button.style.display = "none";
      connected.style.display = "";
      if (credentialsPresence) {
        const provider = SIGNIN_CREDENTIALS[id];
        if (provider) {
          credentialsPresence = {
            ...credentialsPresence,
            llm: { ...credentialsPresence.llm, [provider]: true },
          };
        } else if (id === "wrangler" || id === "convex") {
          credentialsPresence = { ...credentialsPresence, [id]: true };
        }
      }
    });
  });
}

wireSignin("claude", claudeOauthFlow);
wireSignin("codex", codexDeviceFlow);
wireSignin("pi-chatgpt", chatgptOauthFlow("pi"));
wireSignin("pi-claude", claudeOauthFlowFor("pi"));
wireSignin("opencode-chatgpt", chatgptOauthFlow("opencode"));
wireSignin("opencode-claude", claudeOauthFlowFor("opencode"));
wireSignin("copilot", copilotDeviceFlow);
wireSignin("wrangler", wranglerOauthFlow);
wireSignin("convex", convexOauthFlow);

const githubConnect = element<HTMLAnchorElement>("github-connect");
if (githubConnect) {
  // Save immediately before leaving for GitHub so a pending debounce cannot
  // lose the latest agent selection during the external round trip.
  githubConnect.addEventListener("click", () => {
    void saveDraft().catch(() => undefined);
  });
}

type GithubRepository = {
  fullName: string;
  private: boolean;
  archived: boolean;
  saved?: boolean;
  description?: string | null;
};

function isGithubRepository(value: unknown): value is GithubRepository {
  return isRecord(value)
    && typeof value.fullName === "string"
    && typeof value.private === "boolean"
    && typeof value.archived === "boolean"
    && (value.description === undefined
      || value.description === null
      || typeof value.description === "string");
}

const selectedGithubRepositories = new Set<string>();
const knownGithubRepositories = new Map<string, GithubRepository>();

function renderGithubRepositories(repositories: GithubRepository[]): void {
  const list = requiredElement<HTMLElement>("github-repos");
  const visible = new Map(repositories.map((repository) => [repository.fullName, repository]));
  for (const fullName of selectedGithubRepositories) {
    const repository = knownGithubRepositories.get(fullName);
    if (repository) visible.set(fullName, repository);
  }
  const choices = [...visible.values()].map((repository, index) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    const metadata = document.createElement("small");
    label.className = "repo-choice";
    label.htmlFor = `github-repo-${index}`;
    input.type = "checkbox";
    input.id = `github-repo-${index}`;
    input.name = "githubRepo";
    input.value = repository.fullName;
    input.checked = selectedGithubRepositories.has(repository.fullName);
    input.disabled =
      !input.checked && selectedGithubRepositories.size >= INPUT_LIMITS.githubReposPerProvision;
    name.textContent = repository.fullName;
    metadata.textContent = repository.saved
      ? "saved selection"
      : `${repository.private ? "private" : "public"}${repository.archived ? " · archived" : ""}`;
    copy.append(name, metadata);
    if (repository.description) {
      const description = document.createElement("small");
      description.textContent = repository.description;
      copy.append(description);
    }
    label.append(input, copy);
    return label;
  });
  list.replaceChildren(...choices);
}

async function loadGithubRepositories(query: string): Promise<void> {
  const list = element<HTMLElement>("github-repos");
  if (!list) return;
  const status = requiredElement<HTMLElement>("github-status");
  if (!query.trim()) {
    renderGithubRepositories([]);
    status.textContent = "";
    return;
  }
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  status.replaceChildren(spinner, "Searching GitHub…");
  try {
    const json = await requestJson<{ repositories?: unknown; githubRequired?: boolean }>(
      `/api/github/repos?q=${encodeURIComponent(query)}`,
      undefined,
      "Could not load repositories",
    );
    const rawRepositories = Array.isArray(json.repositories) ? json.repositories : [];
    const repositories = rawRepositories.filter(isGithubRepository);
    for (const repository of repositories) {
      knownGithubRepositories.set(repository.fullName, repository);
    }
    status.textContent = repositories.length
      ? `Choose up to ${INPUT_LIMITS.githubReposPerProvision} repositories.`
      : json.githubRequired === true
        ? "If this repository is private, connect GitHub to access it."
        : "No accessible repositories match your search.";
    renderGithubRepositories(repositories);
  } catch (error) {
    status.textContent = error instanceof HttpError && error.status === 409
      ? "Connect GitHub to search by name, or paste a public GitHub URL."
      : errorMessage(error, "Could not load GitHub repositories.");
  }
}

const githubSearch = element<HTMLInputElement>("github-repo-search");
const githubRepoList = element<HTMLElement>("github-repos");
githubRepoList?.addEventListener("change", (event: Event) => {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (!event.target.matches('input[name="githubRepo"]')) return;
  if (event.target.checked) selectedGithubRepositories.add(event.target.value);
  else selectedGithubRepositories.delete(event.target.value);
  for (const input of githubRepoList.querySelectorAll<HTMLInputElement>("input:not(:checked)")) {
    input.disabled = selectedGithubRepositories.size >= INPUT_LIMITS.githubReposPerProvision;
  }
  scheduleDraftSave();
});

let githubSearchTimer: ReturnType<typeof setTimeout> | undefined;
githubSearch?.addEventListener("input", () => {
  clearTimeout(githubSearchTimer);
  githubSearchTimer = setTimeout(() => loadGithubRepositories(githubSearch.value), 250);
});

const SIGNIN_CREDENTIALS: Record<string, string> = {
  claude: "claude_subscription_token",
  codex: "codex_subscription_token",
  "pi-chatgpt": "pi_codex_subscription_token",
  "pi-claude": "pi_claude_subscription_token",
  "opencode-chatgpt": "opencode_codex_subscription_token",
  "opencode-claude": "opencode_claude_subscription_token",
  copilot: "github_copilot",
};

function markSigninConnected(id: string): void {
  const button = element<HTMLButtonElement>(`${id}-signin`);
  const connected = element<HTMLElement>(`${id}-connected`);
  if (button) button.style.display = "none";
  if (connected) connected.style.display = "";
}

function restoreCredentialPresence(presence: CredentialsPresence): void {
  credentialsPresence = presence;
  for (const [id, provider] of Object.entries(SIGNIN_CREDENTIALS)) {
    if (presence.llm[provider]) markSigninConnected(id);
  }
  if (presence.wrangler) markSigninConnected("wrangler");
  if (presence.convex) markSigninConnected("convex");

  for (const provider of PASTEABLE_PROVIDERS) {
    if (!presence.llm[provider]) continue;
    const input = element<HTMLInputElement>(`llm-${provider}`);
    const status = element<HTMLElement>(`llm-${provider}-status`);
    if (input) input.placeholder = "Already saved — leave blank to keep it";
    if (status) status.hidden = false;
  }
  for (const [provider, present] of [
    ["cloudflare", presence.cloudflare],
    ["supabase", presence.supabase],
    ["convex", presence.convex],
  ] as const) {
    const status = element<HTMLElement>(`${provider}-token-status`);
    if (status) status.hidden = !present;
  }
  const githubConnected = element<HTMLElement>("github-connected");
  if (githubConnected && presence.github) {
    githubConnected.textContent = `Connected as ${presence.github}`;
    githubConnected.hidden = false;
  }
}

function updateDraftStatus(): void {
  const status = element<HTMLElement>("setup-draft-status");
  const message = element<HTMLElement>("setup-draft-message");
  if (!status) return;
  status.hidden = !setupDraft;
  if (!setupDraft || !message) return;
  const expires = new Date(setupDraft.expiresAt).toLocaleString();
  message.textContent = setupDraft.sshKeyChoice === "manual"
    ? `Saved choices expire ${expires}. Pasted secrets are never saved; paste your SSH public key again before creating the workbench.`
    : setupDraft.sshKeyChoice === "github"
      ? `Saved choices expire ${expires}. GitHub key selections are not saved; load them again before creating the workbench.`
      : `Saved choices expire ${expires}. Pasted secrets are never saved and may need to be entered again.`;
}

function applyDraftCategory(category: DraftCategory): void {
  if (category === "agents") {
    for (const input of form.querySelectorAll<HTMLInputElement>('input[name="agent"]')) input.checked = false;
  } else if (category === "github") {
    selectedGithubRepositories.clear();
    const search = element<HTMLInputElement>("github-repo-search");
    if (search) search.value = "";
    if (element("github-repos")) renderGithubRepositories([]);
  } else {
    const sshKey = element<HTMLTextAreaElement>("ssh-pubkey");
    if (sshKey) sshKey.value = "";
    const sshKeyLabel = element<HTMLInputElement>("ssh-key-label");
    if (sshKeyLabel) sshKeyLabel.value = "";
    importedGithubKeys.clear();
    renderGithubSshKeys();
  }
}

function restoreDraft(draft: SetupDraft): void {
  setupDraft = draft;
  const selectedAgents = new Set(draft.agents);
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name="agent"]')) {
    input.checked = selectedAgents.has(input.value);
  }
  for (const repository of draft.githubRepos) selectedGithubRepositories.add(repository);
  for (const repository of draft.githubRepos) {
    if (!knownGithubRepositories.has(repository)) {
      knownGithubRepositories.set(repository, {
        fullName: repository,
        private: false,
        archived: false,
        saved: true,
      });
    }
  }

  updateDraftStatus();
  const githubStatus = element<HTMLElement>("github-status");
  if (githubStatus && draft.githubRepos.length > 0 && !credentialsPresence?.github) {
    githubStatus.textContent = `${draft.githubRepos.length} repository selection${draft.githubRepos.length === 1 ? "" : "s"} restored. Search again to refresh access details.`;
  }
  if (element("github-repos")) renderGithubRepositories([]);
}

async function clearDraft(): Promise<void> {
  const button = requiredElement<HTMLButtonElement>("clear-setup-draft");
  clearTimeout(draftSaveTimer);
  button.disabled = true;
  try {
    await requestJson("/api/setup-draft", { method: "DELETE" });
    setupDraft = null;
    applyDraftCategory("agents");
    applyDraftCategory("github");
    applyDraftCategory("ssh");
    updateDraftStatus();
  } catch (error) {
    const errorElement = requiredElement<HTMLElement>("err");
    errorElement.textContent = errorMessage(error, "Could not clear the saved setup choices.");
    errorElement.focus();
  } finally {
    button.disabled = false;
  }
}

element<HTMLButtonElement>("clear-setup-draft")?.addEventListener("click", () => void clearDraft());

function markSigninDisconnected(id: string): void {
  const button = element<HTMLButtonElement>(`${id}-signin`);
  const connected = element<HTMLElement>(`${id}-connected`);
  const flow = element<HTMLElement>(`${id}-flow`);
  if (button) button.style.display = "";
  if (connected) connected.style.display = "none";
  flow?.replaceChildren();
}

function clearAgentCredentialUi(): void {
  for (const id of Object.keys(SIGNIN_CREDENTIALS)) markSigninDisconnected(id);
  for (const provider of PASTEABLE_PROVIDERS) {
    const input = element<HTMLInputElement>(`llm-${provider}`);
    const status = element<HTMLElement>(`llm-${provider}-status`);
    if (input) {
      input.value = "";
      input.placeholder = "API key";
    }
    if (status) status.hidden = true;
  }
  if (credentialsPresence) credentialsPresence = { ...credentialsPresence, llm: {} };
}

function clearGithubCredentialUi(): void {
  if (credentialsPresence) credentialsPresence = { ...credentialsPresence, github: null };
  const status = element<HTMLElement>("github-status");
  if (status) status.textContent = "Search by repository name after connecting, or paste a public GitHub URL.";
}

function clearToolCredentialUi(): void {
  markSigninDisconnected("wrangler");
  markSigninDisconnected("convex");
  for (const [provider, present] of [
    ["cloudflare", false],
    ["supabase", false],
    ["convex", false],
  ] as const) {
    const input = element<HTMLInputElement>(`${provider}-token`);
    const status = element<HTMLElement>(`${provider}-token-status`);
    if (input) input.value = "";
    if (status) status.hidden = !present;
  }
  if (credentialsPresence) {
    credentialsPresence = {
      ...credentialsPresence,
      cloudflare: false,
      supabase: false,
      convex: false,
      wrangler: false,
    };
  }
}

const DRAFT_CATEGORY_BY_CREDENTIALS: Record<CredentialCategory, DraftCategory> = {
  agents: "agents",
  github: "github",
  tools: "ssh",
};

async function clearCredentialCategory(
  category: CredentialCategory,
  buttonId: string,
  statusId: string,
  successMessage: string,
): Promise<void> {
  const button = requiredElement<HTMLButtonElement>(buttonId);
  const status = requiredElement<HTMLElement>(statusId);
  button.disabled = true;
  try {
    await requestJson(`/api/credentials/${category}`, { method: "DELETE" });
    if (category === "agents") clearAgentCredentialUi();
    else if (category === "github") clearGithubCredentialUi();
    else clearToolCredentialUi();
    clearTimeout(draftSaveTimer);
    const draftCategory = DRAFT_CATEGORY_BY_CREDENTIALS[category];
    const result = await requestJson<{ draft: SetupDraft | null }>(
      `/api/setup-draft/${draftCategory}`,
      { method: "DELETE" },
    );
    setupDraft = result.draft;
    applyDraftCategory(draftCategory);
    updateDraftStatus();
    status.textContent = successMessage;
  } catch (error) {
    status.textContent = errorMessage(error, "Could not clear the saved credentials.");
  } finally {
    button.disabled = false;
  }
}

element<HTMLButtonElement>("clear-agent-credentials")?.addEventListener("click", () => {
  askConfirmation(
    "Clear agent credentials?",
    "This permanently removes saved model API keys and agent sign-ins, and clears your saved agent choices.",
    "Clear credentials",
    () => void clearCredentialCategory("agents", "clear-agent-credentials", "agent-clear-status", "Agent credentials and choices cleared."),
    true,
  );
});

element<HTMLButtonElement>("clear-github-credentials")?.addEventListener("click", () => {
  askConfirmation(
    "Clear GitHub credentials?",
    "This permanently removes the saved GitHub connection and your saved repository choices.",
    "Clear credentials",
    () => void clearCredentialCategory("github", "clear-github-credentials", "github-clear-status", "GitHub credentials and choices cleared."),
    true,
  );
});

element<HTMLButtonElement>("clear-tools-credentials")?.addEventListener("click", () => {
  askConfirmation(
    "Clear tool credentials?",
    "This permanently removes saved Cloudflare, Supabase, Convex, and Wrangler credentials, and clears your saved SSH choice.",
    "Clear credentials",
    () => void clearCredentialCategory("tools", "clear-tools-credentials", "tools-clear-status", "Tool credentials and SSH choice cleared."),
    true,
  );
});

async function restoreSetupState(): Promise<void> {
  const [draftResult, configurationResult, presenceResult, keysResult] = await Promise.all([
    requestJson<{ draft: SetupDraft | null }>("/api/setup-draft").catch(() => ({ draft: null })),
    requestJson<{
      configuration: null | {
        agents: string[];
        githubRepos: string[];
        updatedAt: number;
      };
    }>("/api/configuration").catch(() => ({ configuration: null })),
    requestJson<CredentialsPresence>("/api/credentials").catch(() => null),
    requestJson<{ keys?: unknown[] }>("/api/keys").catch(() => ({ keys: [] })),
  ]);
  if (presenceResult) restoreCredentialPresence(presenceResult);
  const storedKeys = (keysResult.keys ?? []).filter((key): key is SetupSshKey =>
    isRecord(key)
      && typeof key.id === "number"
      && typeof key.label === "string"
      && typeof key.pubkey === "string"
      && typeof key.created_at === "number",
  );
  renderStoredSshKeys(storedKeys);
  if (draftResult.draft) {
    restoreDraft(draftResult.draft);
  } else if (configurationResult.configuration) {
    restoreDraft({
      step: "review",
      agents: configurationResult.configuration.agents,
      githubRepos: configurationResult.configuration.githubRepos,
      sshKeyChoice: "none",
      updatedAt: configurationResult.configuration.updatedAt,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
  }
}

void restoreSetupState();
