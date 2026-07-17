/**
 * Workers Cron reconciler (§10): every time-based or corrective transition
 * runs here so no state depends on a user or webhook happening to arrive.
 * Clock is injected for tests ("time never passes in tests", §18).
 */
import { decryptJsonAtRest } from "@codestation/contract";
import { daemonStats } from "./daemon.js";
import {
  diskReservationGb,
  HOST_FAILURE_THRESHOLD,
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
  refreshJob,
} from "./jobs.js";
import { allocatePort } from "./ports.js";
import type { Bindings, ContainerRow, CredentialsRow, HostRow, JobRow } from "./types.js";

export const STUCK_JOB_MS = 15 * 60 * 1000;
export const GRACE_DAYS = 7;
const GITHUB_REFRESH_LEAD_MS = 60 * 60 * 1000;

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
    console.log(
      JSON.stringify({ event: "reconcile_task_failed", task: "host_health", error: String(error) }),
    );
  }

  const tasks = [
    ["sweep_jobs", sweepJobs(env, now)],
    ["timeout_jobs", timeoutStuckJobs(env, now)],
    ["github_refresh", refreshGithubTokens(env, now)],
    ["grace_expiry", expireSuspendedContainers(env, now)],
    ["waitlist_admission", admitWaitlistedContainers(env, now)],
    ["expired_row_cleanup", cleanupExpiredRows(env, now)],
  ] as const;
  const results = await Promise.allSettled(tasks.map(([, task]) => task));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.log(
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

/** Stuck jobs time out to failed; lifecycle containers drop to `error` (§12 convergence). */
async function timeoutStuckJobs(env: Bindings, now: () => number): Promise<void> {
  const cutoff = now() - STUCK_JOB_MS;
  const stuck = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status IN ('queued','running') AND updated_at <= ? LIMIT 50",
  )
    .bind(cutoff)
    .all<JobRow>();
  for (const job of stuck.results) {
    const claimed = await env.DB.prepare(
      `UPDATE jobs SET status = 'failed', error = 'timed out', updated_at = ?
       WHERE id = ? AND status IN ('queued','running') AND updated_at <= ?`,
    )
      .bind(now(), job.id, cutoff)
      .run();
    if (!claimed.meta.changes) continue;
    await env.DB.prepare(
      `UPDATE containers SET status = 'error', status_detail = 'operation timed out'
       WHERE id = ? AND status IN ('provisioning','destroying')`,
    )
      .bind(job.container_id)
      .run();
    console.log(JSON.stringify({ event: "job_timed_out", jobId: job.id, op: job.op }));
  }
}

/** FIFO admission when host capacity returns. Placement re-checks capacity. */
async function admitWaitlistedContainers(env: Bindings, now: () => number): Promise<void> {
  const waiting = await env.DB.prepare(
    `SELECT c.* FROM containers c
     JOIN waitlist w ON w.user_id = c.user_id
     WHERE c.status = 'waitlisted' AND c.host_id IS NULL AND w.admitted_at IS NULL
     ORDER BY w.requested_at, c.created_at, c.user_id
     LIMIT 20`,
  ).all<ContainerRow>();

  for (const container of waiting.results) {
    const host = await pickHost(
      env,
      container.cpu,
      container.ram_mb,
      diskReservationGb(container.disk_gb),
      now,
    );
    if (!host) break;
    const admitted = await placeWaitlistedContainer(env, container, host, now());
    if (admitted) await enqueueJob(env, "provision", admitted, host);
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
             AND h.vcpu_capacity - h.vcpu_allocated >= containers.cpu
             AND h.ram_total_mb - h.ram_reserve_mb - h.ram_allocated_mb >= containers.ram_mb
             AND h.disk_total_gb - h.disk_allocated_gb >= containers.disk_gb * 2
             AND h.last_seen_at IS NOT NULL AND h.last_seen_at >= ?
             AND h.consecutive_failures = 0
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
      container.cpu,
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
      console.log(
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
    "SELECT * FROM hosts WHERE status IN ('active','unhealthy')",
  ).all<HostRow>();
  await runBounded(hosts.results, 3, async (host) => {
    let stats;
    try {
      stats = await daemonStats(env, host);
    } catch {
      await env.DB.prepare(
        `UPDATE hosts
         SET consecutive_failures = consecutive_failures + 1,
             status = CASE
               WHEN status = 'active' AND consecutive_failures + 1 >= ? THEN 'unhealthy'
               ELSE status
             END
         WHERE id = ? AND status IN ('active','unhealthy')`,
      )
        .bind(HOST_FAILURE_THRESHOLD, host.id)
        .run();
      return; // containers keep their last known state
    }
    await env.DB.prepare(
      `UPDATE hosts
       SET last_seen_at = ?, consecutive_failures = 0,
           status = CASE WHEN status = 'unhealthy' THEN 'active' ELSE status END
       WHERE id = ? AND status IN ('active','unhealthy')`,
    )
      .bind(now(), host.id)
      .run();
    const actual = new Map(stats.containers.map((s) => [s.containerId, s.incusStatus]));
    const rows = await env.DB.prepare(
      "SELECT * FROM containers WHERE host_id = ? AND status IN ('running','stopped')",
    )
      .bind(host.id)
      .all<ContainerRow>();
    for (const row of rows.results) {
      const incus = actual.get(row.id);
      if (!incus) continue;
      const expected = row.status === "running" ? "Running" : "Stopped";
      if (incus !== expected && (incus === "Running" || incus === "Stopped")) {
        const corrected = incus === "Running" ? "running" : "stopped";
        await env.DB.prepare("UPDATE containers SET status = ? WHERE id = ?")
          .bind(corrected, row.id)
          .run();
        console.log(
          JSON.stringify({ event: "drift_corrected", containerId: row.id, from: row.status, to: corrected }),
        );
      }
    }
  });
}

async function cleanupExpiredRows(env: Bindings, now: () => number): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(t),
    env.DB.prepare("DELETE FROM enrollment_tokens WHERE expires_at < ?").bind(t - 24 * 3600 * 1000),
    env.DB.prepare("DELETE FROM session_revocations WHERE revoked_at < ?").bind(
      t - 30 * 24 * 3600 * 1000,
    ),
  ]);
}
