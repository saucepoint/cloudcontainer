import {
  HOST_RAM_OVERCOMMIT_DENOMINATOR,
  HOST_RAM_OVERCOMMIT_NUMERATOR,
  TIERS,
  type HostType,
  type TenancyMode,
  type Tier,
} from "@workbench/contract";
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
  tenancyMode?: TenancyMode;
  /** Legacy daemon fallback during the mixed-tier rollout. */
  hostType: HostType;
  cpu: number;
  ramMb: number;
  diskGb: number;
}

/**
 * Select an eligible host using exact additive CPU/RAM/disk reservations and a
 * deterministic fragmentation score. Dedicated hosts additionally require an
 * explicit account assignment. The caller repeats every predicate in its write
 * transaction before reserving the host.
 */
export async function pickHost(
  env: Bindings,
  request: PlacementRequest,
  now: () => number = Date.now,
  excludedHostIds: readonly string[] = [],
): Promise<HostRow | null> {
  const tenancyMode = request.tenancyMode ??
    (request.hostType === "dedicated" ? "dedicated" : "shared");
  return env.DB.prepare(
    `SELECT h.* FROM hosts h
     WHERE h.status = 'active'
       AND h.tenancy_mode = ?1
       AND (h.tenancy_mode <> 'dedicated' OR h.dedicated_user_id = ?2)
       AND (
         h.tenancy_mode = 'dedicated'
         OR h.daemon_capabilities LIKE ?10
         OR h.host_type = ?11
       )
       AND h.vcpu_allocated + ?3 <= h.vcpu_capacity
       AND (h.ram_allocated_mb + ?4) * ?9 <=
           (h.ram_total_mb - h.ram_reserve_mb) * ?8
       AND h.disk_total_gb - h.disk_allocated_gb >= ?5
       AND h.max_tenants > (SELECT COUNT(*) FROM containers c WHERE c.host_id = h.id)
       AND h.last_seen_at IS NOT NULL AND h.last_seen_at >= ?6
       AND h.consecutive_failures = 0
       AND h.daemon_version IS NOT NULL
       AND h.reported_ram_total_mb IS NOT NULL
       AND h.reported_cpu_logical IS NOT NULL
       AND h.id NOT IN (SELECT value FROM json_each(?7))
     ORDER BY MIN(
                CAST((h.vcpu_capacity - h.vcpu_allocated - ?3) * 100000 /
                  h.vcpu_capacity AS INTEGER),
                CAST(((h.ram_total_mb - h.ram_reserve_mb) * ?8 -
                  (h.ram_allocated_mb + ?4) * ?9) * 100000 /
                  ((h.ram_total_mb - h.ram_reserve_mb) * ?8) AS INTEGER),
                CAST((h.disk_total_gb - h.disk_allocated_gb - ?5) * 100000 /
                  h.disk_total_gb AS INTEGER)
              ) DESC,
              (
                CAST((h.vcpu_capacity - h.vcpu_allocated - ?3) * 100000 /
                  h.vcpu_capacity AS INTEGER) +
                CAST(((h.ram_total_mb - h.ram_reserve_mb) * ?8 -
                  (h.ram_allocated_mb + ?4) * ?9) * 100000 /
                  ((h.ram_total_mb - h.ram_reserve_mb) * ?8) AS INTEGER) +
                CAST((h.disk_total_gb - h.disk_allocated_gb - ?5) * 100000 /
                  h.disk_total_gb AS INTEGER)
              ) ASC,
              (SELECT COUNT(*) FROM containers c WHERE c.host_id = h.id),
              h.id
     LIMIT 1`,
  )
    .bind(
      tenancyMode,
      request.userId,
      request.cpu,
      request.ramMb,
      request.diskGb,
      now() - HOST_HEARTBEAT_MAX_AGE_MS,
      JSON.stringify(excludedHostIds),
      HOST_RAM_OVERCOMMIT_NUMERATOR,
      HOST_RAM_OVERCOMMIT_DENOMINATOR,
      '%"mixed-tier-shared-v1"%',
      request.hostType,
    )
    .first<HostRow>();
}
