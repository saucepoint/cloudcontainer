/**
 * Workers Cron reconciler (§10): every time-based or corrective transition
 * runs here so no state depends on a user or webhook happening to arrive.
 * Clock is injected for tests ("time never passes in tests", §18).
 */
import { decryptJsonAtRest } from "@codestation/contract";
import { daemonStats } from "./daemon.js";
import {
  exchangeGithubTokens,
  githubConfigured,
  pushCredentialsToContainer,
  storeGithubTokens,
} from "./github.js";
import { enqueueJob, getHost, refreshJob } from "./jobs.js";
import type { Bindings, ContainerRow, CredentialsRow, HostRow, JobRow } from "./types.js";

export const STUCK_JOB_MS = 15 * 60 * 1000;
export const GRACE_DAYS = 7;
export const GITHUB_REFRESH_LEAD_MS = 60 * 60 * 1000;

export async function reconcile(env: Bindings, now: () => number = Date.now): Promise<void> {
  await Promise.allSettled([
    sweepJobs(env, now),
    timeoutStuckJobs(env, now),
    refreshGithubTokens(env, now),
    expireSuspendedContainers(env, now),
    correctDrift(env),
    cleanupExpiredRows(env, now),
  ]);
}

/** Poll the daemon for jobs still marked queued/running (dashboard may not be polling). */
async function sweepJobs(env: Bindings, now: () => number): Promise<void> {
  const jobs = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status IN ('queued','running') AND updated_at > ? LIMIT 50",
  )
    .bind(now() - STUCK_JOB_MS)
    .all<JobRow>();
  for (const job of jobs.results) {
    await refreshJob(env, job);
  }
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
    await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error = 'timed out', updated_at = ? WHERE id = ?",
    )
      .bind(now(), job.id)
      .run();
    await env.DB.prepare(
      `UPDATE containers SET status = 'error', status_detail = 'operation timed out'
       WHERE id = ? AND status IN ('provisioning','destroying')`,
    )
      .bind(job.container_id)
      .run();
    console.log(JSON.stringify({ event: "job_timed_out", jobId: job.id, op: job.op }));
  }
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

  for (const row of rows.results) {
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
  }
}

/** Suspended + 7 days -> destroy (billing suspension is out of scope without Stripe, but the reconciler rule stays). */
async function expireSuspendedContainers(env: Bindings, now: () => number): Promise<void> {
  const cutoff = now() - GRACE_DAYS * 24 * 3600 * 1000;
  const expired = await env.DB.prepare(
    "SELECT * FROM containers WHERE status = 'suspended' AND suspended_at IS NOT NULL AND suspended_at <= ?",
  )
    .bind(cutoff)
    .all<ContainerRow>();
  for (const container of expired.results) {
    if (!container.host_id) continue;
    const host = await getHost(env, container.host_id);
    if (!host) continue;
    await enqueueJob(env, "destroy", container, host);
  }
}

/** D1 <-> host drift detection via daemon `stats` (§10). */
async function correctDrift(env: Bindings): Promise<void> {
  const hosts = await env.DB.prepare("SELECT * FROM hosts WHERE status = 'active'").all<HostRow>();
  for (const host of hosts.results) {
    let stats;
    try {
      stats = await daemonStats(env, host);
    } catch {
      continue; // unreachable host: containers keep their last known state
    }
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
  }
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
