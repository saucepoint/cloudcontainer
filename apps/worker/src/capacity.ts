import {
  HOST_RAM_OVERCOMMIT_DENOMINATOR,
  HOST_RAM_OVERCOMMIT_NUMERATOR,
  TIERS,
  type HostType,
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
  hostType: HostType;
  cpu: number;
  ramMb: number;
  diskGb: number;
}

/**
 * Select an eligible host with the most complete placements still available
 * across its tenant, rounded CPU/RAM, and disk ceilings. Dedicated hosts
 * additionally require an explicit account assignment. The caller must repeat
 * every check in its write transaction before reserving the host.
 */
export async function pickHost(
  env: Bindings,
  request: PlacementRequest,
  now: () => number = Date.now,
  excludedHostIds: readonly string[] = [],
): Promise<HostRow | null> {
  return env.DB.prepare(
    `SELECT h.* FROM hosts h
     WHERE h.status = 'active'
       AND h.host_type = ?1
       AND (h.host_type <> 'dedicated' OR h.dedicated_user_id = ?2)
       AND h.vcpu_allocated + ?3 <=
         ((h.vcpu_capacity + ?3 - 1) / ?3) * ?3
       AND h.ram_allocated_mb + ?4 <=
         (((h.ram_total_mb - h.ram_reserve_mb) * ?8 + (?9 * ?4) - 1) / (?9 * ?4)) * ?4
       AND h.disk_total_gb - h.disk_allocated_gb >= ?5
       AND h.max_tenants > (SELECT COUNT(*) FROM containers c WHERE c.host_id = h.id)
       AND h.last_seen_at IS NOT NULL AND h.last_seen_at >= ?6
       AND h.consecutive_failures = 0
       AND h.daemon_version IS NOT NULL
       AND h.reported_ram_total_mb IS NOT NULL
       AND h.reported_cpu_logical IS NOT NULL
       AND h.id NOT IN (SELECT value FROM json_each(?7))
     ORDER BY MIN(
                h.max_tenants - (SELECT COUNT(*) FROM containers c WHERE c.host_id = h.id),
                CAST((
                  (((h.vcpu_capacity + ?3 - 1) / ?3) * ?3 - h.vcpu_allocated) / ?3
                ) AS INTEGER),
                CAST((
                  ((((h.ram_total_mb - h.ram_reserve_mb) * ?8 + (?9 * ?4) - 1) / (?9 * ?4)) * ?4
                    - h.ram_allocated_mb) / ?4
                ) AS INTEGER),
                CAST((h.disk_total_gb - h.disk_allocated_gb) / ?5 AS INTEGER)
              ) DESC,
              (SELECT COUNT(*) FROM containers c WHERE c.host_id = h.id),
              h.id
     LIMIT 1`,
  )
    .bind(
      request.hostType,
      request.userId,
      request.cpu,
      request.ramMb,
      request.diskGb,
      now() - HOST_HEARTBEAT_MAX_AGE_MS,
      JSON.stringify(excludedHostIds),
      HOST_RAM_OVERCOMMIT_NUMERATOR,
      HOST_RAM_OVERCOMMIT_DENOMINATOR,
    )
    .first<HostRow>();
}
