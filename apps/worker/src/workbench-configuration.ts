import { AGENTS, GithubReposSchema, type Agent } from "@workbench/contract";
import type { Bindings } from "./types.js";

export interface WorkbenchConfiguration {
  agents: Agent[];
  githubRepos: string[];
  createdAt: number;
  updatedAt: number;
}

interface WorkbenchConfigurationRow {
  agents: string;
  github_repos: string;
  created_at: number;
  updated_at: number;
}

function parseAgents(value: string): Agent[] | null {
  try {
    const raw = JSON.parse(value) as unknown;
    if (!Array.isArray(raw)) return null;
    const selected = new Set(raw);
    if (selected.size === 0 || selected.size !== raw.length) return null;
    if ([...selected].some((agent) => !(AGENTS as readonly unknown[]).includes(agent))) return null;
    return AGENTS.filter((agent) => selected.has(agent));
  } catch {
    return null;
  }
}

function parseGithubRepos(value: string): string[] | null {
  try {
    const raw = JSON.parse(value) as unknown;
    const result = GithubReposSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function getWorkbenchConfiguration(
  env: Bindings,
  userId: string,
): Promise<WorkbenchConfiguration | null> {
  const row = await env.DB.prepare(
    `SELECT agents, github_repos, created_at, updated_at
     FROM workbench_configurations WHERE user_id = ?`,
  ).bind(userId).first<WorkbenchConfigurationRow>();
  if (!row) return null;
  const agents = parseAgents(row.agents);
  const githubRepos = parseGithubRepos(row.github_repos);
  if (!agents || !githubRepos) throw new Error("stored workbench configuration is invalid");
  return {
    agents,
    githubRepos,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function putWorkbenchConfiguration(
  env: Bindings,
  userId: string,
  input: { agents: Agent[]; githubRepos: string[] },
  now = Date.now(),
): Promise<WorkbenchConfiguration> {
  await env.DB.prepare(
    `INSERT INTO workbench_configurations
       (user_id, agents, github_repos, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       agents = excluded.agents,
       github_repos = excluded.github_repos,
       updated_at = excluded.updated_at`,
  ).bind(userId, JSON.stringify(input.agents), JSON.stringify(input.githubRepos), now, now).run();
  const configuration = await getWorkbenchConfiguration(env, userId);
  if (!configuration) throw new Error("workbench configuration could not be saved");
  return configuration;
}
