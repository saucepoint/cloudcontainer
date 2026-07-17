import type { Bindings, HostRow } from "./types.js";

/** Home and disposable rootfs each receive the advertised disk cap. */
export function diskReservationGb(homeDiskGb: number): number {
  return homeDiskGb * 2;
}

/** Placement requires a recent positive daemon heartbeat. */
export const HOST_HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;

/** Repeated failures quarantine a host before admitting more tenants. */
export const HOST_FAILURE_THRESHOLD = 3;

/**
 * Select the healthy host with the most free, non-reserved RAM. The caller
 * must repeat the capacity check in its write transaction before reserving it.
 */
export async function pickHost(
  env: Bindings,
  cpu: number,
  ramMb: number,
  diskGb: number,
  now: () => number = Date.now,
): Promise<HostRow | null> {
  return env.DB.prepare(
    `SELECT * FROM hosts
     WHERE status = 'active'
       AND vcpu_capacity - vcpu_allocated >= ?
       AND ram_total_mb - ram_reserve_mb - ram_allocated_mb >= ?
       AND disk_total_gb - disk_allocated_gb >= ?
       AND last_seen_at IS NOT NULL AND last_seen_at >= ?
       AND consecutive_failures = 0
     ORDER BY ram_total_mb - ram_reserve_mb - ram_allocated_mb DESC,
              vcpu_capacity - vcpu_allocated DESC,
              id
     LIMIT 1`,
  )
    .bind(cpu, ramMb, diskGb, now() - HOST_HEARTBEAT_MAX_AGE_MS)
    .first<HostRow>();
}
