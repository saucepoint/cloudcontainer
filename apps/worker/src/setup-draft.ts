import {
  AGENTS,
  GithubReposSchema,
  INPUT_LIMITS,
  type Agent,
} from "@workbench/contract";
import type { Bindings } from "./types.js";

export const SETUP_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export const SETUP_DRAFT_STEPS = [
  "agents",
  "agent-auth",
  "github",
  "tools",
  "ssh",
  "review",
] as const;
export type SetupDraftStep = (typeof SETUP_DRAFT_STEPS)[number];

export const SETUP_DRAFT_CATEGORIES = ["agents", "github", "ssh"] as const;
export type SetupDraftCategory = (typeof SETUP_DRAFT_CATEGORIES)[number];

export const SETUP_SSH_CHOICES = ["none", "default", "dedicated", "manual"] as const;
export type SetupSshChoice = (typeof SETUP_SSH_CHOICES)[number];

export interface SetupDraft {
  step: SetupDraftStep;
  agents: Agent[];
  githubRepos: string[];
  sshKeyChoice: SetupSshChoice;
  updatedAt: number;
  expiresAt: number;
}

interface SetupDraftInput {
  step?: unknown;
  agents?: unknown;
  githubRepos?: unknown;
  sshKeyChoice?: unknown;
}

interface SetupDraftRow {
  user_id: string;
  draft: string;
  updated_at: number;
  expires_at: number;
}

function isSetupDraftStep(value: unknown): value is SetupDraftStep {
  return typeof value === "string"
    && (SETUP_DRAFT_STEPS as readonly string[]).includes(value);
}

function isSetupSshChoice(value: unknown): value is SetupSshChoice {
  return typeof value === "string"
    && (SETUP_SSH_CHOICES as readonly string[]).includes(value);
}

function normalizeAgents(value: unknown): Agent[] | null {
  if (!Array.isArray(value)) return null;
  const requested = new Set(value);
  if (
    requested.size !== value.length
    || [...requested].some((agent) => !(AGENTS as readonly unknown[]).includes(agent))
  ) {
    return null;
  }
  return AGENTS.filter((agent) => requested.has(agent));
}

export function normalizeSetupDraftInput(
  input: SetupDraftInput,
): { value: Omit<SetupDraft, "updatedAt" | "expiresAt"> } | { error: string } {
  const agents = normalizeAgents(input.agents ?? []);
  if (!agents) return { error: "setup draft agents must be a unique list of known agents" };

  const githubRepos = input.githubRepos ?? [];
  if (!Array.isArray(githubRepos) || githubRepos.length > INPUT_LIMITS.githubReposPerProvision) {
    return { error: "setup draft repositories must be a list of at most 20 repositories" };
  }
  const parsedRepos = GithubReposSchema.safeParse([...new Set(githubRepos)]);
  if (!parsedRepos.success || parsedRepos.data.length !== githubRepos.length) {
    return { error: "setup draft contains invalid or duplicate repositories" };
  }

  const step = input.step === undefined ? "agents" : input.step;
  if (!isSetupDraftStep(step)) return { error: "setup draft step is invalid" };

  const sshKeyChoice = input.sshKeyChoice === undefined ? "none" : input.sshKeyChoice;
  if (!isSetupSshChoice(sshKeyChoice)) return { error: "setup draft SSH choice is invalid" };

  return {
    value: {
      step,
      agents,
      githubRepos: parsedRepos.data,
      sshKeyChoice,
    },
  };
}

function parseStoredDraft(row: SetupDraftRow, now: number): SetupDraft | null {
  if (row.expires_at <= now) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(row.draft);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = normalizeSetupDraftInput(raw as SetupDraftInput);
  if ("error" in parsed) return null;
  return {
    ...parsed.value,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export async function getSetupDraft(
  env: Bindings,
  userId: string,
  now = Date.now(),
): Promise<SetupDraft | null> {
  const row = await env.DB.prepare(
    "SELECT user_id, draft, updated_at, expires_at FROM setup_drafts WHERE user_id = ?",
  )
    .bind(userId)
    .first<SetupDraftRow>();
  if (!row) return null;
  const draft = parseStoredDraft(row, now);
  if (draft) return draft;
  await env.DB.prepare("DELETE FROM setup_drafts WHERE user_id = ?").bind(userId).run();
  return null;
}

export async function putSetupDraft(
  env: Bindings,
  userId: string,
  input: SetupDraftInput,
  now = Date.now(),
): Promise<SetupDraft> {
  const normalized = normalizeSetupDraftInput(input);
  if ("error" in normalized) throw new Error(normalized.error);
  const expiresAt = now + SETUP_DRAFT_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO setup_drafts (user_id, draft, updated_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       draft = excluded.draft,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`,
  )
    .bind(userId, JSON.stringify(normalized.value), now, expiresAt)
    .run();
  return { ...normalized.value, updatedAt: now, expiresAt };
}

export async function deleteSetupDraft(env: Bindings, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM setup_drafts WHERE user_id = ?").bind(userId).run();
}

/** Clear one non-secret part of a saved setup draft without touching the rest. */
export async function clearSetupDraftCategory(
  env: Bindings,
  userId: string,
  category: SetupDraftCategory,
  now = Date.now(),
): Promise<SetupDraft | null> {
  const draft = await getSetupDraft(env, userId, now);
  if (!draft) return null;

  const next = {
    step: draft.step,
    agents: category === "agents" ? [] : draft.agents,
    githubRepos: category === "github" ? [] : draft.githubRepos,
    sshKeyChoice: category === "ssh" ? "none" as const : draft.sshKeyChoice,
  };
  if (next.agents.length === 0 && next.githubRepos.length === 0 && next.sshKeyChoice === "none") {
    await deleteSetupDraft(env, userId);
    return null;
  }

  await env.DB.prepare(
    "UPDATE setup_drafts SET draft = ?, updated_at = ? WHERE user_id = ?",
  )
    .bind(JSON.stringify(next), now, userId)
    .run();
  return { ...next, updatedAt: now, expiresAt: draft.expiresAt };
}
