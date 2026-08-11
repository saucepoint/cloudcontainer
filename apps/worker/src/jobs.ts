/**
 * Job orchestration: create D1 job rows, dispatch to the host daemon, and
 * fold daemon job status back into container state. Credential-bearing
 * payloads exist only in the signed request body (sealed) — never in D1.
 */
import {
  AgentsSchema,
  GithubReposSchema,
  JobRequestSchema,
  MIXED_TIER_SHARED_CAPABILITY,
  TIERS,
  sealJson,
  type Agent,
  type JobRequest,
  type ProvisionResult,
} from "@workbench/contract";
import { daemonJobStatus, daemonSubmitJob } from "./daemon.js";
import { cpuReservation } from "./capacity.js";
import { buildCredentialPayload, getCredentialsRow } from "./credentials.js";
import { LIFECYCLE_OPS, pendingStatusFor, successStatusFor } from "./state.js";
import type { Bindings, ContainerRow, HostRow, JobRow } from "./types.js";

export class LifecycleJobConflictError extends Error {
  constructor() {
    super("container state changed or lifecycle operation already in progress");
    this.name = "LifecycleJobConflictError";
  }
}

export class HostJobAdmissionError extends Error {
  constructor() {
    super("host is not accepting jobs while it is draining or unhealthy");
    this.name = "HostJobAdmissionError";
  }
}

export class ContainerPlacementConflictError extends Error {
  constructor() {
    super("container placement conflicts with its host; an administrator must re-home it");
    this.name = "ContainerPlacementConflictError";
  }
}

function validateContainerPlacement(
  op: JobRow["op"],
  container: ContainerRow,
  host: HostRow,
): void {
  // Only spec-bearing operations are rejected by the daemon. Start, stop, and
  // especially destroy remain available so a divergent row is never trapped.
  if (op !== "provision" && op !== "rebuild" && op !== "resize") return;
  const capabilities = host.daemon_capabilities ?? "";
  const mixedShared = host.tenancy_mode === "shared" &&
    capabilities.includes(MIXED_TIER_SHARED_CAPABILITY);
  const hostTier = host.host_type === "budget" ? "free" : "paid";
  const compatible = container.placement_mode === host.tenancy_mode && (
    mixedShared ||
    (container.placement_class === host.host_type && container.tier === hostTier)
  );
  if (!compatible) {
    throw new ContainerPlacementConflictError();
  }
}

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
    "SELECT * FROM jobs WHERE container_id = ? ORDER BY rowid DESC LIMIT 1",
  )
    .bind(containerId)
    .first<JobRow>();
}

