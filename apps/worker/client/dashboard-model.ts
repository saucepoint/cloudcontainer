import type { Agent, ContainerStatus, JobOp, JobStatus, Tier } from "@workbench/contract";
import { errorMessage } from "./http.js";

export interface ContainerView {
  id: string;
  status: ContainerStatus;
  statusDetail: string | null;
  agents: Agent[];
  tier: Tier;
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
  job: { id: string; op: JobOp; status: JobStatus; error: string | null } | null;
  allowedOps: JobOp[];
}

export interface SshKey {
  id: number;
  label: string;
  pubkey: string;
  created_at: number;
}

export interface DashboardSnapshot {
  container: ContainerView | null;
  configuration: {
    agents: Agent[];
    githubRepos: string[];
    createdAt: number;
    updatedAt: number;
  } | null;
  keys: SshKey[];
  credentials: {
    llm: Record<string, boolean>;
    cloudflare: boolean;
    supabase: boolean;
    convex: boolean;
    wrangler: boolean;
    github: string | null;
  };
  account: {
    state: "unverified" | "verified" | "premium" | "verified_premium";
    verified: boolean;
    premium: boolean;
  };
  billing: {
    configured: boolean;
    trialEligible: boolean;
    paidPlan: {
      price: string;
      currency: string;
      interval: "month";
      trialDays: number;
      display: string;
    } | null;
    entitlement: {
      eligible: boolean;
      plan: string | null;
      source: string | null;
      state: string;
      accessUntil: number | null;
    };
    billing: {
      source: string;
      state: string;
      trialUntil: number | null;
      serviceUntil: number | null;
      graceUntil: number | null;
    } | null;
    subscription: {
      status: string;
      cancelAtPeriodEnd: boolean;
      cancelAt: number | null;
      trialStart: number | null;
      trialEnd: number | null;
      serviceUntil: number | null;
      graceUntil: number | null;
    } | null;
  };
}

export type BillingStatus = DashboardSnapshot["billing"] & {
  account: DashboardSnapshot["account"];
};

export type ContainerAction = JobOp | "retry";

export const STATUS_LABELS: Record<ContainerStatus, string> = {
  waitlisted: "Waiting for capacity",
  provisioning: "Building",
  running: "Ready",
  stopped: "Stopped",
  suspended: "Suspended",
  upgrade_pending: "Plan change pending",
  error: "Needs attention",
  destroying: "Deleting",
};

export function formatRamGb(ramMb: number): string {
  return String(ramMb / 1024);
}

export function displayError(error: unknown, fallback: string): string {
  const message = errorMessage(error, "");
  return message && message !== "internal error" ? message : fallback;
}

export function isBusy(container: ContainerView | null): boolean {
  return Boolean(container && (
    container.status === "provisioning" ||
    container.status === "destroying" ||
    container.status === "upgrade_pending" ||
    container.job?.status === "queued" ||
    container.job?.status === "running"
  ));
}

export function planAdjustmentLabel(container: ContainerView): string | null {
  if (container.status !== "upgrade_pending" || !container.planTransition) return null;
  const downgrading = container.planTransition.desiredTier === "free";
  const activeJob = container.job?.status === "queued" || container.job?.status === "running"
    ? container.job.op
    : null;

  if (downgrading && activeJob === "stop") {
    return "Stopping your workbench before applying Free limits…";
  }
  if (activeJob === "resize" || container.planTransition.state === "resizing") {
    return downgrading
      ? "Applying Free CPU and memory limits…"
      : "Applying Premium CPU, memory, and storage limits…";
  }
  if (container.planTransition.state === "waiting_capacity") {
    return downgrading
      ? "Waiting for the host before applying Free limits…"
      : "Waiting for Premium capacity…";
  }
  if (container.planTransition.state === "failed_retryable") {
    return downgrading
      ? "Retrying the Free instance adjustment…"
      : "Retrying the Premium instance adjustment…";
  }
  return downgrading
    ? "Preparing the Free instance adjustment…"
    : "Preparing the Premium instance adjustment…";
}

export function canManageSshKeys(container: ContainerView | null): boolean {
  return container?.status === "running";
}

export function pollDelay(container: ContainerView | null, refreshNeeded = false): number | null {
  if (refreshNeeded) return 5_000;
  if (!container) return null;
  if (container.status === "waitlisted") return 30_000;
  if (container.status === "upgrade_pending") return 5_000;
  if (isBusy(container)) return 5_000;
  return null;
}
