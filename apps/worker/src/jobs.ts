/**
 * Job orchestration: create D1 job rows, dispatch to the host daemon, and
 * fold daemon job status back into container state. Credential-bearing
 * payloads exist only in the signed request body (sealed) — never in D1.
 */
import {
  sealJson,
  TIERS,
  type Agent,
  type JobRequest,
  type ProvisionResult,
} from "@codestation/contract";
import { daemonJobStatus, daemonSubmitJob } from "./daemon.js";
import { buildCredentialPayload, getCredentialsRow } from "./credentials.js";
import { allocatePort, quarantinePort } from "./ports.js";
import { LIFECYCLE_OPS, pendingStatusFor, successStatusFor } from "./state.js";
import type { Bindings, ContainerRow, HostRow, JobRow, UserRow } from "./types.js";

export async function getHost(env: Bindings, hostId: string): Promise<HostRow | null> {
  return env.DB.prepare("SELECT * FROM hosts WHERE id = ?").bind(hostId).first<HostRow>();
}

export async function getContainerForUser(
  env: Bindings,
  userId: string,
): Promise<ContainerRow | null> {
  return env.DB.prepare("SELECT * FROM containers WHERE user_id = ?")
    .bind(userId)
    .first<ContainerRow>();
}

export async function getJob(env: Bindings, jobId: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
}

