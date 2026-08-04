/**
 * Workers Cron reconciler (§10): every time-based or corrective transition
 * runs here so no state depends on a user or webhook happening to arrive.
 * Clock is injected for tests ("time never passes in tests", §18).
 */
import {
  decryptJsonAtRest,
  HOST_RAM_OVERCOMMIT_DENOMINATOR,
  HOST_RAM_OVERCOMMIT_NUMERATOR,
  HOST_TYPES,
} from "@workbench/contract";
import { daemonStats } from "./daemon.js";
import {
  cpuReservation,
  diskReservationGb,
  HOST_HEARTBEAT_MAX_AGE_MS,
  pickHost,
} from "./capacity.js";
import {
  exchangeGithubTokens,
  githubConfigured,
  pushCredentialsToContainer,
  storeGithubTokens,
} from "./github.js";
import {
  enqueueJob,
  getHost,
  HostJobAdmissionError,
  refreshJob,
} from "./jobs.js";
import { recordHostFailure, recordHostStats } from "./host-health.js";
import { allocatePort, NoFreePortsError } from "./ports.js";
import { LIFECYCLE_OPS } from "./state.js";
import type { Bindings, ContainerRow, CredentialsRow, HostRow, JobRow } from "./types.js";

export const STUCK_JOB_MS = 15 * 60 * 1000;
export const GRACE_DAYS = 7;
const GITHUB_REFRESH_LEAD_MS = 60 * 60 * 1000;
const BACKGROUND_RETRY_MS = 60 * 60 * 1000;

type DriftSnapshot = ContainerRow & { lifecycle_version: number };

/** Run I/O work in parallel without opening an unbounded number of host calls. */
async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        if (item === undefined) continue;
        try {
          await task(item);
        } catch (error) {
          firstError ??= error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstError) throw firstError;
}

export async function reconcile(env: Bindings, now: () => number = Date.now): Promise<void> {
  // Refresh host eligibility before waitlist admission. A stale or repeatedly
  // failing daemon must not receive another tenant in the same cron pass.
  try {
    await correctDrift(env, now);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "reconcile_task_failed", task: "host_health", error: String(error) }),
    );
  }

  const tasks = [
    ["sweep_jobs", sweepJobs(env, now)],
    ["retry_background_jobs", retryFailedBackgroundJobs(env, now)],
    ["timeout_jobs", timeoutStuckJobs(env, now)],
    ["github_refresh", refreshGithubTokens(env, now)],
    ["grace_expiry", expireSuspendedContainers(env, now)],
    ["waitlist_admission", admitWaitlistedContainers(env, now)],
    ["expired_row_cleanup", cleanupExpiredRows(env, now)],
  ] as const;
  const results = await Promise.allSettled(tasks.map(([, task]) => task));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(
        JSON.stringify({
          event: "reconcile_task_failed",
          task: tasks[index]?.[0] ?? "unknown",
          error: String(result.reason),
        }),
      );
    }
  });
}

/** Poll the daemon for jobs still marked queued/running (dashboard may not be polling). */
async function sweepJobs(env: Bindings, now: () => number): Promise<void> {
  const jobs = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status IN ('queued','running') AND updated_at > ? LIMIT 50",
  )
    .bind(now() - STUCK_JOB_MS)
    .all<JobRow>();
  await runBounded(jobs.results, 5, async (job) => {
    await refreshJob(env, job);
  });
}

