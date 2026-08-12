import type { StatsResponse } from "@workbench/contract";
import { HOST_FAILURE_THRESHOLD } from "./capacity.js";
import type { Bindings } from "./types.js";

export async function recordHostFailure(env: Bindings, hostId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE hosts
     SET consecutive_failures = consecutive_failures + 1,
         status = CASE
           WHEN status = 'active' AND consecutive_failures + 1 >= ? THEN 'unhealthy'
           ELSE status
         END
     WHERE id = ? AND status IN ('active','draining','unhealthy')`,
  )
    .bind(HOST_FAILURE_THRESHOLD, hostId)
    .run();
}

export async function recordHostStats(
  env: Bindings,
  hostId: string,
  stats: StatsResponse,
  observedAt: number,
): Promise<void> {
  // A release becomes placement evidence only when the daemon also reports
  // the class that daemonStats matched against D1. Reduced legacy stats remain
  // usable for drift observation but cannot make a host eligible.
  const verifiedVersion = stats.hostType === undefined ? null : (stats.version ?? null);
  await env.DB.prepare(
    `UPDATE hosts
     SET last_seen_at = ?,
         consecutive_failures = 0,
         daemon_version = ?,
         reported_ram_total_mb = ?,
         reported_cpu_logical = ?,
         status = CASE WHEN status = 'unhealthy' THEN 'active' ELSE status END
     WHERE id = ? AND status IN ('active','draining','unhealthy')`,
  )
    .bind(
      observedAt,
      verifiedVersion,
      stats.ramTotalMb,
      stats.cpuLogical ?? null,
      hostId,
    )
    .run();
}
