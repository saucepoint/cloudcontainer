import {
  ContainerRehomeSchema,
  HostFleetUpdateSchema,
  HostRegistrationSchema,
  SERVICE_PLANS,
  TIERS,
  type HostCapacity,
  type ServicePlan,
  type StatsResponse,
} from "@workbench/contract";
import { Hono, type Context } from "hono";
import { bearerToken, secretMatches } from "./admin-auth.js";
import { HOST_HEARTBEAT_MAX_AGE_MS } from "./capacity.js";
import { daemonStats } from "./daemon.js";
import { recordHostFailure, recordHostStats } from "./host-health.js";
import { readJsonBody } from "./http.js";
import { enqueueJob, getHost, latestLifecycleJob } from "./jobs.js";
import type { AppContext, ContainerRow, HostRow } from "./types.js";

interface FleetHostRow extends HostRow {
  tenant_count: number;
  active_job_count: number;
}

async function fleetAuthFailure(c: Context<AppContext>): Promise<Response | null> {
  if (!c.env.FLEET_ADMIN_SECRET) return c.notFound();
  const provided = bearerToken(c.req.header("authorization"));
  if (!(await secretMatches(provided, c.env.FLEET_ADMIN_SECRET))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}

function requiredRouteId(c: Context<AppContext>): string {
  const id = c.req.param("id");
  if (!id) throw new Error("admin route is missing its id parameter");
  return id;
}

async function getFleetHost(env: AppContext["Bindings"], hostId: string): Promise<FleetHostRow | null> {
  return env.DB.prepare(
    `SELECT h.*,
       (SELECT COUNT(*) FROM containers c WHERE c.host_id = h.id) AS tenant_count,
       (SELECT COUNT(*)
        FROM jobs j JOIN containers c ON c.id = j.container_id
        WHERE c.host_id = h.id AND j.status IN ('queued','running')) AS active_job_count
     FROM hosts h
     WHERE h.id = ?`,
  )
    .bind(hostId)
    .first<FleetHostRow>();
}

function fleetHostView(host: FleetHostRow) {
  return {
    id: host.id,
    hostType: host.host_type,
    status: host.status,
    sshHostname: host.ssh_hostname,
    daemonEndpoint: host.daemon_endpoint,
    managementHostname: host.management_hostname,
    managementPort: host.management_port,
    managementUser: host.management_user,
    dedicatedUserId: host.dedicated_user_id,
    maxTenants: host.max_tenants,
    tenantCount: host.tenant_count,
    activeJobCount: host.active_job_count,
    vcpuCapacity: host.vcpu_capacity,
    vcpuAllocated: host.vcpu_allocated,
    reportedCpuLogical: host.reported_cpu_logical,
    ramTotalMb: host.ram_total_mb,
    ramReserveMb: host.ram_reserve_mb,
    ramAllocatedMb: host.ram_allocated_mb,
    reportedRamTotalMb: host.reported_ram_total_mb,
    diskTotalGb: host.disk_total_gb,
    diskAllocatedGb: host.disk_allocated_gb,
    daemonVersion: host.daemon_version,
    joinedAt: host.joined_at,
    lastSeenAt: host.last_seen_at,
    consecutiveFailures: host.consecutive_failures,
    generation: host.generation,
    retiredAt: host.retired_at,
  };
}

async function dedicatedAccountIsEligible(
  env: AppContext["Bindings"],
  userId: string,
): Promise<boolean> {
  const user = await env.DB.prepare(
    `SELECT id FROM users
     WHERE id = ? AND status = 'active' AND subscription_status = 'dedicated'`,
  )
    .bind(userId)
    .first<{ id: string }>();
  return user !== null;
}

async function dedicatedAccountHasHost(
  env: AppContext["Bindings"],
  userId: string,
  exceptHostId?: string,
): Promise<boolean> {
  const assigned = await env.DB.prepare(
    `SELECT id FROM hosts
     WHERE dedicated_user_id = ? AND (? IS NULL OR id <> ?)`,
  )
    .bind(userId, exceptHostId ?? null, exceptHostId ?? null)
    .first<{ id: string }>();
  return assigned !== null;
}

function capacityError(
  host: FleetHostRow,
  capacity: HostCapacity,
  hostType = host.host_type,
): string | null {
  const tier = hostType === "budget" ? TIERS.free : TIERS.paid;
  const resourceCeiling = Math.min(
    Math.floor(capacity.vcpuCapacity / tier.provisionedCpu),
    Math.floor((capacity.ramTotalMb - capacity.ramReserveMb) / tier.ramMb),
    Math.floor(capacity.diskTotalGb / (tier.diskGb * 2)),
  );
  if (capacity.maxTenants > resourceCeiling) {
    return "tenant ceiling exceeds CPU, RAM, or disk capacity";
  }
  if (hostType === "dedicated" && capacity.maxTenants !== 1) {
    return "dedicated hosts must have exactly one tenant slot";
  }
  if (capacity.maxTenants < host.tenant_count) {
    return "tenant ceiling is below the current tenant count";
  }
  if (capacity.vcpuCapacity < host.vcpu_allocated) {
    return "vCPU capacity is below the current reservation";
  }
  if (capacity.ramTotalMb - capacity.ramReserveMb < host.ram_allocated_mb) {
    return "RAM capacity is below the current reservation";
  }
  if (capacity.diskTotalGb < host.disk_allocated_gb) {
    return "disk capacity is below the current reservation";
  }
  return null;
}

function archiveHost(
  env: AppContext["Bindings"],
  host: FleetHostRow,
  retiredAt: number,
  reason: string,
) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO host_history
       (host_id, generation, host_type, ipv4, ipv6, ssh_hostname,
        daemon_endpoint, daemon_cert_fp, daemon_pubkey, management_hostname,
        management_port, management_user, ram_total_mb, ram_reserve_mb,
        ram_allocated_mb, vcpu_capacity, vcpu_allocated, disk_total_gb,
        disk_allocated_gb, max_tenants, dedicated_user_id, joined_at,
        last_seen_at, daemon_version, reported_ram_total_mb,
        reported_cpu_logical, retired_at, retirement_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    host.id,
    host.generation,
    host.host_type,
    host.ipv4,
    host.ipv6,
    host.ssh_hostname,
    host.daemon_endpoint,
    host.daemon_cert_fp,
    host.daemon_pubkey,
    host.management_hostname,
    host.management_port,
    host.management_user,
    host.ram_total_mb,
    host.ram_reserve_mb,
    host.ram_allocated_mb,
    host.vcpu_capacity,
    host.vcpu_allocated,
    host.disk_total_gb,
    host.disk_allocated_gb,
    host.max_tenants,
    host.dedicated_user_id,
    host.joined_at,
    host.last_seen_at,
    host.daemon_version,
    host.reported_ram_total_mb,
    host.reported_cpu_logical,
    retiredAt,
    reason,
  );
}