/** Retry the latest failed desired-state sync with an hourly backoff. */
async function retryFailedBackgroundJobs(env: Bindings, now: () => number): Promise<void> {
  const cutoff = now() - BACKGROUND_RETRY_MS;
  const failed = await env.DB.prepare(
    `SELECT j.* FROM jobs j
     JOIN containers c ON c.id = j.container_id
     WHERE c.status = 'running' AND j.status = 'failed'
       AND j.op IN ('sync-keys','refresh-credentials')
       AND j.updated_at <= ?
       AND j.rowid = (
         SELECT MAX(newer.rowid) FROM jobs newer
         WHERE newer.container_id = j.container_id AND newer.op = j.op
       )
     LIMIT 20`,
  )
    .bind(cutoff)
    .all<JobRow>();
  await runBounded(failed.results, 4, async (job) => {
    const claimed = await env.DB.prepare(
      `UPDATE jobs SET updated_at = ?
       WHERE id = ? AND status = 'failed' AND updated_at <= ?
         AND rowid = (
           SELECT MAX(newer.rowid) FROM jobs newer
           WHERE newer.container_id = jobs.container_id AND newer.op = jobs.op
         )`,
    )
      .bind(now(), job.id, cutoff)
      .run();
    if (!claimed.meta.changes) return;
    const container = await env.DB.prepare("SELECT * FROM containers WHERE id = ? AND status = 'running'")
      .bind(job.container_id)
      .first<ContainerRow>();
    if (!container?.host_id) return;
    const host = await getHost(env, container.host_id);
    if (!host) return;
    await enqueueJob(env, job.op, container, host);
  });
}

/** Stuck jobs time out to failed; lifecycle containers drop to `error` (§12 convergence). */
async function timeoutStuckJobs(env: Bindings, now: () => number): Promise<void> {
  const cutoff = now() - STUCK_JOB_MS;
  const stuck = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status IN ('queued','running') AND updated_at <= ? LIMIT 50",
  )
    .bind(cutoff)
    .all<JobRow>();
  for (const job of stuck.results) {
    const claim = env.DB.prepare(
      `UPDATE jobs SET status = 'failed', error = 'timed out', updated_at = ?
       WHERE id = ? AND status IN ('queued','running') AND updated_at <= ?`,
    ).bind(now(), job.id, cutoff);
    let claimed: { meta: { changes?: number } };
    if (LIFECYCLE_OPS.has(job.op)) {
      const results = (await env.DB.batch([
        claim,
        env.DB.prepare(
          `UPDATE containers SET status = 'error', status_detail = 'operation timed out'
           WHERE id = ? AND changes() = 1 AND ? = (
             SELECT id FROM jobs
             WHERE container_id = ?
               AND op IN ('provision','rebuild','start','stop','destroy','resize')
             ORDER BY rowid DESC LIMIT 1
           )`,
        ).bind(job.container_id, job.id, job.container_id),
      ])) as Array<{ meta: { changes?: number } }>;
      claimed = results[0] ?? { meta: {} };
    } else {
      claimed = await claim.run();
    }
    if (!claimed.meta.changes) continue;
    console.warn(JSON.stringify({ event: "job_timed_out", jobId: job.id, op: job.op }));
  }
}

