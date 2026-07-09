/**
 * In-memory async job registry. Jobs are executed sequentially per container
 * (an op must not race another op on the same container). State is lost on
 * daemon restart; the control-plane reconciler times such jobs out to `error`
 * with a working retry — never a stuck spinner.
 */
import type { JobRequest, JobStatus, ProvisionResult } from "@codestation/contract";
import type { Provisioner } from "./provisioner.js";

export interface JobRecord {
  jobId: string;
  containerId: string;
  op: JobRequest["op"];
  status: JobStatus;
  error: string | null;
  result: ProvisionResult | null;
}

export class JobRunner {
  private jobs = new Map<string, JobRecord>();
  private chains = new Map<string, Promise<void>>();

  constructor(private provisioner: Provisioner) {}

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  /** Accept and start a job; returns immediately (the daemon replies 202). */
  submit(request: JobRequest): JobRecord {
    const existing = this.jobs.get(request.jobId);
    if (existing) return existing; // idempotent re-delivery

    const record: JobRecord = {
      jobId: request.jobId,
      containerId: request.containerId,
      op: request.op,
      status: "queued",
      error: null,
      result: null,
    };
    this.jobs.set(request.jobId, record);

    const prev = this.chains.get(request.containerId) ?? Promise.resolve();
    const next = prev.then(async () => {
      record.status = "running";
      try {
        record.result = await this.provisioner.run(request);
        record.status = "succeeded";
      } catch (err) {
        record.status = "failed";
        // Error strings reference operations/kinds, never credential values.
        record.error = err instanceof Error ? err.message : "job failed";
        console.log(
          JSON.stringify({ event: "job_failed", jobId: record.jobId, op: record.op, error: record.error }),
        );
      }
      this.gc();
    });
    this.chains.set(request.containerId, next);
    return record;
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