/**
 * Retiring an unreachable host converts recoverable desired rows back into
 * waitlist entries. This is a destructive re-provision: the old machine must
 * already be isolated because its host-local home volumes cannot be copied.
 */
async function retireHost(
  env: AppContext["Bindings"],
  host: FleetHostRow,
  forced: boolean,
): Promise<boolean> {
  const now = Date.now();
  const reason = forced ? "forced evacuation" : "empty retirement";
  const results = (await env.DB.batch([
    archiveHost(env, host, now, reason),
    env.DB.prepare(
      `INSERT OR REPLACE INTO port_quarantine (host_id, port, released_at)
       SELECT host_id, ssh_port, ? FROM containers
       WHERE host_id = ? AND ssh_port IS NOT NULL`,
    ).bind(now, host.id),
    env.DB.prepare(
      `UPDATE jobs
       SET status = 'failed', error = 'host retired during evacuation', updated_at = ?
       WHERE status IN ('queued','running') AND container_id IN (
         SELECT id FROM containers WHERE host_id = ?
       )`,
    ).bind(now, host.id),
    // A requested/grace-period destroy is complete when the failed machine is
    // declared unrecoverable; do not accidentally provision it again.
    env.DB.prepare(
      `DELETE FROM waitlist WHERE user_id IN (
         SELECT user_id FROM containers
         WHERE host_id = ? AND (
           status IN ('destroying','suspended') OR NOT EXISTS (
             SELECT 1 FROM users u WHERE u.id = containers.user_id AND u.status = 'active'
           )
         )
       )`,
    ).bind(host.id),
    env.DB.prepare(
      `DELETE FROM containers
       WHERE host_id = ? AND (
         status IN ('destroying','suspended') OR NOT EXISTS (
           SELECT 1 FROM users u WHERE u.id = containers.user_id AND u.status = 'active'
         )
       )`,
    ).bind(host.id),
    env.DB.prepare(
      `INSERT INTO waitlist (user_id, requested_at, admitted_at)
       SELECT c.user_id, ?, NULL
       FROM containers c JOIN users u ON u.id = c.user_id
       WHERE c.host_id = ? AND u.status = 'active'
         AND u.subscription_status IN ('free','paid','dedicated')
       ON CONFLICT(user_id) DO UPDATE SET
         requested_at = excluded.requested_at, admitted_at = NULL`,
    ).bind(now, host.id),
    env.DB.prepare(
      `UPDATE containers
       SET host_id = NULL, ssh_port = NULL,
           tier = CASE (
             SELECT u.subscription_status FROM users u WHERE u.id = containers.user_id
           ) WHEN 'free' THEN 'free' ELSE 'paid' END,
           placement_class = CASE (
             SELECT u.subscription_status FROM users u WHERE u.id = containers.user_id
           ) WHEN 'free' THEN 'budget' WHEN 'paid' THEN 'regular' ELSE 'dedicated' END,
           cpu = CASE (
             SELECT u.subscription_status FROM users u WHERE u.id = containers.user_id
           ) WHEN 'free' THEN 1 ELSE 2 END,
           ram_mb = CASE (
             SELECT u.subscription_status FROM users u WHERE u.id = containers.user_id
           ) WHEN 'free' THEN 1536 ELSE 4096 END,
           disk_gb = CASE (
             SELECT u.subscription_status FROM users u WHERE u.id = containers.user_id
           ) WHEN 'free' THEN 5 ELSE 8 END,
           status = 'waitlisted', status_detail = 'host retired; awaiting replacement placement',
           host_key_fingerprints = NULL, rehome_tier = NULL,
           rehome_placement_class = NULL, rehome_requested_at = NULL
       WHERE host_id = ? AND EXISTS (
         SELECT 1 FROM users u WHERE u.id = containers.user_id
           AND u.status = 'active'
           AND u.subscription_status IN ('free','paid','dedicated')
       )`,
    ).bind(host.id),
    env.DB.prepare(
      `UPDATE containers
       SET host_id = NULL, ssh_port = NULL, status = 'error',
           status_detail = 'account plan is ineligible; update it before re-homing',
           host_key_fingerprints = NULL, rehome_tier = NULL,
           rehome_placement_class = NULL, rehome_requested_at = NULL
       WHERE host_id = ?`,
    ).bind(host.id),
    env.DB.prepare(
      `UPDATE hosts
       SET status = 'dead', vcpu_allocated = 0, ram_allocated_mb = 0,
           disk_allocated_gb = 0, dedicated_user_id = NULL, retired_at = ?
       WHERE id = ? AND status IN ('draining','dead')`,
    ).bind(now, host.id),
  ])) as Array<{ meta: { changes?: number } }>;
  return Boolean(results.at(-1)?.meta.changes);
}