export async function latestLifecycleJob(
  env: Bindings,
  containerId: string,
): Promise<JobRow | null> {
  return env.DB.prepare(
    `SELECT * FROM jobs
     WHERE container_id = ?
       AND op IN ('provision','rebuild','start','stop','destroy','resize')
     ORDER BY rowid DESC LIMIT 1`,
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
  return AgentsSchema.parse(JSON.parse(container.agents));
}

function specOf(
  container: ContainerRow,
  desired?: { tier: ContainerRow["tier"]; ramMb: number; diskGb: number },
) {
  const tier = desired?.tier ?? container.tier;
  return {
    agents: containerAgents(container),
    tier,
    // The D1/public view and daemon job spec both use the advertised tier value.
    cpu: cpuReservation(tier),
    ramMb: desired?.ramMb ?? container.ram_mb,
    diskGb: desired?.diskGb ?? container.disk_gb,
    sshPort: container.ssh_port ?? 0,
  };
}

function githubReposOf(container: ContainerRow): string[] {
  return GithubReposSchema.parse(JSON.parse(container.github_repos || "[]"));
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
  revision?: number,
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
        githubRepos: githubReposOf(container),
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
        ...(revision !== undefined ? { revision } : {}),
      };
    }
    case "sync-keys":
      return {
        op,
        ...base,
        sshKeys: await userSshKeys(env, container.user_id),
        dashboardUrl: env.BASE_URL,
        ...(revision !== undefined ? { revision } : {}),
      };
    case "resize": {
      const transition = await env.DB.prepare(
        `SELECT to_tier, target_disk_gb FROM container_plan_transitions
         WHERE container_id = ? AND state = 'resizing'`,
      ).bind(container.id).first<{ to_tier: ContainerRow["tier"]; target_disk_gb: number }>();
      const desired = transition
        ? {
            tier: transition.to_tier,
            ramMb: TIERS[transition.to_tier].ramMb,
            diskGb: transition.target_disk_gb,
          }
        : undefined;
      return { op, ...base, spec: specOf(container, desired) };
    }
    case "start": {
      const credRow = await getCredentialsRow(env, container.user_id);
      const payload = buildCredentialPayload(env, credRow);
      return {
        op,
        ...base,
        sshKeys: await userSshKeys(env, container.user_id),
        dashboardUrl: env.BASE_URL,
        // Always send a full snapshot, including an empty one, so managed
        // environment/GitHub credentials removed while stopped are cleared
        // before SSH returns.
        sealedCredentials: sealJson(payload, host.daemon_pubkey),
      };
    }
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
  validateContainerPlacement(op, container, host);
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const pending = pendingStatusFor(op);
  let inserted: { meta: { changes?: number } };
  if (LIFECYCLE_OPS.has(op)) {
    const insertion = env.DB.prepare(
      `INSERT INTO jobs (id, container_id, op, status, created_at, updated_at)
       SELECT ?, c.id, ?, 'queued', ?, ? FROM containers c
       WHERE c.id = ? AND c.status = ? AND c.host_id = ?
         AND EXISTS (
           SELECT 1 FROM hosts h WHERE h.id = ? AND h.status = 'active'
         )
         AND NOT EXISTS (
           SELECT 1 FROM jobs
           WHERE container_id = c.id AND status IN ('queued','running')
             AND op IN ('provision','rebuild','start','stop','destroy','resize')
         )`,
    ).bind(jobId, op, now, now, container.id, container.status, host.id, host.id);
    if (pending) {
      const results = (await env.DB.batch([
        insertion,
        env.DB.prepare(
          `UPDATE containers SET status = ?, status_detail = NULL
           WHERE id = ? AND status = ? AND host_id = ? AND changes() = 1`,
        ).bind(pending, container.id, container.status, host.id),
      ])) as Array<{ meta: { changes?: number } }>;
      inserted = results[0] ?? { meta: {} };
    } else {
      inserted = await insertion.run();
    }
    if (!inserted.meta.changes) {
      const currentHost = await getHost(env, host.id);
      if (currentHost?.status !== "active") throw new HostJobAdmissionError();
      throw new LifecycleJobConflictError();
    }
  } else {
    inserted = await env.DB.prepare(
      `INSERT INTO jobs (id, container_id, op, status, created_at, updated_at)
       SELECT ?, ?, ?, 'queued', ?, ?
       WHERE EXISTS (SELECT 1 FROM hosts WHERE id = ? AND status = 'active')`,
    )
      .bind(jobId, container.id, op, now, now, host.id)
      .run();
    if (!inserted.meta.changes) throw new HostJobAdmissionError();
  }

  try {
    // Inside the try: a request-build failure (e.g. bad host key material)
    // must fail the job like a dispatch failure, not leave it stuck queued.
    //
    // Background snapshot ops carry their job rowid as a monotonic revision
    // so the daemon can discard a delayed older snapshot instead of letting
    // it overwrite newer desired state. Rows insert in commit order, so a
    // higher rowid always holds a same-or-newer view of D1.
    const revision = op !== "sync-keys" && op !== "refresh-credentials"
      ? undefined
      : ((await env.DB.prepare("SELECT rowid FROM jobs WHERE id = ?")
          .bind(jobId)
          .first<{ rowid: number }>())?.rowid ?? undefined);
    const request = JobRequestSchema.parse(
      await buildJobRequest(env, op, jobId, container, host, revision),
    );
    await daemonSubmitJob(env, host, request);
    await env.DB.prepare(
      "UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'",
    )
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
 * and is running. Updates made while stopped remain encrypted in D1 and are
 * applied from a full snapshot by the next `start` job. No-op when there is
 * no running container — credential/key writes themselves still succeed.
 */
export async function enqueueJobForUser(
  env: Bindings,
  userId: string,
  op: "sync-keys" | "refresh-credentials",
): Promise<void> {
  const container = await getContainerForUser(env, userId);
  if (!container?.host_id) return;
  if (container.status !== "running") return;
  const host = await getHost(env, container.host_id);
  if (!host || host.status !== "active") return;
  try {
    await enqueueJob(env, op, container, host);
  } catch (error) {
    // The host may have drained after the read. The desired key/credential
    // mutation is already in D1 and the next start carries a full snapshot.
    if (error instanceof HostJobAdmissionError) return;
    throw error;
  }
}

async function failJob(env: Bindings, job: Pick<JobRow, "id" | "container_id" | "op">, error: string) {
  const failedAt = Date.now();
  const claim = env.DB.prepare(
    `UPDATE jobs SET status = 'failed', error = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued','running')`,
  ).bind(error, failedAt, job.id);
  if (!LIFECYCLE_OPS.has(job.op)) {
    await claim.run();
    return;
  }
  if (job.op === "resize") {
    const transition = await env.DB.prepare(
      `SELECT container_id FROM container_plan_transitions
       WHERE container_id = ? AND state = 'resizing'`,
    ).bind(job.container_id).first();
    if (transition) {
      await env.DB.batch([
        claim,
        env.DB.prepare(
          `UPDATE container_plan_transitions
           SET state = 'failed_retryable', updated_at = ?, last_error_code = 'resize_failed'
           WHERE container_id = ? AND state = 'resizing' AND changes() = 1`,
        ).bind(failedAt, job.container_id),
        env.DB.prepare(
          `UPDATE containers
           SET status = 'upgrade_pending', status_detail = 'resource change will retry automatically'
           WHERE id = ? AND changes() = 1`,
        ).bind(job.container_id),
      ]);
      return;
    }
  }
  if (job.op === "stop") {
    const downgrade = await env.DB.prepare(
      `SELECT 1 FROM container_plan_transitions
       WHERE container_id = ? AND to_tier = 'free' AND prior_status = 'running'
         AND state IN ('requested','waiting_capacity','failed_retryable')`,
    ).bind(job.container_id).first();
    if (downgrade) {
      await env.DB.batch([
        claim,
        env.DB.prepare(
          `UPDATE container_plan_transitions
           SET state = 'failed_retryable', updated_at = ?,
               last_error_code = 'downgrade_stop_failed'
           WHERE container_id = ? AND to_tier = 'free'
             AND state IN ('requested','waiting_capacity','failed_retryable')
             AND changes() = 1`,
        ).bind(failedAt, job.container_id),
        env.DB.prepare(
          `UPDATE containers
           SET status = 'upgrade_pending',
               status_detail = 'paid access ended; stop will retry automatically'
           WHERE id = ? AND changes() = 1`,
        ).bind(job.container_id),
      ]);
      return;
    }
  }
  await env.DB.batch([
    claim,
    env.DB.prepare(
      `UPDATE containers SET status = 'error', status_detail = ?
       WHERE id = ? AND changes() = 1 AND ? = (
         SELECT id FROM jobs
         WHERE container_id = ?
           AND op IN ('provision','rebuild','start','stop','destroy','resize')
         ORDER BY rowid DESC LIMIT 1
       )`,
    ).bind(error, job.container_id, job.id, job.container_id),
  ]);
}

/** Keep the plan transition locked while a running downgrade is stopped. */
async function finalizeDowngradeStop(
  env: Bindings,
  job: JobRow,
  container: ContainerRow,
  completedAt: number,
): Promise<boolean> {
  const results = (await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = 'succeeded', updated_at = ?
       WHERE id = ? AND status IN ('queued','running') AND ? = (
         SELECT id FROM jobs
         WHERE container_id = ?
           AND op IN ('provision','rebuild','start','stop','destroy','resize')
         ORDER BY rowid DESC LIMIT 1
       )`,
    ).bind(completedAt, job.id, job.id, container.id),
    env.DB.prepare(
      `UPDATE container_plan_transitions
       SET prior_status = 'stopped', updated_at = ?, last_error_code = NULL
       WHERE container_id = ? AND to_tier = 'free' AND prior_status = 'running'
         AND state IN ('requested','waiting_capacity','failed_retryable')
         AND changes() = 1`,
    ).bind(completedAt, container.id),
    env.DB.prepare(
      `UPDATE containers
       SET status = 'upgrade_pending',
           status_detail = 'workbench stopped; applying free resources'
       WHERE id = ? AND changes() = 1`,
    ).bind(container.id),
  ])) as Array<{ meta?: { changes?: number } }>;
  return Boolean(results[0]?.meta?.changes && results[1]?.meta?.changes);
}

async function finalizePlanTransition(
  env: Bindings,
  job: JobRow,
  container: ContainerRow,
  completedAt: number,
): Promise<boolean> {
  const transition = await env.DB.prepare(
    `SELECT * FROM container_plan_transitions
     WHERE container_id = ? AND state = 'resizing'`,
  ).bind(container.id).first<{
    to_tier: ContainerRow["tier"];
    target_disk_gb: number;
    prior_status: "running" | "stopped";
    reserved_cpu: number;
    reserved_ram_mb: number;
    reserved_disk_gb: number;
  }>();
  if (!transition || !container.host_id) return false;

  const target = TIERS[transition.to_tier];
  const cpuAdjustment = cpuReservation(transition.to_tier) -
    cpuReservation(container.tier) - transition.reserved_cpu;
  const ramAdjustment = target.ramMb - container.ram_mb - transition.reserved_ram_mb;
  const diskAdjustment = transition.target_disk_gb * 2 -
    container.disk_gb * 2 - transition.reserved_disk_gb;
  const legacyPlacementClass = transition.to_tier === "free" ? "budget" : "regular";

  const results = (await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = 'succeeded', updated_at = ?
       WHERE id = ? AND status IN ('queued','running') AND ? = (
         SELECT id FROM jobs
         WHERE container_id = ?
           AND op IN ('provision','rebuild','start','stop','destroy','resize')
         ORDER BY rowid DESC LIMIT 1
       )`,
    ).bind(completedAt, job.id, job.id, container.id),
    env.DB.prepare(
      `UPDATE hosts
       SET vcpu_allocated = MAX(0, vcpu_allocated + ?),
           ram_allocated_mb = MAX(0, ram_allocated_mb + ?),
           disk_allocated_gb = MAX(0, disk_allocated_gb + ?)
       WHERE id = ? AND changes() = 1`,
    ).bind(cpuAdjustment, ramAdjustment, diskAdjustment, container.host_id),
    env.DB.prepare(
      `UPDATE containers
       SET tier = ?, placement_class = ?, placement_mode = 'shared',
           cpu = ?, ram_mb = ?, disk_gb = ?, status = ?, status_detail = NULL,
           storage_grandfathered = ?, last_upgraded_at = ?
       WHERE id = ? AND changes() = 1`,
    ).bind(
      transition.to_tier,
      legacyPlacementClass,
      target.cpu,
      target.ramMb,
      transition.target_disk_gb,
      transition.to_tier === "free" ? "stopped" : transition.prior_status,
      transition.to_tier === "free" && transition.target_disk_gb > TIERS.free.diskGb ? 1 : 0,
      completedAt,
      container.id,
    ),
    env.DB.prepare(
      `UPDATE container_plan_transitions
       SET state = 'complete', updated_at = ?, last_error_code = NULL
       WHERE container_id = ? AND state = 'resizing' AND changes() = 1`,
    ).bind(completedAt, container.id),
  ])) as Array<{ meta?: { changes?: number } }>;
  return Boolean(results[0]?.meta?.changes && results[3]?.meta?.changes);
}