/** FIFO admission when host capacity returns. Placement re-checks capacity. */
async function admitWaitlistedContainers(env: Bindings, now: () => number): Promise<void> {
  // Bound work per class instead of globally. Otherwise twenty older free
  // entries could hide a paid entry from this Cron pass even though the pools
  // have independent capacity.
  const waitingByClass = await Promise.all(HOST_TYPES.map((hostType) =>
    env.DB.prepare(
      `SELECT c.* FROM containers c
       JOIN waitlist w ON w.user_id = c.user_id
       WHERE c.status = 'waitlisted' AND c.host_id IS NULL
         AND c.placement_class = ? AND w.admitted_at IS NULL
       ORDER BY w.requested_at, c.created_at, c.user_id
       LIMIT 20`,
    )
      .bind(hostType)
      .all<ContainerRow>()));
  const waiting = waitingByClass.flatMap((result) => result.results);

  // Capacity pools are independent. A full budget pool must not block a paid
  // regular account that appears later in the global FIFO list. Dedicated
  // hosts are account-bound, so each assigned account is its own pool.
  const blockedPlacementClasses = new Set<string>();
  for (const container of waiting) {
    const placementPool = container.placement_class === "dedicated"
      ? `dedicated:${container.user_id}`
      : container.placement_class;
    if (blockedPlacementClasses.has(placementPool)) continue;
    const hostsWithoutPorts: string[] = [];
    while (true) {
      const host = await pickHost(
        env,
        {
          userId: container.user_id,
          hostType: container.placement_class,
          cpu: cpuReservation(container.tier),
          ramMb: container.ram_mb,
          diskGb: diskReservationGb(container.disk_gb),
        },
        now,
        hostsWithoutPorts,
      );
      if (!host) {
        blockedPlacementClasses.add(placementPool);
        break;
      }
      let admitted: ContainerRow | null;
      try {
        admitted = await placeWaitlistedContainer(env, container, host, now());
      } catch (error) {
        if (!(error instanceof NoFreePortsError)) throw error;
        hostsWithoutPorts.push(host.id);
        continue;
      }
      if (!admitted) {
        blockedPlacementClasses.add(placementPool);
        break;
      }
      try {
        await enqueueJob(env, "provision", admitted, host);
      } catch (error) {
        const statusDetail = error instanceof HostJobAdmissionError
          ? "host entered maintenance before provisioning could be queued"
          : "provisioning could not be queued";
        await env.DB.prepare(
          "UPDATE containers SET status = 'error', status_detail = ? WHERE id = ?",
        )
          .bind(statusDetail, admitted.id)
          .run();
        console.error(JSON.stringify({
          event: "waitlist_dispatch_failed",
          containerId: admitted.id,
          hostId: host.id,
          error: error instanceof Error ? error.message : "job dispatch failed",
        }));
        blockedPlacementClasses.add(placementPool);
      }
      break;
    }
  }
}

async function placeWaitlistedContainer(
  env: Bindings,
  container: ContainerRow,
  host: HostRow,
  admittedAt: number,
): Promise<ContainerRow | null> {
  // Port allocation and capacity reservation are rechecked inside this D1
  // transaction. `changes()` gates accounting on winning the waitlisted-row
  // claim, so overlapping cron invocations cannot double-reserve capacity.
  const port = await allocatePort(env, host.id, admittedAt);
  const heartbeatCutoff = admittedAt - HOST_HEARTBEAT_MAX_AGE_MS;
  const results = (await env.DB.batch([
    env.DB.prepare(
      `UPDATE containers
       SET host_id = ?, ssh_port = ?, status = 'provisioning', status_detail = NULL
       WHERE id = ? AND status = 'waitlisted' AND host_id IS NULL
         AND EXISTS (
           SELECT 1 FROM hosts h
           WHERE h.id = ? AND h.status = 'active'
             AND h.host_type = containers.placement_class
             AND (h.host_type <> 'dedicated' OR h.dedicated_user_id = containers.user_id)
             AND h.max_tenants > (
               SELECT COUNT(*) FROM containers assigned WHERE assigned.host_id = h.id
             )
             AND h.vcpu_allocated + CASE containers.tier
               WHEN 'free' THEN 1 WHEN 'paid' THEN 3 ELSE 2147483647 END <=
               ((h.vcpu_capacity + CASE containers.tier
                 WHEN 'free' THEN 1 WHEN 'paid' THEN 3 ELSE 2147483647 END - 1)
                / CASE containers.tier
                    WHEN 'free' THEN 1 WHEN 'paid' THEN 3 ELSE 2147483647 END)
               * CASE containers.tier
                   WHEN 'free' THEN 1 WHEN 'paid' THEN 3 ELSE 2147483647 END
             AND h.ram_allocated_mb + containers.ram_mb <=
               (((h.ram_total_mb - h.ram_reserve_mb) * ${HOST_RAM_OVERCOMMIT_NUMERATOR}
                 + (${HOST_RAM_OVERCOMMIT_DENOMINATOR} * containers.ram_mb) - 1)
                / (${HOST_RAM_OVERCOMMIT_DENOMINATOR} * containers.ram_mb)) * containers.ram_mb
             AND h.disk_total_gb - h.disk_allocated_gb >= containers.disk_gb * 2
             AND h.last_seen_at IS NOT NULL AND h.last_seen_at >= ?
             AND h.consecutive_failures = 0
             AND h.daemon_version IS NOT NULL
             AND h.reported_ram_total_mb IS NOT NULL
             AND h.reported_cpu_logical IS NOT NULL
         )`,
    ).bind(
      host.id,
      port,
      container.id,
      host.id,
      heartbeatCutoff,
    ),
    env.DB.prepare(
      `UPDATE hosts
       SET vcpu_allocated = vcpu_allocated + ?,
           ram_allocated_mb = ram_allocated_mb + ?,
           disk_allocated_gb = disk_allocated_gb + ?
       WHERE id = ? AND changes() = 1`,
    ).bind(
      cpuReservation(container.tier),
      container.ram_mb,
      diskReservationGb(container.disk_gb),
      host.id,
    ),
    env.DB.prepare(
      "UPDATE waitlist SET admitted_at = ? WHERE user_id = ? AND changes() = 1",
    ).bind(admittedAt, container.user_id),
  ])) as Array<{ meta?: { changes?: number } }>;
  if (!results[0]?.meta?.changes) return null;
  return env.DB.prepare("SELECT * FROM containers WHERE id = ?")
    .bind(container.id)
    .first<ContainerRow>();
}

