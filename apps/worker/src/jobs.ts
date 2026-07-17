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
import { allocatePort } from "./ports.js";
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
    "SELECT * FROM jobs WHERE container_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
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

function githubReposOf(container: ContainerRow): string[] {
  return JSON.parse(container.github_repos || "[]") as string[];
}

/** Home and disposable rootfs each receive the advertised disk cap. */
export function diskReservationGb(homeDiskGb: number): number {
  return homeDiskGb * 2;
}

/** Placement requires a recent positive daemon heartbeat. */
export const HOST_HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;
/** Repeated failures quarantine a host before admitting more tenants. */
export const HOST_FAILURE_THRESHOLD = 3;

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
  if (!host) return;
  await enqueueJob(env, op, container, host);
}

async function failJob(env: Bindings, job: Pick<JobRow, "id" | "container_id" | "op">, error: string) {
  const claimed = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', error = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued','running')`,
  )
    .bind(error, Date.now(), job.id)
    .run();
  if (claimed.meta.changes && LIFECYCLE_OPS.has(job.op)) {
    await env.DB.prepare("UPDATE containers SET status = 'error', status_detail = ? WHERE id = ?")
      .bind(error, job.container_id)
      .run();
  }
}

/** Destroy succeeded: free port + host accounting, drop the container row. */
async function finalizeDestroy(env: Bindings, container: ContainerRow): Promise<void> {
  const statements = [];
  if (container.host_id && container.ssh_port) {
    statements.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO port_quarantine (host_id, port, released_at) VALUES (?, ?, ?)",
      ).bind(container.host_id, container.ssh_port, Date.now()),
    );
  }
  if (container.host_id) {
    statements.push(
      env.DB.prepare(
        `UPDATE hosts
         SET vcpu_allocated = MAX(0, vcpu_allocated - ?),
             ram_allocated_mb = MAX(0, ram_allocated_mb - ?),
             disk_allocated_gb = MAX(0, disk_allocated_gb - ?)
         WHERE id = ?`,
      ).bind(
        container.cpu,
        container.ram_mb,
        diskReservationGb(container.disk_gb),
        container.host_id,
      ),
    );
  }
  statements.push(
    env.DB.prepare("DELETE FROM waitlist WHERE user_id = ?").bind(container.user_id),
  );
  statements.push(env.DB.prepare("DELETE FROM containers WHERE id = ?").bind(container.id));
  // D1 batch executes atomically: port quarantine, accounting, and row removal
  // cannot be partially applied.
  await env.DB.batch(statements);
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
    // Dashboard polling and the cron reconciler may observe the same terminal
    // result concurrently. Only the caller that wins this CAS may apply side
    // effects such as releasing host capacity after destroy.
    const claimed = await env.DB.prepare(
      "UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ? AND status IN ('queued','running')",
    )
      .bind(Date.now(), job.id)
      .run();
    if (!claimed.meta.changes) return (await getJob(env, job.id)) ?? job;
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
    const claimed = await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')",
    )
      .bind(status.error ?? "job failed on host", Date.now(), job.id)
      .run();
    if (claimed.meta.changes && LIFECYCLE_OPS.has(job.op)) {
      await env.DB.prepare("UPDATE containers SET status = 'error', status_detail = ? WHERE id = ?")
        .bind(status.error ?? "job failed on host", job.container_id)
        .run();
    }
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

// ---------------------------------------------------------------------------
// Placement + provisioning
// ---------------------------------------------------------------------------

/**
 * Scheduler (§10): place on the active host with the most unallocated
 * *non-reserved* RAM above the required headroom; check CPU, disk, and the
 * daemon heartbeat too. The final capacity check is repeated transactionally
 * by the caller so concurrent signups cannot race past a ceiling.
 */
export async function pickHost(
  env: Bindings,
  cpu: number,
  ramMb: number,
  diskGb: number,
  now: () => number = Date.now,
): Promise<HostRow | null> {
  return env.DB.prepare(
    `SELECT * FROM hosts
     WHERE status = 'active'
       AND vcpu_capacity - vcpu_allocated >= ?
       AND ram_total_mb - ram_reserve_mb - ram_allocated_mb >= ?
       AND disk_total_gb - disk_allocated_gb >= ?
       AND last_seen_at IS NOT NULL AND last_seen_at >= ?
       AND consecutive_failures = 0
     ORDER BY ram_total_mb - ram_reserve_mb - ram_allocated_mb DESC,
              vcpu_capacity - vcpu_allocated DESC,
              id
     LIMIT 1`,
  )
    .bind(
      cpu,
      ramMb,
      diskGb,
      now() - HOST_HEARTBEAT_MAX_AGE_MS,
    )
    .first<HostRow>();
}

export interface ProvisionInput {
  agents: Agent[];
  githubRepos?: string[];
}

/**
 * Create the container row and dispatch the provision job. Returns the
 * container in `provisioning` state, or `waitlisted` when no host has
 * capacity (§10: the reconciler admits the FIFO waitlist when capacity returns).
 */
export async function startProvision(
  env: Bindings,
  user: UserRow,
  input: ProvisionInput,
): Promise<ContainerRow> {
  const tier = TIERS.free;
  const containerId = crypto.randomUUID();
  const now = Date.now();
  const agents = JSON.stringify(input.agents);
  const githubRepos = JSON.stringify(input.githubRepos ?? []);
  const reservedDiskGb = diskReservationGb(tier.diskGb);

  // D1 batches are transactional. Capacity is checked in the INSERT itself,
  // then `changes()` gates host accounting on that INSERT winning. This avoids
  // oversubscription when two signups race for the last slot. A unique-port
  // collision rolls the batch back and is retried with a fresh allocation.
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = await pickHost(env, tier.cpu, tier.ramMb, reservedDiskGb);
    if (!host) break;
    const port = await allocatePort(env, host.id);
    const heartbeatCutoff = Date.now() - HOST_HEARTBEAT_MAX_AGE_MS;
    try {
      const results = (await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO containers
             (id, user_id, host_id, ssh_port, agents, github_repos, tier, cpu, ram_mb, disk_gb, status, created_at)
           SELECT ?, ?, h.id, ?, ?, ?, 'free', ?, ?, ?, 'provisioning', ?
           FROM hosts h
           WHERE h.id = ? AND h.status = 'active'
             AND h.vcpu_capacity - h.vcpu_allocated >= ?
             AND h.ram_total_mb - h.ram_reserve_mb - h.ram_allocated_mb >= ?
             AND h.disk_total_gb - h.disk_allocated_gb >= ?
             AND h.last_seen_at IS NOT NULL AND h.last_seen_at >= ?
             AND h.consecutive_failures = 0`,
        ).bind(
          containerId,
          user.id,
          port,
          agents,
          githubRepos,
          tier.cpu,
          tier.ramMb,
          tier.diskGb,
          now,
          host.id,
          tier.cpu,
          tier.ramMb,
          reservedDiskGb,
          heartbeatCutoff,
        ),
        env.DB.prepare(
          `UPDATE hosts
           SET vcpu_allocated = vcpu_allocated + ?,
               ram_allocated_mb = ram_allocated_mb + ?,
               disk_allocated_gb = disk_allocated_gb + ?
           WHERE id = ? AND changes() = 1`,
        ).bind(tier.cpu, tier.ramMb, reservedDiskGb, host.id),
      ])) as Array<{ meta?: { changes?: number } }>;

      if (!results[0]?.meta?.changes) continue;
      const container = await getContainerForUser(env, user.id);
      if (!container) throw new Error("container row vanished");
      await enqueueJob(env, "provision", container, host);
      return (await getContainerForUser(env, user.id)) ?? container;
    } catch (error) {
      // A duplicate request for the same account is idempotent. Otherwise a
      // concurrent port allocation may have won; retry from fresh DB state.
      const existing = await getContainerForUser(env, user.id);
      if (existing) return existing;
      if (attempt === 3) throw error;
    }
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO containers (id, user_id, agents, github_repos, tier, cpu, ram_mb, disk_gb, status, created_at)
         VALUES (?, ?, ?, ?, 'free', ?, ?, ?, 'waitlisted', ?)`,
      ).bind(containerId, user.id, agents, githubRepos, tier.cpu, tier.ramMb, tier.diskGb, now),
      env.DB.prepare(
        `INSERT INTO waitlist (user_id, requested_at, admitted_at) VALUES (?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET requested_at = excluded.requested_at, admitted_at = NULL`,
      ).bind(user.id, now),
    ]);
  } catch (error) {
    const existing = await getContainerForUser(env, user.id);
    if (existing) return existing;
    throw error;
  }
  const row = await getContainerForUser(env, user.id);
  if (!row) throw new Error("container row vanished");
  return row;
}
