import { ProvisionResultSchema, type JobOp } from "@workbench/contract";
import { decryptLlmKeys, getCredentialsRow } from "./credentials.js";
import { githubConfigured } from "./github.js";
import {
  containerAgents,
  getContainerForUser,
  latestJob,
  refreshJob,
} from "./jobs.js";
import { allowedUserOps } from "./state.js";
import { hasSshKey, sshCommandFor } from "./ssh.js";
import type { Bindings, ContainerRow, JobRow } from "./types.js";

interface ContainerView {
  id: string;
  status: string;
  statusDetail: string | null;
  agents: string[];
  tier: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  planTransition: {
    desiredTier: string;
    state: string;
    requestedAt: number;
  } | null;
  sshCommand: string | null;
  hostKeyFingerprints: string[];
  createdAt: number;
  job: { id: string; op: JobOp; status: string; error: string | null } | null;
  allowedOps: JobOp[];
}

function hostKeyFingerprints(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = ProvisionResultSchema.shape.hostKeyFingerprints.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function containerView(
  env: Bindings,
  container: ContainerRow,
  job: JobRow | null,
): Promise<ContainerView> {
  const transition = container.status === "upgrade_pending"
    ? await env.DB.prepare(
        `SELECT prior_status, to_tier, state, requested_at,
                reserved_cpu, reserved_ram_mb, reserved_disk_gb
         FROM container_plan_transitions
         WHERE container_id = ? AND state NOT IN ('complete','cancelled')`,
      ).bind(container.id).first<{
        prior_status: "running" | "stopped";
        to_tier: string;
        state: string;
        requested_at: number;
        reserved_cpu: number;
        reserved_ram_mb: number;
        reserved_disk_gb: number;
      }>()
    : null;
  const sshCommand =
    (container.status === "running" || transition?.prior_status === "running") &&
      (await hasSshKey(env, container.user_id))
      ? await sshCommandFor(env, container)
      : null;
  return {
    id: container.id,
    status: container.status,
    statusDetail: container.status_detail,
    agents: containerAgents(container),
    tier: container.tier,
    cpu: container.cpu,
    ramMb: container.ram_mb,
    diskGb: container.disk_gb,
    planTransition: transition
      ? {
          desiredTier: transition.to_tier,
          state: transition.state,
          requestedAt: transition.requested_at,
        }
      : null,
    sshCommand,
    hostKeyFingerprints: hostKeyFingerprints(container.host_key_fingerprints),
    createdAt: container.created_at,
    job: job ? { id: job.id, op: job.op, status: job.status, error: job.error } : null,
    allowedOps: container.status === "upgrade_pending" && transition &&
        transition.reserved_cpu === 0 && transition.reserved_ram_mb === 0 &&
        transition.reserved_disk_gb === 0 &&
        ["requested", "waiting_capacity"].includes(transition.state)
      ? ["destroy"]
      : allowedUserOps(container.status),
  };
}

export async function currentContainerView(
  env: Bindings,
  userId: string,
): Promise<ContainerView | null> {
  const container = await getContainerForUser(env, userId);
  if (!container) return null;
  let job = await latestJob(env, container.id);
  if (job && (job.status === "queued" || job.status === "running")) {
    job = await refreshJob(env, job);
  }
  // A completed destroy removes the row while its job is being refreshed.
  const fresh = await getContainerForUser(env, userId);
  return fresh ? containerView(env, fresh, job) : null;
}

export async function credentialsView(env: Bindings, userId: string) {
  const row = await getCredentialsRow(env, userId);
  const llm = decryptLlmKeys(env, row);
  const authTokens = await env.DB.prepare(
    `SELECT 1 AS present FROM auth_accounts
     WHERE user_id = ?
       AND (access_token IS NOT NULL OR refresh_token IS NOT NULL OR id_token IS NOT NULL)
     LIMIT 1`,
  )
    .bind(userId)
    .first<{ present: number }>();
  // Presence only — credential values never leave the control plane.
  return {
    llm: Object.fromEntries(Object.keys(llm).map((key) => [key, true])),
    cloudflare: Boolean(row?.cloudflare_token),
    supabase: Boolean(row?.supabase_token),
    convex: Boolean(row?.convex_token),
    wrangler: Boolean(row?.wrangler_oauth),
    github: row?.github_login ?? (row?.github_token ? "connected" : null),
    githubAvailable: githubConfigured(env),
    hasCredentials: Boolean(
      row?.github_token
      || row?.github_refresh_token
      || row?.cloudflare_token
      || row?.wrangler_oauth
      || Object.keys(llm).length
      || authTokens,
    ),
  };
}