/** Control-plane-side GitHub token refresh loop (§9): the refresh token never leaves D1. */
async function refreshGithubTokens(env: Bindings, now: () => number): Promise<void> {
  if (!githubConfigured(env)) return;
  const rows = await env.DB.prepare(
    `SELECT * FROM credentials_encrypted
     WHERE github_refresh_token IS NOT NULL AND github_expires_at IS NOT NULL AND github_expires_at <= ?
     LIMIT 20`,
  )
    .bind(now() + GITHUB_REFRESH_LEAD_MS)
    .all<CredentialsRow>();

  await runBounded(rows.results, 4, async (row) => {
    try {
      const refreshToken = decryptJsonAtRest<string>(
        row.github_refresh_token as string,
        env.CREDENTIAL_MASTER_KEY,
      );
      const tokens = await exchangeGithubTokens(env, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      if (tokens.error || !tokens.access_token) {
        throw new Error(`refresh exchange failed: ${tokens.error ?? "no access_token"}`);
      }
      await storeGithubTokens(env, row.user_id, tokens);
      await pushCredentialsToContainer(env, row.user_id);
    } catch (err) {
      // Credential kind only — never values (§10 secrets hygiene).
      console.error(
        JSON.stringify({ event: "github_token_refresh_failed", userId: row.user_id, error: String(err) }),
      );
    }
  });
}

/** Suspended + 7 days -> destroy (billing suspension is out of scope without Stripe, but the reconciler rule stays). */
async function expireSuspendedContainers(env: Bindings, now: () => number): Promise<void> {
  const cutoff = now() - GRACE_DAYS * 24 * 3600 * 1000;
  const expired = await env.DB.prepare(
    "SELECT * FROM containers WHERE status = 'suspended' AND suspended_at IS NOT NULL AND suspended_at <= ?",
  )
    .bind(cutoff)
    .all<ContainerRow>();
  await runBounded(expired.results, 5, async (container) => {
    if (!container.host_id) return;
    const host = await getHost(env, container.host_id);
    if (!host) return;
    await enqueueJob(env, "destroy", container, host);
  });
}

/** D1 <-> host drift detection via daemon `stats` (§10). */
async function correctDrift(env: Bindings, now: () => number): Promise<void> {
  const hosts = await env.DB.prepare(
    "SELECT * FROM hosts WHERE status IN ('active','draining','unhealthy')",
  ).all<HostRow>();
  await runBounded(hosts.results, 3, async (host) => {
    // Snapshot rows and their monotonic lifecycle version before host I/O.
    // State completed while stats are in flight must not be reconciled against
    // that older host snapshot.
    const rows = await env.DB.prepare(
      `SELECT c.*,
         COALESCE((
           SELECT MAX(j.rowid) FROM jobs j
           WHERE j.container_id = c.id
             AND j.op IN ('provision','rebuild','start','stop','destroy','resize')
         ), 0) AS lifecycle_version
       FROM containers c
       WHERE c.host_id = ?
         AND c.status IN ('running','stopped','provisioning','error')`,
    )
      .bind(host.id)
      .all<DriftSnapshot>();
    let stats;
    try {
      stats = await daemonStats(env, host);
    } catch {
      await recordHostFailure(env, host.id);
      return; // containers keep their last known state
    }
    await recordHostStats(env, host.id, stats, now());
    const actual = new Map(stats.containers.map((s) => [s.containerId, s.incusStatus]));
    // Rows with host capacity allocated: running/stopped must exist on the host;
    // provisioning rows may not yet have a container (job still in progress).
    for (const row of rows.results) {
      const incus = actual.get(row.id);
      if (!incus) {
        // Container in D1 but not on the host. For running/stopped rows this
        // means the container was deleted outside the control plane (e.g.
        // manual incus delete). Mark it as error but preserve its reservation:
        // retry reuses that allocation and destroy releases it exactly once.
        // provisioning/error rows may legitimately not have an incus container
        // yet (job in flight / failed provision).
        if (row.status === "running" || row.status === "stopped") {
          const applied = await env.DB.prepare(
            `UPDATE containers
             SET status = 'error', status_detail = 'container missing on host'
             WHERE id = ? AND host_id = ? AND status = ?
               AND ? = COALESCE((
                 SELECT MAX(rowid) FROM jobs
                 WHERE container_id = containers.id
                   AND op IN ('provision','rebuild','start','stop','destroy','resize')
               ), 0)
               AND NOT EXISTS (
                 SELECT 1 FROM jobs
                 WHERE container_id = containers.id AND status IN ('queued','running')
                   AND op IN ('provision','rebuild','start','stop','destroy','resize')
               )`,
          )
            .bind(row.id, host.id, row.status, row.lifecycle_version)
            .run();
          if (applied.meta.changes) {
            console.error(
              JSON.stringify({
                event: "container_missing_on_host",
                containerId: row.id,
                hostId: host.id,
                previousStatus: row.status,
              }),
            );
          }
        }
        continue;
      }
      if (row.status !== "running" && row.status !== "stopped") continue;
      const expected = row.status === "running" ? "Running" : "Stopped";
      if (incus !== expected && (incus === "Running" || incus === "Stopped")) {
        const corrected = incus === "Running" ? "running" : "stopped";
        const applied = await env.DB.prepare(
          `UPDATE containers SET status = ?
           WHERE id = ? AND host_id = ? AND status = ?
             AND ? = COALESCE((
               SELECT MAX(rowid) FROM jobs
               WHERE container_id = containers.id
                 AND op IN ('provision','rebuild','start','stop','destroy','resize')
             ), 0)
             AND NOT EXISTS (
               SELECT 1 FROM jobs
               WHERE container_id = containers.id AND status IN ('queued','running')
                 AND op IN ('provision','rebuild','start','stop','destroy','resize')
             )`,
        )
          .bind(corrected, row.id, host.id, row.status, row.lifecycle_version)
          .run();
        if (applied.meta.changes) {
          console.log(
            JSON.stringify({ event: "drift_corrected", containerId: row.id, from: row.status, to: corrected }),
          );
        }
      }
    }
  });
}

async function cleanupExpiredRows(env: Bindings, now: () => number): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM cli_auth_codes WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM cli_auth_attempts WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM enrollment_tokens WHERE expires_at < ?").bind(t - 24 * 3600 * 1000),
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM auth_verifications WHERE expires_at < ?").bind(t),
  ]);
}
