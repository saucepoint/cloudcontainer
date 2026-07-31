import { INPUT_LIMITS, LLM_PROVIDERS, OAUTH_ONLY_LLM_PROVIDERS } from "@workbench/contract";
import {
  claudeOauthFlow,
  claudeOauthFlowFor,
  chatgptOauthFlow,
  codexDeviceFlow,
  copilotDeviceFlow,
  isAuthFlowActive,
  wranglerOauthFlow,
} from "./auth-flows.js";
import { errorMessage, HttpError, requestJson } from "./http.js";

const PASTEABLE_PROVIDERS = LLM_PROVIDERS.filter(
  (provider) => !(OAUTH_ONLY_LLM_PROVIDERS as readonly string[]).includes(provider),
);

function element<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const found = element<T>(id);
  if (!found) throw new Error(`missing required onboarding element: ${id}`);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const form = requiredElement<HTMLFormElement>("wizard");

form.addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const button = requiredElement<HTMLButtonElement>("go");
  const errorElement = requiredElement<HTMLElement>("err");
  errorElement.textContent = "";
  const data = new FormData(form);
  const llmKeys: Record<string, string> = {};
  for (const provider of PASTEABLE_PROVIDERS) {
    const value = (data.get(`llm_${provider}`) || "").toString().trim();
    if (value) llmKeys[provider] = value;
  }
  const body = {
    agents: data.getAll("agent").map((agent) => agent.toString()),
    sshPubkey: (data.get("sshPubkey") || "").toString().trim(),
    llmKeys,
    cloudflareToken: (data.get("cloudflareToken") || "").toString().trim() || undefined,
    githubRepos: data.getAll("githubRepo").map((repository) => repository.toString()),
  };
  if (body.agents.length === 0) {
    errorElement.textContent = "Pick at least one agent first.";
    errorElement.focus();
    return;
  }
  button.disabled = true;
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  button.replaceChildren(spinner, "Starting…");
  try {
    await requestJson("/api/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, "provisioning failed");
    location.href = "/dashboard";
  } catch (error) {
    errorElement.textContent = errorMessage(error);
    errorElement.focus();
    button.disabled = false;
    button.textContent = "Create workbench →";
  }
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

const githubConnect = element<HTMLAnchorElement>("github-connect");
if (githubConnect) {
  const agentSelectionKey = "workbench-github-agents";
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(agentSelectionKey) || "[]");
    const selected = new Set(
      Array.isArray(saved) ? saved.filter((agent): agent is string => typeof agent === "string") : [],
    );
    for (const input of form.querySelectorAll<HTMLInputElement>('input[name="agent"]')) {
      input.checked = selected.has(input.value);
    }
  } catch {
    // Storage can be unavailable or contain data from an older UI.
  }
  try {
    sessionStorage.removeItem(agentSelectionKey);
  } catch {
    // Storage is an optional convenience.
  }

  const saveGithubAgents = () => {
    try {
      sessionStorage.setItem(
        agentSelectionKey,
        JSON.stringify(new FormData(form).getAll("agent").map((agent) => agent.toString())),
      );
    } catch {
      // Storage is an optional convenience.
    }
  };
  githubConnect.addEventListener("click", saveGithubAgents);
}

type GithubRepository = {
  fullName: string;
  private: boolean;
  archived: boolean;
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
    metadata.textContent = `${repository.private ? "private" : "public"}${repository.archived ? " · archived" : ""}`;
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
    status.textContent = "Search for a repository by owner or name.";
    return;
  }
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  status.replaceChildren(spinner, "Searching GitHub…");
  try {
    const json = await requestJson<{ repositories?: unknown }>(
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
      : "No accessible repositories match your search.";
    renderGithubRepositories(repositories);
  } catch (error) {
    status.textContent = error instanceof HttpError && error.status === 409
      ? "Connect GitHub to search repositories."
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
});

let githubSearchTimer: ReturnType<typeof setTimeout> | undefined;
githubSearch?.addEventListener("input", () => {
  clearTimeout(githubSearchTimer);
  githubSearchTimer = setTimeout(() => loadGithubRepositories(githubSearch.value), 250);
});