/** Atomically claim destroy success, release accounting, and remove the row. */
async function finalizeDestroy(
  env: Bindings,
  job: JobRow,
  container: ContainerRow,
  completedAt: number,
): Promise<boolean> {
  const transition = await env.DB.prepare(
    `SELECT reserved_cpu, reserved_ram_mb, reserved_disk_gb
     FROM container_plan_transitions
     WHERE container_id = ? AND state <> 'complete'`,
  ).bind(container.id).first<{
    reserved_cpu: number;
    reserved_ram_mb: number;
    reserved_disk_gb: number;
  }>();
  const allocatedCpu = cpuReservation(container.tier) + (transition?.reserved_cpu ?? 0);
  const allocatedRamMb = container.ram_mb + (transition?.reserved_ram_mb ?? 0);
  const allocatedDiskGb = container.disk_gb * 2 + (transition?.reserved_disk_gb ?? 0);
  const latestActiveDestroy = `EXISTS (
    SELECT 1 FROM jobs j
    WHERE j.id = ? AND j.container_id = ? AND j.op = 'destroy'
      AND j.status IN ('queued','running')
      AND j.rowid = (
        SELECT MAX(rowid) FROM jobs
        WHERE container_id = ?
          AND op IN ('provision','rebuild','start','stop','destroy','resize')
      )
  )`;
  const gate = [job.id, container.id, container.id] as const;
  if (container.rehome_tier && container.rehome_placement_class) {
    const targetTier = TIERS[container.rehome_tier];
    const results = (await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO port_quarantine (host_id, port, released_at)
         SELECT host_id, ssh_port, ? FROM containers
         WHERE id = ? AND host_id IS NOT NULL AND ssh_port IS NOT NULL
           AND ${latestActiveDestroy}`,
      ).bind(completedAt, container.id, ...gate),
      env.DB.prepare(
        `UPDATE hosts
         SET vcpu_allocated = MAX(0, vcpu_allocated - ?),
             ram_allocated_mb = MAX(0, ram_allocated_mb - ?),
             disk_allocated_gb = MAX(0, disk_allocated_gb - ?),
             status = CASE
               WHEN host_type = 'dedicated' AND ? <> 'dedicated' THEN 'draining'
               ELSE status
             END,
             dedicated_user_id = CASE
               WHEN host_type = 'dedicated' AND ? <> 'dedicated' THEN NULL
               ELSE dedicated_user_id
             END
         WHERE id = ? AND EXISTS (SELECT 1 FROM containers WHERE id = ?)
           AND ${latestActiveDestroy}`,
      ).bind(
        allocatedCpu,
        allocatedRamMb,
        allocatedDiskGb,
        container.rehome_placement_class,
        container.rehome_placement_class,
        container.host_id,
        container.id,
        ...gate,
      ),
      env.DB.prepare(
        `UPDATE containers
         SET host_id = NULL, ssh_port = NULL, tier = ?, placement_class = ?,
             placement_mode = ?,
             cpu = ?, ram_mb = ?, disk_gb = ?, status = 'waitlisted',
             status_detail = 'plan change awaiting placement',
             host_key_fingerprints = NULL, rehome_tier = NULL,
             rehome_placement_class = NULL, rehome_requested_at = NULL
         WHERE id = ? AND ${latestActiveDestroy}`,
      ).bind(
        container.rehome_tier,
        container.rehome_placement_class,
        container.rehome_placement_class === "dedicated" ? "dedicated" : "shared",
        targetTier.cpu,
        targetTier.ramMb,
        targetTier.diskGb,
        container.id,
        ...gate,
      ),
      env.DB.prepare(
        `INSERT INTO waitlist (user_id, requested_at, admitted_at)
         SELECT ?, ?, NULL WHERE ${latestActiveDestroy}
         ON CONFLICT(user_id) DO UPDATE SET
           requested_at = excluded.requested_at, admitted_at = NULL`,
      ).bind(container.user_id, completedAt, ...gate),
      env.DB.prepare(
        `UPDATE jobs SET status = 'succeeded', updated_at = ?
         WHERE id = ? AND status IN ('queued','running') AND ? = (
           SELECT id FROM jobs
           WHERE container_id = ?
             AND op IN ('provision','rebuild','start','stop','destroy','resize')
           ORDER BY rowid DESC LIMIT 1
         )`,
      ).bind(completedAt, job.id, job.id, container.id),
    ])) as Array<{ meta: { changes?: number } }>;
    return Boolean(results.at(-1)?.meta.changes);
  }
  const results = (await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO port_quarantine (host_id, port, released_at)
       SELECT host_id, ssh_port, ? FROM containers
       WHERE id = ? AND host_id IS NOT NULL AND ssh_port IS NOT NULL
         AND ${latestActiveDestroy}`,
    ).bind(completedAt, container.id, ...gate),
    env.DB.prepare(
      `UPDATE hosts
       SET vcpu_allocated = MAX(0, vcpu_allocated - ?),
           ram_allocated_mb = MAX(0, ram_allocated_mb - ?),
           disk_allocated_gb = MAX(0, disk_allocated_gb - ?)
       WHERE id = ? AND EXISTS (SELECT 1 FROM containers WHERE id = ?)
         AND ${latestActiveDestroy}`,
    ).bind(
      allocatedCpu,
      allocatedRamMb,
      allocatedDiskGb,
      container.host_id,
      container.id,
      ...gate,
    ),
    env.DB.prepare(
      `DELETE FROM waitlist WHERE user_id = ? AND ${latestActiveDestroy}`,
    ).bind(container.user_id, ...gate),
    env.DB.prepare(
      `DELETE FROM containers WHERE id = ? AND ${latestActiveDestroy}`,
    ).bind(container.id, ...gate),
    env.DB.prepare(
      `UPDATE jobs SET status = 'succeeded', updated_at = ?
       WHERE id = ? AND status IN ('queued','running') AND ? = (
         SELECT id FROM jobs
         WHERE container_id = ?
           AND op IN ('provision','rebuild','start','stop','destroy','resize')
         ORDER BY rowid DESC LIMIT 1
       )`,
    ).bind(completedAt, job.id, job.id, container.id),
  ])) as Array<{ meta: { changes?: number } }>;
  return Boolean(results.at(-1)?.meta.changes);
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
    // A queued row is visible while its daemon submission is in flight. A 404
    // is only evidence of daemon loss after the submitter has advanced it to
    // running; otherwise the submitter owns this transition.
    const current = (await getJob(env, job.id)) ?? job;
    if (current.status === "queued") return current;
    await failJob(env, current, "job lost (host daemon restarted)");
    return (await getJob(env, job.id)) ?? current;
  }

  if (status.status === "succeeded") {
    // Dashboard polling and the cron reconciler may observe the same terminal
    // result concurrently. Claiming a state-changing result and all of its D1
    // side effects share one transaction.
    const completedAt = Date.now();
    if (job.op === "destroy") {
      const finalized = await finalizeDestroy(env, job, container, completedAt);
      if (!finalized) return (await getJob(env, job.id)) ?? job;
    } else if (job.op === "stop" && await env.DB.prepare(
      `SELECT 1 FROM container_plan_transitions
       WHERE container_id = ? AND to_tier = 'free' AND prior_status = 'running'
         AND state IN ('requested','waiting_capacity','failed_retryable')`,
    ).bind(container.id).first()) {
      const finalized = await finalizeDowngradeStop(env, job, container, completedAt);
      if (!finalized) return (await getJob(env, job.id)) ?? job;
    } else if (job.op === "resize" && await env.DB.prepare(
      `SELECT 1 FROM container_plan_transitions
       WHERE container_id = ? AND state = 'resizing'`,
    ).bind(container.id).first()) {
      const finalized = await finalizePlanTransition(env, job, container, completedAt);
      if (!finalized) return (await getJob(env, job.id)) ?? job;
    } else {
      const next = job.op === "stop" && container.suspension_reason === "billing"
        ? "suspended"
        : successStatusFor(job.op);
      let claimed: { meta: { changes?: number } };
      if (next) {
        const statements = [
          env.DB.prepare(
            "UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ? AND status IN ('queued','running')",
          ).bind(completedAt, job.id),
          env.DB.prepare(
            `UPDATE containers SET status = ?, status_detail = NULL,
               suspended_at = CASE WHEN ? = 'suspended' THEN ? ELSE suspended_at END
             WHERE id = ? AND changes() = 1 AND ? = (
               SELECT id FROM jobs
               WHERE container_id = ?
                 AND op IN ('provision','rebuild','start','stop','destroy','resize')
               ORDER BY rowid DESC LIMIT 1
             )`,
          ).bind(next, next, completedAt, container.id, job.id, container.id),
        ];
        const result = status.result as ProvisionResult | null;
        if (result?.hostKeyFingerprints?.length) {
          statements.push(
            env.DB.prepare(
              `UPDATE containers SET host_key_fingerprints = ?
               WHERE id = ? AND changes() = 1 AND ? = (
                 SELECT id FROM jobs
                 WHERE container_id = ?
                   AND op IN ('provision','rebuild','start','stop','destroy','resize')
                 ORDER BY rowid DESC LIMIT 1
               )`,
            ).bind(
              JSON.stringify(result.hostKeyFingerprints),
              container.id,
              job.id,
              container.id,
            ),
          );
        }
        const results = (await env.DB.batch(statements)) as Array<{
          meta: { changes?: number };
        }>;
        claimed = results[0] ?? { meta: {} };
      } else {
        claimed = await env.DB.prepare(
          "UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ? AND status IN ('queued','running')",
        )
          .bind(completedAt, job.id)
          .run();
      }
      if (!claimed.meta.changes) return (await getJob(env, job.id)) ?? job;
    }
  } else if (status.status === "failed") {
    await failJob(env, job, status.error ?? "job failed on host");
  } else {
    // A positive daemon heartbeat renews the lease. Long-but-healthy image or
    // agent work must not time out merely because it exceeds the original
    // dispatch timestamp.
    await env.DB.prepare(
      "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')",
    )
      .bind(status.status, Date.now(), job.id)
      .run();
  }

  return (await getJob(env, job.id)) ?? job;
}
