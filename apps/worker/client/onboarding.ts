import { INPUT_LIMITS, LLM_PROVIDERS, OAUTH_ONLY_LLM_PROVIDERS } from "@codestation/contract";
import {
  claudeOauthFlow,
  codexDeviceFlow,
  copilotDeviceFlow,
  isAuthFlowActive,
  wranglerOauthFlow,
} from "./auth-flows.js";

const PASTEABLE_PROVIDERS = LLM_PROVIDERS.filter((provider) => !(OAUTH_ONLY_LLM_PROVIDERS as readonly string[]).includes(provider));
const element = (id: string): any => document.getElementById(id);
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Unknown error";
const form = element('wizard');
form.addEventListener('submit', async (e: SubmitEvent) => {
  e.preventDefault();
  const btn = element('go');
  const err = element('err');
  err.textContent = '';
  const data = new FormData(form);
  const llmKeys: Record<string, string> = {};
  for (const k of PASTEABLE_PROVIDERS) {
    const v = (data.get('llm_' + k) || '').toString().trim();
    if (v) llmKeys[k] = v;
  }
  const body = {
    agents: data.getAll('agent').map((a) => a.toString()),
    sshPubkey: (data.get('sshPubkey') || '').toString().trim(),
    llmKeys,
    cloudflareToken: (data.get('cloudflareToken') || '').toString().trim() || undefined,
    githubRepos: data.getAll('githubRepo').map((repo) => repo.toString()),
  };
  if (body.agents.length === 0) {
    err.textContent = 'Pick at least one agent first.';
    err.focus();
    return;
  }
  btn.disabled = true;
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  btn.replaceChildren(spinner, 'Starting…');
  try {
    const res = await fetch('/api/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'provisioning failed');
    location.href = '/dashboard';
  } catch (e2) {
    err.textContent = messageOf(e2);
    err.focus();
    btn.disabled = false;
    btn.textContent = 'Create server →';
  }
});

// Sign-in flows store their credential server-side the moment they complete,
// so they need no field in the provision body.
function wireSignin(id: string, flowFn: (element: HTMLElement, done: () => void) => void) {
  const btn = element(id + '-signin');
  btn.addEventListener('click', () => {
    if (isAuthFlowActive()) return;
    flowFn(element(id + '-flow'), () => {
      element(id + '-flow').replaceChildren();
      btn.style.display = 'none';
      element(id + '-connected').style.display = '';
    });
  });
}
wireSignin('claude', claudeOauthFlow);
wireSignin('codex', codexDeviceFlow);
wireSignin('copilot', copilotDeviceFlow);
wireSignin('wrangler', wranglerOauthFlow);

const githubConnect = element('github-connect');
const githubReauthorize = element('github-reauthorize');
if (githubConnect || githubReauthorize) {
  const agentSelectionKey = 'codestation-github-agents';
  try {
    const saved = JSON.parse(sessionStorage.getItem(agentSelectionKey) || '[]');
    const selected = new Set(Array.isArray(saved) ? saved.filter((agent) => typeof agent === 'string') : []);
    for (const input of form.querySelectorAll('input[name="agent"]')) {
      input.checked = selected.has(input.value);
    }
  } catch (_) {
    // Storage can be unavailable or contain data from an older UI; both are safe to ignore.
  }
  try { sessionStorage.removeItem(agentSelectionKey); } catch (_) {}

  const saveGithubAgents = () => {
    try {
      sessionStorage.setItem(agentSelectionKey, JSON.stringify(
        new FormData(form).getAll('agent').map((agent) => agent.toString())
      ));
    } catch (_) {}
  };
  if (githubConnect) githubConnect.addEventListener('click', saveGithubAgents);
  if (githubReauthorize) githubReauthorize.addEventListener('click', async () => {
    saveGithubAgents();
    githubReauthorize.disabled = true;
    try {
      const res = await fetch('/auth/github/reauth?return_to=/onboarding', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.authorizationUrl) throw new Error(json.error || 'Could not reset GitHub authorization.');
      location.href = json.authorizationUrl;
    } catch (error) {
      const status = element('github-status');
      status.textContent = messageOf(error) || 'Could not reset GitHub authorization.';
      githubReauthorize.disabled = false;
    }
  });
}

const selectedGithubRepositories = new Set<string>();
type GithubRepository = {
  fullName: string;
  private: boolean;
  archived: boolean;
  description?: string | null;
};
const knownGithubRepositories = new Map<string, GithubRepository>();

function renderGithubRepositories(repositories: GithubRepository[]) {
  const list = element('github-repos');
  const visible = new Map<string, GithubRepository>(repositories.map((repo) => [repo.fullName, repo]));
  for (const fullName of selectedGithubRepositories) {
    const repo = knownGithubRepositories.get(fullName);
    if (repo) visible.set(fullName, repo);
  }
  const choices = [...visible.values()].map((repo, index) => {
    const visibility = repo.private ? 'private' : 'public';
    const archived = repo.archived ? ' · archived' : '';
    const label = document.createElement('label');
    const input = document.createElement('input');
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    const metadata = document.createElement('small');
    label.className = 'repo-choice';
    label.htmlFor = `github-repo-${index}`;
    input.type = 'checkbox';
    input.id = `github-repo-${index}`;
    input.name = 'githubRepo';
    input.value = repo.fullName;
    input.checked = selectedGithubRepositories.has(repo.fullName);
    input.disabled = !input.checked && selectedGithubRepositories.size >= INPUT_LIMITS.githubReposPerProvision;
    name.textContent = repo.fullName;
    metadata.textContent = visibility + archived;
    copy.append(name, metadata);
    if (repo.description) {
      const description = document.createElement('small');
      description.textContent = repo.description;
      copy.append(description);
    }
    label.append(input, copy);
    return label;
  });
  list.replaceChildren(...choices);
}

async function loadGithubRepositories(query: string) {
  const list = element('github-repos');
  if (!list) return;
  const status = element('github-status');
  if (!query.trim()) {
    renderGithubRepositories([]);
    status.textContent = 'Search for a repository by owner or name.';
    return;
  }
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  status.replaceChildren(spinner, 'Searching GitHub…');
  try {
    const res = await fetch('/api/github/repos?q=' + encodeURIComponent(query));
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409) {
        status.textContent = 'Connect GitHub to search repositories.';
        return;
      }
      throw new Error(json.error || 'Could not load repositories');
    }
    const repositories = Array.isArray(json.repositories) ? json.repositories : [];
    for (const repo of repositories) knownGithubRepositories.set(repo.fullName, repo);
    status.textContent = repositories.length
      ? 'Choose up to ' + INPUT_LIMITS.githubReposPerProvision + ' repositories.'
      : 'No accessible repositories match your search.';
    renderGithubRepositories(repositories);
  } catch (error) {
    status.textContent = messageOf(error) || 'Could not load GitHub repositories.';
  }
}

const githubSearch = element('github-repo-search');
const githubRepoList = element('github-repos');
if (githubRepoList) githubRepoList.addEventListener('change', (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (!target.matches('input[name="githubRepo"]')) return;
  if (target.checked) selectedGithubRepositories.add(target.value);
  else selectedGithubRepositories.delete(target.value);
  const checked = selectedGithubRepositories.size;
  for (const input of githubRepoList.querySelectorAll('input:not(:checked)')) {
    input.disabled = checked >= INPUT_LIMITS.githubReposPerProvision;
  }
});
let githubSearchTimer: ReturnType<typeof setTimeout> | undefined;
if (githubSearch) githubSearch.addEventListener('input', () => {
  clearTimeout(githubSearchTimer);
  githubSearchTimer = setTimeout(() => loadGithubRepositories(githubSearch.value), 250);
});