async function registerHost(c: Context<AppContext>): Promise<Response> {
  const parsed = HostRegistrationSchema.safeParse(await readJsonBody<unknown>(c));
  if (!parsed.success) return c.json({ error: "invalid host registration" }, 400);
  const host = parsed.data;

  if (await getFleetHost(c.env, host.id)) {
    return c.json({ error: "host id already exists" }, 409);
  }
  if (
    host.dedicatedUserId !== undefined &&
    !(await dedicatedAccountIsEligible(c.env, host.dedicatedUserId))
  ) {
    return c.json({ error: "dedicated host assignment requires an eligible dedicated account" }, 409);
  }
  if (
    host.dedicatedUserId !== undefined &&
    await dedicatedAccountHasHost(c.env, host.dedicatedUserId)
  ) {
    return c.json({ error: "dedicated account already has an assigned host" }, 409);
  }

  const registered = await c.env.DB.prepare(
    `INSERT INTO hosts
       (id, ipv4, ipv6, ssh_hostname, daemon_endpoint, daemon_cert_fp,
        daemon_pubkey, ram_total_mb, ram_allocated_mb, ram_reserve_mb,
        vcpu_capacity, vcpu_allocated, disk_total_gb, disk_allocated_gb,
        status, joined_at, last_seen_at, consecutive_failures, host_type,
        max_tenants, dedicated_user_id, management_hostname, management_port,
        management_user, generation, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, 0, 'draining', ?, NULL, 0,
             ?, ?, ?, ?, ?, ?,
             COALESCE((SELECT MAX(generation) + 1 FROM host_history WHERE host_id = ?), 1),
             NULL)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      host.id,
      host.ipv4,
      host.ipv6 ?? null,
      host.sshHostname,
      host.daemonEndpoint,
      host.daemonCertFingerprint ?? null,
      host.daemonPublicKey,
      host.ramTotalMb,
      host.ramReserveMb,
      host.vcpuCapacity,
      host.diskTotalGb,
      Date.now(),
      host.hostType,
      host.maxTenants,
      host.dedicatedUserId ?? null,
      host.managementHostname,
      host.managementPort,
      host.managementUser,
      host.id,
    )
    .run();
  if (!registered.meta.changes) {
    return c.json({ error: "host id or dedicated assignment already exists" }, 409);
  }

  const inserted = await getFleetHost(c.env, host.id);
  if (!inserted) throw new Error("registered host row vanished");
  return c.json({ host: fleetHostView(inserted) }, 201);
}

async function replaceDeadHost(c: Context<AppContext>): Promise<Response> {
  const parsed = HostRegistrationSchema.safeParse(await readJsonBody<unknown>(c));
  if (!parsed.success) return c.json({ error: "invalid host registration" }, 400);
  const registration = parsed.data;
  const hostId = requiredRouteId(c);
  if (registration.id !== hostId) {
    return c.json({ error: "route and registration host ids differ" }, 400);
  }
  const current = await getFleetHost(c.env, hostId);
  if (!current) return c.json({ error: "unknown host; register it with POST" }, 404);
  if (current.status !== "dead" || current.tenant_count !== 0 || current.active_job_count !== 0) {
    return c.json({ error: "only an evacuated, empty dead host id can be replaced" }, 409);
  }
  if (
    registration.dedicatedUserId !== undefined &&
    !(await dedicatedAccountIsEligible(c.env, registration.dedicatedUserId))
  ) {
    return c.json({ error: "dedicated host assignment requires an eligible dedicated account" }, 409);
  }
  if (
    registration.dedicatedUserId !== undefined &&
    await dedicatedAccountHasHost(c.env, registration.dedicatedUserId, hostId)
  ) {
    return c.json({ error: "dedicated account already has an assigned host" }, 409);
  }

  const now = Date.now();
  const results = (await c.env.DB.batch([
    archiveHost(c.env, current, current.retired_at ?? now, "replaced host generation"),
    c.env.DB.prepare(
      `UPDATE hosts
       SET ipv4 = ?, ipv6 = ?, ssh_hostname = ?, daemon_endpoint = ?,
           daemon_cert_fp = ?, daemon_pubkey = ?, ram_total_mb = ?,
           ram_allocated_mb = 0, ram_reserve_mb = ?, vcpu_capacity = ?,
           vcpu_allocated = 0, disk_total_gb = ?, disk_allocated_gb = 0,
           status = 'draining', joined_at = ?, last_seen_at = NULL,
           consecutive_failures = 0, host_type = ?, max_tenants = ?,
           dedicated_user_id = ?, management_hostname = ?, management_port = ?,
           management_user = ?, daemon_version = NULL,
           reported_ram_total_mb = NULL, reported_cpu_logical = NULL,
           generation = generation + 1, retired_at = NULL
       WHERE id = ? AND status = 'dead'
         AND NOT EXISTS (SELECT 1 FROM containers WHERE host_id = hosts.id)`,
    ).bind(
      registration.ipv4,
      registration.ipv6 ?? null,
      registration.sshHostname,
      registration.daemonEndpoint,
      registration.daemonCertFingerprint ?? null,
      registration.daemonPublicKey,
      registration.ramTotalMb,
      registration.ramReserveMb,
      registration.vcpuCapacity,
      registration.diskTotalGb,
      now,
      registration.hostType,
      registration.maxTenants,
      registration.dedicatedUserId ?? null,
      registration.managementHostname,
      registration.managementPort,
      registration.managementUser,
      hostId,
    ),
  ])) as Array<{ meta: { changes?: number } }>;
  if (!results.at(-1)?.meta.changes) {
    return c.json({ error: "host state changed concurrently; reload and retry" }, 409);
  }
  const replaced = await getFleetHost(c.env, hostId);
  if (!replaced) throw new Error("replaced host row vanished");
  return c.json({ host: fleetHostView(replaced) });
}

async function updateHost(c: Context<AppContext>): Promise<Response> {
  const parsed = HostFleetUpdateSchema.safeParse(await readJsonBody<unknown>(c));
  if (!parsed.success) return c.json({ error: "invalid host update" }, 400);
  const hostId = requiredRouteId(c);
  let host = await getFleetHost(c.env, hostId);
  if (!host) return c.json({ error: "unknown host" }, 404);

  const connectionUpdateRequested =
    parsed.data.sshHostname !== undefined ||
    parsed.data.daemonEndpoint !== undefined ||
    parsed.data.managementHostname !== undefined ||
    parsed.data.managementPort !== undefined ||
    parsed.data.managementUser !== undefined;
  if (connectionUpdateRequested) {
    if (host.status !== "draining" || host.active_job_count !== 0) {
      return c.json({ error: "drain the host and finish active jobs before changing endpoints" }, 409);
    }
    const changed = await c.env.DB.prepare(
      `UPDATE hosts
       SET ssh_hostname = ?, daemon_endpoint = ?, management_hostname = ?,
           management_port = ?, management_user = ?, last_seen_at = NULL,
           consecutive_failures = 0, daemon_version = NULL,
           reported_ram_total_mb = NULL, reported_cpu_logical = NULL
       WHERE id = ? AND status = 'draining'`,
    )
      .bind(
        parsed.data.sshHostname ?? host.ssh_hostname,
        parsed.data.daemonEndpoint ?? host.daemon_endpoint,
        parsed.data.managementHostname ?? host.management_hostname,
        parsed.data.managementPort ?? host.management_port,
        parsed.data.managementUser ?? host.management_user,
        host.id,
      )
      .run();
    if (!changed.meta.changes) {
      return c.json({ error: "host state changed concurrently; reload and retry" }, 409);
    }
    host = (await getFleetHost(c.env, hostId)) ?? host;
  }

  if (parsed.data.dedicatedUserId !== undefined) {
    if (host.host_type !== "dedicated") {
      return c.json({ error: "only dedicated hosts have account assignments" }, 409);
    }
    if (host.status !== "draining" || host.tenant_count !== 0 || host.active_job_count !== 0) {
      return c.json({ error: "drain and empty the host before changing its assignment" }, 409);
    }
    if (
      parsed.data.dedicatedUserId !== null &&
      !(await dedicatedAccountIsEligible(c.env, parsed.data.dedicatedUserId))
    ) {
      return c.json({ error: "dedicated host assignment requires an eligible dedicated account" }, 409);
    }
    if (
      parsed.data.dedicatedUserId !== null &&
      await dedicatedAccountHasHost(c.env, parsed.data.dedicatedUserId, host.id)
    ) {
      return c.json({ error: "dedicated account already has an assigned host" }, 409);
    }
    const changed = await c.env.DB.prepare(
      `UPDATE hosts SET dedicated_user_id = ?
       WHERE id = ? AND status = 'draining'
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM users eligible
           WHERE eligible.id = ? AND eligible.status = 'active'
             AND eligible.subscription_status = 'dedicated'
         ))
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM hosts assigned
           WHERE assigned.dedicated_user_id = ? AND assigned.id <> ?
         ))`,
    )
      .bind(
        parsed.data.dedicatedUserId,
        host.id,
        parsed.data.dedicatedUserId,
        parsed.data.dedicatedUserId,
        parsed.data.dedicatedUserId,
        parsed.data.dedicatedUserId,
        host.id,
      )
      .run();
    if (!changed.meta.changes) {
      return c.json({ error: "host state changed concurrently; reload and retry" }, 409);
    }
    host = (await getFleetHost(c.env, hostId)) ?? host;
  }

  if (parsed.data.capacity !== undefined) {
    if (host.status !== "draining" || host.active_job_count !== 0) {
      return c.json({ error: "drain the host and finish active jobs before changing capacity" }, 409);
    }
    const targetHostType = parsed.data.hostType ?? host.host_type;
    const classChanged = targetHostType !== host.host_type;
    if (classChanged && host.tenant_count !== 0) {
      return c.json({ error: "empty the host before changing its class" }, 409);
    }
    const error = capacityError(host, parsed.data.capacity, targetHostType);
    if (error) return c.json({ error }, 409);
    const capacity = parsed.data.capacity;
    const changed = await c.env.DB.prepare(
      `UPDATE hosts
       SET host_type = ?, ram_total_mb = ?, ram_reserve_mb = ?, vcpu_capacity = ?,
           disk_total_gb = ?, max_tenants = ?, last_seen_at = NULL,
           consecutive_failures = 0, reported_ram_total_mb = NULL,
           reported_cpu_logical = NULL, daemon_version = NULL,
           dedicated_user_id = CASE WHEN ? = 'dedicated' THEN dedicated_user_id ELSE NULL END
       WHERE id = ? AND status = 'draining'`,
    )
      .bind(
        targetHostType,
        capacity.ramTotalMb,
        capacity.ramReserveMb,
        capacity.vcpuCapacity,
        capacity.diskTotalGb,
        capacity.maxTenants,
        targetHostType,
        host.id,
      )
      .run();
    if (!changed.meta.changes) {
      return c.json({ error: "host state changed concurrently; reload and retry" }, 409);
    }
    host = (await getFleetHost(c.env, hostId)) ?? host;
  }

  const requestedStatus = parsed.data.status;
  if (requestedStatus !== undefined) {
    if (host.status === "dead" && requestedStatus !== "dead") {
      return c.json({ error: "a dead host cannot be returned to service in place" }, 409);
    }
    if (requestedStatus === "active") {
      if (host.host_type === "dedicated" && !host.dedicated_user_id) {
        return c.json({ error: "assign a dedicated account before activation" }, 409);
      }
      if (
        host.tenant_count > host.max_tenants ||
        host.vcpu_allocated > host.vcpu_capacity ||
        host.ram_allocated_mb > host.ram_total_mb - host.ram_reserve_mb ||
        host.disk_allocated_gb > host.disk_total_gb
      ) {
        return c.json({ error: "registered capacity does not cover existing reservations" }, 409);
      }
      const healthy =
        host.last_seen_at !== null &&
        host.last_seen_at >= Date.now() - HOST_HEARTBEAT_MAX_AGE_MS &&
        host.consecutive_failures === 0 &&
        host.daemon_version !== null &&
        host.reported_ram_total_mb !== null &&
        host.reported_cpu_logical !== null;
      if (!healthy) return c.json({ error: "probe the host successfully before activation" }, 409);
    }
    if (
      requestedStatus === "dead" &&
      host.status !== "draining" &&
      !(host.status === "dead" && parsed.data.force)
    ) {
      return c.json({ error: "drain the host before retiring it" }, 409);
    }
    if (
      requestedStatus === "dead" &&
      !parsed.data.force &&
      (host.tenant_count !== 0 || host.active_job_count !== 0)
    ) {
      return c.json({ error: "host still owns tenants or active jobs; force is required" }, 409);
    }
    let didChange: boolean;
    if (requestedStatus === "active") {
      const changed = await c.env.DB.prepare(
        `UPDATE hosts SET status = 'active'
         WHERE id = ? AND status <> 'dead'
           AND last_seen_at IS NOT NULL AND last_seen_at >= ?
           AND consecutive_failures = 0 AND daemon_version IS NOT NULL
           AND reported_ram_total_mb IS NOT NULL
           AND reported_cpu_logical IS NOT NULL
           AND vcpu_allocated <= vcpu_capacity
           AND ram_allocated_mb <= ram_total_mb - ram_reserve_mb
           AND disk_allocated_gb <= disk_total_gb
           AND max_tenants >= (SELECT COUNT(*) FROM containers WHERE host_id = hosts.id)
           AND (host_type <> 'dedicated' OR dedicated_user_id IS NOT NULL)`,
      )
        .bind(host.id, Date.now() - HOST_HEARTBEAT_MAX_AGE_MS)
        .run();
      didChange = Boolean(changed.meta.changes);
    } else if (requestedStatus === "dead") {
      didChange = await retireHost(c.env, host, parsed.data.force === true);
    } else {
      const changed = await c.env.DB.prepare(
        "UPDATE hosts SET status = 'draining' WHERE id = ? AND status <> 'dead'",
      )
        .bind(host.id)
        .run();
      didChange = Boolean(changed.meta.changes);
    }
    if (!didChange) {
      return c.json({ error: "host state changed concurrently; reload and retry" }, 409);
    }
  }

  const updated = await getFleetHost(c.env, hostId);
  if (!updated) throw new Error("updated host row vanished");
  return c.json({ host: fleetHostView(updated) });
}

async function deregisterHost(c: Context<AppContext>): Promise<Response> {
  const host = await getFleetHost(c.env, requiredRouteId(c));
  if (!host) return c.json({ error: "unknown host" }, 404);
  if (host.status !== "dead" || host.tenant_count !== 0 || host.active_job_count !== 0) {
    return c.json({ error: "only an evacuated, empty dead host can be deregistered" }, 409);
  }
  const now = Date.now();
  const results = (await c.env.DB.batch([
    archiveHost(c.env, host, host.retired_at ?? now, "host deregistered"),
    c.env.DB.prepare(
      `DELETE FROM hosts WHERE id = ? AND status = 'dead'
       AND NOT EXISTS (SELECT 1 FROM containers WHERE host_id = hosts.id)`,
    ).bind(host.id),
  ])) as Array<{ meta: { changes?: number } }>;
  if (!results.at(-1)?.meta.changes) {
    return c.json({ error: "host state changed concurrently; reload and retry" }, 409);
  }
  return c.body(null, 204);
}

async function hostHistory(c: Context<AppContext>): Promise<Response> {
  const hostId = requiredRouteId(c);
  const history = await c.env.DB.prepare(
    `SELECT host_id AS id, generation, host_type AS hostType,
            management_hostname AS managementHostname,
            ram_total_mb AS ramTotalMb, ram_reserve_mb AS ramReserveMb,
            vcpu_capacity AS vcpuCapacity, disk_total_gb AS diskTotalGb,
            max_tenants AS maxTenants, daemon_version AS daemonVersion,
            reported_ram_total_mb AS reportedRamTotalMb,
            reported_cpu_logical AS reportedCpuLogical,
            joined_at AS joinedAt, last_seen_at AS lastSeenAt,
            retired_at AS retiredAt, retirement_reason AS retirementReason
     FROM host_history WHERE host_id = ? ORDER BY generation DESC`,
  ).bind(hostId).all<Record<string, unknown>>();
  const current = await getFleetHost(c.env, hostId);
  if (!current && history.results.length === 0) return c.json({ error: "unknown host" }, 404);
  return c.json({ history: history.results });
}

function servicePlan(subscriptionStatus: string) {
  if (!Object.hasOwn(SERVICE_PLANS, subscriptionStatus)) return null;
  return SERVICE_PLANS[subscriptionStatus as ServicePlan];
}

async function rehomeContainer(c: Context<AppContext>): Promise<Response> {
  const parsed = ContainerRehomeSchema.safeParse(await readJsonBody<unknown>(c));
  if (!parsed.success) {
    return c.json({ error: "confirmDataLoss must be true to re-home a container" }, 400);
  }
  const containerId = requiredRouteId(c);
  let container = await c.env.DB.prepare("SELECT * FROM containers WHERE id = ?")
    .bind(containerId)
    .first<ContainerRow>();
  if (!container) return c.json({ error: "unknown container" }, 404);
  const user = await c.env.DB.prepare(
    "SELECT status, subscription_status FROM users WHERE id = ?",
  ).bind(container.user_id).first<{ status: string; subscription_status: string }>();
  if (!user || user.status !== "active") {
    return c.json({ error: "only an active account can be re-homed" }, 409);
  }
  const target = servicePlan(user.subscription_status);
  if (!target) {
    return c.json({ error: "account subscription has no supported placement plan" }, 409);
  }
  const targetTier = TIERS[target.tier];

  if (!container.host_id) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE containers
         SET tier = ?, placement_class = ?, cpu = ?, ram_mb = ?, disk_gb = ?,
             status = 'waitlisted', status_detail = 'plan change awaiting placement',
             host_key_fingerprints = NULL, rehome_tier = NULL,
             rehome_placement_class = NULL, rehome_requested_at = NULL
         WHERE id = ? AND host_id IS NULL`,
      ).bind(
        target.tier,
        target.hostType,
        targetTier.cpu,
        targetTier.ramMb,
        targetTier.diskGb,
        container.id,
      ),
      c.env.DB.prepare(
        `INSERT INTO waitlist (user_id, requested_at, admitted_at) VALUES (?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET
           requested_at = excluded.requested_at, admitted_at = NULL`,
      ).bind(container.user_id, Date.now()),
    ]);
    container = (await c.env.DB.prepare("SELECT * FROM containers WHERE id = ?")
      .bind(container.id)
      .first<ContainerRow>()) ?? container;
    return c.json({ container: { id: container.id, status: container.status,
      tier: container.tier, placementClass: container.placement_class } }, 202);
  }

  const host = await getHost(c.env, container.host_id);
  if (!host) return c.json({ error: "container host is missing; force-retire its registry row" }, 409);
  if (host.status !== "active") {
    return c.json({
      error: host.status === "dead"
        ? "force-retire the dead host to evacuate its remaining containers"
        : "activate the host for an orderly re-home, or force-retire it if it is unreachable",
    }, 409);
  }
  const activeJob = await latestLifecycleJob(c.env, container.id);
  if (activeJob?.status === "queued" || activeJob?.status === "running") {
    return c.json({ error: "finish the active lifecycle job before re-homing" }, 409);
  }
  const claimed = await c.env.DB.prepare(
    `UPDATE containers
     SET rehome_tier = ?, rehome_placement_class = ?, rehome_requested_at = ?
     WHERE id = ? AND host_id = ? AND NOT EXISTS (
       SELECT 1 FROM jobs WHERE container_id = containers.id
         AND status IN ('queued','running')
         AND op IN ('provision','rebuild','start','stop','destroy','resize')
     )`,
  ).bind(target.tier, target.hostType, Date.now(), container.id, host.id).run();
  if (!claimed.meta.changes) {
    return c.json({ error: "container state changed concurrently; reload and retry" }, 409);
  }
  container = (await c.env.DB.prepare("SELECT * FROM containers WHERE id = ?")
    .bind(container.id)
    .first<ContainerRow>()) ?? container;
  try {
    const job = await enqueueJob(c.env, "destroy", container, host);
    return c.json({
      container: { id: container.id, targetTier: target.tier, targetHostType: target.hostType },
      job: { id: job.id, status: job.status },
    }, 202);
  } catch (error) {
    await c.env.DB.prepare(
      `UPDATE containers SET rehome_tier = NULL, rehome_placement_class = NULL,
         rehome_requested_at = NULL WHERE id = ?`,
    ).bind(container.id).run();
    return c.json({
      error: error instanceof Error ? error.message : "could not queue re-home destroy",
    }, 409);
  }
}

