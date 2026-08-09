/**
 * Transport to per-host daemons: publicly trusted HTTPS plus Ed25519-signed
 * requests with timestamp and nonce. mTLS/private ingress remains future
 * hardening; credential payloads are independently sealed to each host.
 */
import {
  JobStatusResponseSchema,
  MAX_HOST_VCPU_OVERCOMMIT,
  StatsResponseSchema,
  signRequest,
  type JobRequest,
  type JobStatusResponse,
  type StatsResponse,
} from "@workbench/contract";
import type { Bindings, HostRow } from "./types.js";

const RPC_TIMEOUT_MS = 15_000;
const RAM_REPORT_TOLERANCE_MB = 16;

async function daemonFetch(
  env: Bindings,
  host: HostRow,
  method: "GET" | "POST",
  path: string,
  body: string = "",
): Promise<Response> {
  const headers = signRequest(method, path, body, env.WORKER_RPC_PRIVATE_KEY);
  return fetch(`${host.daemon_endpoint}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
}

export async function daemonSubmitJob(
  env: Bindings,
  host: HostRow,
  request: JobRequest,
): Promise<void> {
  const res = await daemonFetch(env, host, "POST", "/jobs", JSON.stringify(request));
  if (res.status !== 202 && res.status !== 200) {
    throw new Error(`daemon rejected job (${res.status})`);
  }
  const ack = (await res.json().catch(() => null)) as { jobId?: unknown; status?: unknown } | null;
  if (
    !ack ||
    ack.jobId !== request.jobId ||
    !["queued", "running", "succeeded", "failed"].includes(String(ack.status))
  ) {
    throw new Error("daemon returned an invalid job acknowledgement");
  }
}

/** Returns null when the daemon does not know the job (lost to a daemon restart). */
export async function daemonJobStatus(
  env: Bindings,
  host: HostRow,
  jobId: string,
): Promise<JobStatusResponse | null> {
  const res = await daemonFetch(env, host, "GET", `/jobs/${jobId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`daemon job status failed (${res.status})`);
  const status = JobStatusResponseSchema.parse(await res.json());
  if (status.jobId !== jobId) throw new Error("daemon returned status for the wrong job");
  return status;
}

export async function daemonStats(env: Bindings, host: HostRow): Promise<StatsResponse> {
  const res = await daemonFetch(env, host, "GET", "/stats");
  if (!res.ok) throw new Error(`daemon stats failed (${res.status})`);
  const stats = StatsResponseSchema.parse(await res.json());
  if (stats.hostId !== host.id) throw new Error("daemon stats host identity mismatch");
  if (stats.hostType !== undefined && stats.hostType !== host.host_type) {
    throw new Error("daemon stats host type mismatch");
  }
  if (stats.tenancyMode !== undefined && stats.tenancyMode !== host.tenancy_mode) {
    throw new Error("daemon stats tenancy mode mismatch");
  }
  if (stats.ramTotalMb + RAM_REPORT_TOLERANCE_MB < host.ram_total_mb) {
    throw new Error("daemon reports less RAM than the registered host capacity");
  }
  if (
    stats.cpuLogical !== undefined &&
    host.vcpu_capacity > stats.cpuLogical * MAX_HOST_VCPU_OVERCOMMIT
  ) {
    throw new Error("daemon reports fewer CPUs than the registered host capacity supports");
  }
  return stats;
}
