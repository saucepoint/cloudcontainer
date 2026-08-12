import { TIERS, type TenancyMode, type Tier } from "@workbench/contract";
import type { Bindings, HostRow } from "./types.js";

/** Home and disposable rootfs each receive the advertised disk cap. */
export function diskReservationGb(homeDiskGb: number): number {
  return homeDiskGb * 2;
}

/** Host accounting uses the real Incus CPU limit, not the public plan label. */
export function cpuReservation(tier: Tier): number {
  return TIERS[tier].provisionedCpu;
}

/** Placement requires a recent positive daemon heartbeat. */
export const HOST_HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;

/** Repeated failures quarantine a host before admitting more tenants. */
export const HOST_FAILURE_THRESHOLD = 3;

export interface PlacementRequest {
  userId: string;
  tenancyMode: TenancyMode;
  cpu: number;
  ramMb: number;
  diskGb: number;
}

/**
 * Select the host with the greatest post-placement availability. CPU, RAM,
 * disk, and tenant-slot headroom are normalized independently so a large value
 * in one dimension cannot hide a hotspot in another. Shared hosts accept both
 * resource tiers; dedicated hosts additionally require an account assignment.
 * The caller repeats every predicate in its write transaction before reserving
 * the host.
 */
export async function pickHost(
  env: Bindings,
  request: PlacementRequest,
  now: () => number = Date.now,
  excludedHostIds: readonly string[] = [],
): Promise<HostRow | null> {
  return env.DB.prepare(
    `SELECT h.* FROM host_availability h
     WHERE h.status = 'active'
       AND h.tenancy_mode = ?1
       AND (h.tenancy_mode <> 'dedicated' OR h.dedicated_user_id = ?2)
       AND h.vcpu_available >= ?3
       AND h.ram_available_mb >= ?4
       AND h.disk_available_gb >= ?5
       AND h.tenant_slots_available > 0
       AND h.last_seen_at IS NOT NULL AND h.last_seen_at >= ?6
       AND h.consecutive_failures = 0
       AND h.daemon_version IS NOT NULL
       AND h.reported_ram_total_mb IS NOT NULL
       AND h.reported_cpu_logical IS NOT NULL
       AND h.id NOT IN (SELECT value FROM json_each(?7))
     ORDER BY MIN(
                CAST((h.vcpu_available - ?3) * 100000 /
                  h.vcpu_capacity AS INTEGER),
                CAST((h.ram_available_mb - ?4) * 100000 /
                  h.ram_capacity_mb AS INTEGER),
                CAST((h.disk_available_gb - ?5) * 100000 /
                  h.disk_total_gb AS INTEGER),
                CAST((h.tenant_slots_available - 1) * 100000 /
                  h.max_tenants AS INTEGER)
              ) DESC,
              (
                CAST((h.vcpu_available - ?3) * 100000 /
                  h.vcpu_capacity AS INTEGER) +
                CAST((h.ram_available_mb - ?4) * 100000 /
                  h.ram_capacity_mb AS INTEGER) +
                CAST((h.disk_available_gb - ?5) * 100000 /
                  h.disk_total_gb AS INTEGER) +
                CAST((h.tenant_slots_available - 1) * 100000 /
                  h.max_tenants AS INTEGER)
              ) DESC,
              h.id
     LIMIT 1`,
  )
    .bind(
      request.tenancyMode,
      request.userId,
      request.cpu,
      request.ramMb,
      request.diskGb,
      now() - HOST_HEARTBEAT_MAX_AGE_MS,
      JSON.stringify(excludedHostIds),
    )
    .first<HostRow>();
}