async function probeHost(c: Context<AppContext>): Promise<Response> {
  const host = await getFleetHost(c.env, requiredRouteId(c));
  if (!host) return c.json({ error: "unknown host" }, 404);
  if (host.status === "dead") return c.json({ error: "dead hosts cannot be probed" }, 409);

  let stats: StatsResponse;
  try {
    stats = await daemonStats(c.env, host);
    if (
      stats.hostType === undefined ||
      stats.version === undefined ||
      stats.cpuLogical === undefined
    ) {
      await c.env.DB.prepare(
        `UPDATE hosts
         SET last_seen_at = NULL, daemon_version = NULL,
             reported_ram_total_mb = NULL, reported_cpu_logical = NULL
         WHERE id = ? AND status IN ('active','draining','unhealthy')`,
      )
        .bind(host.id)
        .run();
      throw new Error("daemon does not report fleet class, release identity, and CPU hardware");
    }
  } catch (error) {
    await recordHostFailure(c.env, host.id);
    console.error(JSON.stringify({
      event: "fleet_probe_failed",
      hostId: host.id,
      error: error instanceof Error ? error.message : "probe failed",
    }));
    return c.json({ error: "daemon probe failed" }, 502);
  }
  await recordHostStats(c.env, host.id, stats, Date.now());
  const updated = await getFleetHost(c.env, host.id);
  if (!updated) throw new Error("probed host row vanished");
  return c.json({ host: fleetHostView(updated), stats });
}

