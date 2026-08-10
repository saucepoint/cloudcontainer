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

export type ContainerAction = JobOp | "retry";

export const STATUS_LABELS: Record<ContainerStatus, string> = {
  waitlisted: "Waiting for capacity",
  provisioning: "Building",
  running: "Ready",
  stopped: "Stopped",
  suspended: "Suspended",
  upgrade_pending: "Upgrade pending",
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
    container.job?.status === "queued" ||
    container.job?.status === "running"
  ));
}

export function canManageSshKeys(container: ContainerView | null): boolean {
  return container?.status === "running";
}

export function pollDelay(container: ContainerView | null, refreshNeeded = false): number | null {
  if (refreshNeeded) return 5_000;
  if (!container) return null;
  if (container.status === "waitlisted") return 30_000;
  if (isBusy(container)) return 5_000;
  return null;
}
