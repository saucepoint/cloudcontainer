/**
 * In-memory async job registry. Jobs are executed sequentially per container
 * (an op must not race another op on the same container). State is lost on
 * daemon restart; the control-plane reconciler times such jobs out to `error`
 * with a working retry — never a stuck spinner.
 */
import type { JobRequest, JobStatus, ProvisionResult } from "@workbench/contract";
import type { Provisioner } from "./provisioner.js";

export interface JobRecord {
  jobId: string;
  containerId: string;
  op: JobRequest["op"];
  status: JobStatus;
  error: string | null;
  result: ProvisionResult | null;
}

export class JobConflictError extends Error {}

export class JobRunner {
  private jobs = new Map<string, JobRecord>();
  private chains = new Map<string, Promise<void>>();
  /** Highest applied snapshot revision per `containerId:op` watermark. */
  private revisions = new Map<string, number>();

  constructor(private provisioner: Provisioner) {}

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /** Number of containers with running or queued work (exposed for health/tests). */
  pendingContainerCount(): number {
    return this.chains.size;
  }

  /** Accept and start a job; returns immediately (the daemon replies 202). */
  submit(request: JobRequest): JobRecord {
    const existing = this.jobs.get(request.jobId);
    if (existing) {
      if (existing.containerId !== request.containerId || existing.op !== request.op) {
        throw new JobConflictError("job id already belongs to a different operation");
      }
      return existing; // idempotent re-delivery
    }

    const record: JobRecord = {
      jobId: request.jobId,
      containerId: request.containerId,
      op: request.op,
      status: "queued",
      error: null,
      result: null,
    };
    this.jobs.set(request.jobId, record);

    const revision =
      "revision" in request && typeof request.revision === "number"
        ? request.revision
        : undefined;
    const watermarkKey = `${request.containerId}:${request.op}`;
    const prev = this.chains.get(request.containerId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        record.status = "running";
        // A snapshot that was overtaken before it even ran must not overwrite
        // newer desired state. Desired state is already converged (or will be
        // reconverged by the control plane retrying the newer job), so the
        // job is a success from the control plane's perspective.
        if (revision !== undefined && revision <= (this.revisions.get(watermarkKey) ?? 0)) {
          record.status = "succeeded";
          console.log(
            JSON.stringify({
              event: "job_skipped_stale",
              jobId: record.jobId,
              op: record.op,
              revision,
            }),
          );
          this.gc();
          return;
        }
        // Claim the watermark before running: even if this snapshot fails,
        // an older one queued behind it must never be applied over it. The
        // control plane retries the failed latest job with a fresh snapshot.
        if (revision !== undefined) {
          this.revisions.set(
            watermarkKey,
            Math.max(revision, this.revisions.get(watermarkKey) ?? 0),
          );
        }
        try {
          record.result = await this.provisioner.run(request);
          record.status = "succeeded";
          if (request.op === "destroy") this.pruneRevisions(request.containerId);
        } catch (err) {
          record.status = "failed";
          // Error strings reference operations/kinds, never credential values.
          record.error = err instanceof Error ? err.message : "job failed";
          console.error(
            JSON.stringify({ event: "job_failed", jobId: record.jobId, op: record.op, error: record.error }),
          );
        }
        this.gc();
      })
      .finally(() => {
        // A newer job may already have extended this container's chain. Only
        // the tail promise is allowed to remove the entry.
        if (this.chains.get(request.containerId) === next) {
          this.chains.delete(request.containerId);
        }
      });
    this.chains.set(request.containerId, next);
    return record;
  }

  /** Forget snapshot watermarks for a container that no longer exists. */
  private pruneRevisions(containerId: string): void {
    for (const key of this.revisions.keys()) {
      if (key.startsWith(`${containerId}:`)) this.revisions.delete(key);
    }
  }

  /** Keep the registry bounded: drop terminal jobs beyond the last 500. */
  private gc(): void {
    if (this.jobs.size <= 500) return;
    for (const [id, job] of this.jobs) {
      if (job.status === "succeeded" || job.status === "failed") {
        this.jobs.delete(id);
        if (this.jobs.size <= 400) break;
      }
    }
  }
}