export const fleetAdminRoutes = new Hono<AppContext>()
  .get("/api/admin/hosts", async (c) => {
    const failure = await fleetAuthFailure(c);
    if (failure) return failure;
    const hosts = await c.env.DB.prepare(
      `SELECT h.*,
         (SELECT COUNT(*) FROM containers ct WHERE ct.host_id = h.id) AS tenant_count,
         (SELECT COUNT(*)
          FROM jobs j JOIN containers ct ON ct.id = j.container_id
          WHERE ct.host_id = h.id AND j.status IN ('queued','running')) AS active_job_count
       FROM hosts h
       ORDER BY h.host_type, h.id`,
    ).all<FleetHostRow>();
    c.header("cache-control", "no-store");
    return c.json({ hosts: hosts.results.map(fleetHostView) });
  })
  .post("/api/admin/hosts", async (c) => {
    const failure = await fleetAuthFailure(c);
    if (failure) return failure;
    return registerHost(c);
  })
  .get("/api/admin/hosts/:id/history", async (c) => {
    const failure = await fleetAuthFailure(c);
    if (failure) return failure;
    return hostHistory(c);
  })
  .put("/api/admin/hosts/:id", async (c) => {
    const failure = await fleetAuthFailure(c);
    if (failure) return failure;
    return replaceDeadHost(c);
  })
  .patch("/api/admin/hosts/:id", async (c) => {
    const failure = await fleetAuthFailure(c);
    if (failure) return failure;
    return updateHost(c);
  })
  .delete("/api/admin/hosts/:id", async (c) => {
    const failure = await fleetAuthFailure(c);
    if (failure) return failure;
    return deregisterHost(c);
  })
  .post("/api/admin/hosts/:id/probe", async (c) => {
    const failure = await fleetAuthFailure(c);
    if (failure) return failure;
    return probeHost(c);
  })
  .post("/api/admin/containers/:id/rehome", async (c) => {
    const failure = await fleetAuthFailure(c);
    if (failure) return failure;
    return rehomeContainer(c);
  });
