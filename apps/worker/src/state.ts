import type { ContainerStatus, JobOp } from "@codestation/contract";

/**
 * Ops whose failure drops the container into `error` (the container's fate is
 * tied to the job). Background ops (sync-keys, refresh-credentials,
 * export-window) fail without disturbing container state.
 */
export const LIFECYCLE_OPS: ReadonlySet<JobOp> = new Set<JobOp>([
  "provision",
  "rebuild",
  "start",
  "stop",
  "destroy",
  "resize",
]);

/** Which container status a user-triggered op moves the container into while the job runs. */
export function pendingStatusFor(op: JobOp): ContainerStatus | null {
  switch (op) {
    case "provision":
    case "rebuild":
      return "provisioning";
    case "destroy":
      return "destroying";
    default:
      return null; // start/stop/sync-keys/refresh-credentials don't change status until done
  }
}

/** Which container status a succeeded job resolves to (null = keep current / row deleted). */
export function successStatusFor(op: JobOp): ContainerStatus | null {
  switch (op) {
    case "provision":
    case "rebuild":
    case "start":
    case "resize":
      return "running";
    case "stop":
      return "stopped";
    default:
      return null;
  }
}

/** Ops a user may invoke directly, per current status. */
export function allowedUserOps(status: ContainerStatus): JobOp[] {
  switch (status) {
    case "running":
      // Key and credential synchronization is triggered by its owning update,
      // never exposed as a manual container lifecycle action.
      return ["stop", "rebuild", "destroy"];
    case "stopped":
      return ["start", "rebuild", "destroy"];
    case "error":
      return ["destroy"]; // plus retry, which re-runs the failed op
    default:
      return [];
  }
}