export async function latestJob(env: Bindings, containerId: string): Promise<JobRow | null> {
  return env.DB.prepare(
    "SELECT * FROM jobs WHERE container_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(containerId)
    .first<JobRow>();
}

async function userSshKeys(env: Bindings, userId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT pubkey FROM ssh_keys WHERE user_id = ?")
    .bind(userId)
    .all<{ pubkey: string }>();
  return rows.results.map((r) => r.pubkey);
}

export function containerAgents(container: ContainerRow): Agent[] {
  return JSON.parse(container.agents) as Agent[];
}

function specOf(container: ContainerRow) {
  return {
    agents: containerAgents(container),
    tier: container.tier,
    cpu: container.cpu,
    ramMb: container.ram_mb,
    diskGb: container.disk_gb,
    sshPort: container.ssh_port ?? 0,
  };
}

/**
 * Build the wire request for a job op. Credentials are decrypted in-memory
 * and immediately sealed to the destination host's X25519 key.
 */
export async function buildJobRequest(
  env: Bindings,
  op: JobRow["op"],
  jobId: string,
  container: ContainerRow,
  host: HostRow,
): Promise<JobRequest> {
  const base = { jobId, containerId: container.id };
  switch (op) {
    case "provision":
    case "rebuild": {
      const credRow = await getCredentialsRow(env, container.user_id);
      const payload = buildCredentialPayload(env, credRow);
      const sealed =
        Object.keys(payload).length > 0 ? sealJson(payload, host.daemon_pubkey) : undefined;
      return {
        op,
        ...base,
        spec: specOf(container),
        sshKeys: await userSshKeys(env, container.user_id),
        dashboardUrl: env.BASE_URL,
        ...(sealed ? { sealedCredentials: sealed } : {}),
      };
    }
    case "refresh-credentials": {
      const credRow = await getCredentialsRow(env, container.user_id);
      const payload = buildCredentialPayload(env, credRow);
      return {
        op,
        ...base,
        dashboardUrl: env.BASE_URL,
        sealedCredentials: sealJson(payload, host.daemon_pubkey),
      };
    }
    case "sync-keys":
      return {
        op,
        ...base,
        sshKeys: await userSshKeys(env, container.user_id),
        dashboardUrl: env.BASE_URL,
      };
    case "resize":
      return { op, ...base, spec: specOf(container) };
    case "start":
    case "stop":
    case "destroy":
    case "export-window":
      return { op, ...base };
  }
}

/**
 * Create a job row and dispatch it to the host daemon. On dispatch failure
 * the job is marked failed and lifecycle ops drop the container into `error`
 * (never a stuck spinner — §5).
 */
export async function enqueueJob(
  env: Bindings,
  op: JobRow["op"],
  container: ContainerRow,
  host: HostRow,
): Promise<JobRow> {
  const jobId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO jobs (id, container_id, op, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
  )
    .bind(jobId, container.id, op, now, now)
    .run();

  const pending = pendingStatusFor(op);
  if (pending) {
    await env.DB.prepare("UPDATE containers SET status = ?, status_detail = NULL WHERE id = ?")
      .bind(pending, container.id)
      .run();
  }

  try {
    // Inside the try: a request-build failure (e.g. bad host key material)
    // must fail the job like a dispatch failure, not leave it stuck queued.
    const request = await buildJobRequest(env, op, jobId, container, host);
    await daemonSubmitJob(env, host, request);
    await env.DB.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?")
      .bind(Date.now(), jobId)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "daemon unreachable";
    await failJob(env, { id: jobId, container_id: container.id, op }, msg);
  }

  const row = await getJob(env, jobId);
  if (!row) throw new Error("job row vanished");
  return row;
}

/**
 * Enqueue a background op against a user's container, if it exists on a host
 * and is in a steady state (running/stopped). No-op otherwise — used for
 * live credential/key pushes where "no container yet" is not an error.
 */
export async function enqueueJobForUser(
  env: Bindings,
  userId: string,
  op: "sync-keys" | "refresh-credentials",
): Promise<void> {
  const container = await getContainerForUser(env, userId);
  if (!container?.host_id) return;
  if (container.status !== "running" && container.status !== "stopped") return;
  const host = await getHost(env, container.host_id);
  if (!host) return;
  await enqueueJob(env, op, container, host);
}

async function failJob(env: Bindings, job: Pick<JobRow, "id" | "container_id" | "op">, error: string) {
  await env.DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
    .bind(error, Date.now(), job.id)
    .run();
  if (LIFECYCLE_OPS.has(job.op)) {
    await env.DB.prepare("UPDATE containers SET status = 'error', status_detail = ? WHERE id = ?")
      .bind(error, job.container_id)
      .run();
  }
}

/** Destroy succeeded: free port + host accounting, drop the container row. */
async function finalizeDestroy(env: Bindings, container: ContainerRow): Promise<void> {
  if (container.host_id && container.ssh_port) {
    await quarantinePort(env, container.host_id, container.ssh_port);
  }
  if (container.host_id) {
    await env.DB.prepare(
      "UPDATE hosts SET ram_allocated_mb = MAX(0, ram_allocated_mb - ?), disk_allocated_gb = MAX(0, disk_allocated_gb - ?) WHERE id = ?",
    )
      .bind(container.ram_mb, container.disk_gb, container.host_id)
      .run();
  }
  await env.DB.prepare("DELETE FROM containers WHERE id = ?").bind(container.id).run();
}

/**
 * Poll the daemon for a non-terminal job and fold the result into D1.
 * Called from dashboard polling and from the reconciler.
 */
export async function refreshJob(env: Bindings, job: JobRow): Promise<JobRow> {
  if (job.status === "succeeded" || job.status === "failed") return job;
  const container = await env.DB.prepare("SELECT * FROM containers WHERE id = ?")
    .bind(job.container_id)
    .first<ContainerRow>();
  if (!container?.host_id) return job;
  const host = await getHost(env, container.host_id);
  if (!host) return job;

  let status;
  try {
    status = await daemonJobStatus(env, host, job.id);
  } catch {
    return job; // transient; reconciler will time it out if it stays stuck
  }

  if (status === null) {
    // The daemon restarted and lost the job: fail fast to error + retry
    // instead of waiting out the stuck-job timeout.
    await failJob(env, job, "job lost (host daemon restarted)");
    return (await getJob(env, job.id)) ?? job;
  }

  if (status.status === "succeeded") {
    await env.DB.prepare("UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ?")
      .bind(Date.now(), job.id)
      .run();
    if (job.op === "destroy") {
      await finalizeDestroy(env, container);
    } else {
      const next = successStatusFor(job.op);
      if (next) {
        await env.DB.prepare(
          "UPDATE containers SET status = ?, status_detail = NULL WHERE id = ?",
        )
          .bind(next, container.id)
          .run();
      }
      const result = status.result as ProvisionResult | null;
      if (result?.hostKeyFingerprints?.length) {
        await env.DB.prepare("UPDATE containers SET host_key_fingerprints = ? WHERE id = ?")
          .bind(JSON.stringify(result.hostKeyFingerprints), container.id)
          .run();
      }
    }
  } else if (status.status === "failed") {
    await failJob(env, job, status.error ?? "job failed on host");
  }

  return (await getJob(env, job.id)) ?? job;
}

// ---------------------------------------------------------------------------
// Placement + provisioning
// ---------------------------------------------------------------------------

/**
 * Scheduler (§10): place on the active host with the most unallocated
 * *non-reserved* RAM above the required headroom; check disk too.
 */
export async function pickHost(
  env: Bindings,
  ramMb: number,
  diskGb: number,
): Promise<HostRow | null> {
  const hosts = await env.DB.prepare("SELECT * FROM hosts WHERE status = 'active'").all<HostRow>();
  let best: HostRow | null = null;
  let bestFree = -1;
  for (const h of hosts.results) {
    const freeRam = h.ram_total_mb - h.ram_reserve_mb - h.ram_allocated_mb;
    const freeDisk = h.disk_total_gb - h.disk_allocated_gb;
    if (freeRam >= ramMb && freeDisk >= diskGb && freeRam > bestFree) {
      best = h;
      bestFree = freeRam;
    }
  }
  return best;
}

export interface ProvisionInput {
  agents: Agent[];
}

/**
 * Create the container row and dispatch the provision job. Returns the
 * container in `provisioning` state, or `waitlisted` when no host has
 * capacity (§10: capacity-exceeded -> waitlist, manual admission).
 */
export async function startProvision(
  env: Bindings,
  user: UserRow,
  input: ProvisionInput,
): Promise<ContainerRow> {
  const tier = TIERS.free;
  const containerId = crypto.randomUUID();
  const now = Date.now();

  const host = await pickHost(env, tier.ramMb, tier.diskGb);
  if (!host) {
    await env.DB.prepare(
      `INSERT INTO containers (id, user_id, agents, tier, cpu, ram_mb, disk_gb, status, created_at)
       VALUES (?, ?, ?, 'free', ?, ?, ?, 'waitlisted', ?)`,
    )
      .bind(containerId, user.id, JSON.stringify(input.agents), tier.cpu, tier.ramMb, tier.diskGb, now)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO waitlist (user_id, requested_at) VALUES (?, ?)",
    )
      .bind(user.id, now)
      .run();
    const row = await getContainerForUser(env, user.id);
    if (!row) throw new Error("container row vanished");
    return row;
  }

  const port = await allocatePort(env, host.id);
  await env.DB.prepare(
    `INSERT INTO containers (id, user_id, host_id, ssh_port, agents, tier, cpu, ram_mb, disk_gb, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'free', ?, ?, ?, 'provisioning', ?)`,
  )
    .bind(containerId, user.id, host.id, port, JSON.stringify(input.agents), tier.cpu, tier.ramMb, tier.diskGb, now)
    .run();
  await env.DB.prepare(
    "UPDATE hosts SET ram_allocated_mb = ram_allocated_mb + ?, disk_allocated_gb = disk_allocated_gb + ? WHERE id = ?",
  )
    .bind(tier.ramMb, tier.diskGb, host.id)
    .run();

  const container = await getContainerForUser(env, user.id);
  if (!container) throw new Error("container row vanished");
  await enqueueJob(env, "provision", container, host);
  const fresh = await getContainerForUser(env, user.id);
  return fresh ?? container;
}
