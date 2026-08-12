import {
  SERVICE_PLANS,
  TIERS,
  type Agent,
  type ServicePlan,
  type Tier,
} from "@workbench/contract";
import { allocatePort, NoFreePortsError } from "./ports.js";
import {
  cpuReservation,
  diskReservationGb,
  HOST_HEARTBEAT_MAX_AGE_MS,
  pickHost,
} from "./capacity.js";
import {
  enqueueJob,
  getContainerForUser,
  HostJobAdmissionError,
} from "./jobs.js";
import { accountAccess, effectiveEntitlementForUser } from "./entitlements.js";
import type { Bindings, ContainerRow, UserRow } from "./types.js";

interface ProvisionInput {
  agents: Agent[];
  githubRepos?: string[];
}

export class ProvisioningNotAllowedError extends Error {
  constructor(subscriptionStatus: string) {
    super(`account subscription cannot provision: ${subscriptionStatus}`);
    this.name = "ProvisioningNotAllowedError";
  }
}

export function servicePlanForSubscription(subscriptionStatus: string) {
  if (Object.hasOwn(SERVICE_PLANS, subscriptionStatus)) {
    return SERVICE_PLANS[subscriptionStatus as ServicePlan];
  }
  throw new ProvisioningNotAllowedError(subscriptionStatus);
}

/**
 * Create the container row and dispatch the provision job. Returns the
 * container in `provisioning` state, or `waitlisted` when no host has
 * capacity. The reconciler admits the FIFO waitlist when capacity returns.
 */
export async function startProvision(
  env: Bindings,
  user: UserRow,
  input: ProvisionInput,
  requestedTier: Tier,
): Promise<ContainerRow> {
  const entitlement = await effectiveEntitlementForUser(env, user);
  const access = accountAccess(user, entitlement);
  if (
    (requestedTier === "free" && !access.verified) ||
    (requestedTier === "paid" && !access.premium)
  ) {
    throw new ProvisioningNotAllowedError(user.subscription_status);
  }
  const servicePlan = requestedTier === "free"
    ? servicePlanForSubscription("free")
    : servicePlanForSubscription(entitlement.plan ?? "");
  const tierName = servicePlan.tier;
  const tier = TIERS[tierName];
  const placementClass = servicePlan.placementClass;
  const placementMode = servicePlan.tenancyMode;
  const containerId = crypto.randomUUID();
  const now = Date.now();
  const agents = JSON.stringify(input.agents);
  const githubRepos = JSON.stringify(input.githubRepos ?? []);
  const reservedDiskGb = diskReservationGb(tier.diskGb);
  const reservedCpu = cpuReservation(tierName);

  // D1 batches are transactional. Capacity is checked in the INSERT itself,
  // then `changes()` gates host accounting on that INSERT winning. This avoids
  // oversubscription when two signups race for the last slot. Only a host-port
  // conflict is ignored and retried; unrelated database failures stay visible.
  const hostsWithoutPorts: string[] = [];
  let reservationAttempts = 0;
  while (reservationAttempts < 4) {
    const host = await pickHost(
      env,
      {
        userId: user.id,
        tenancyMode: placementMode,
        cpu: reservedCpu,
        ramMb: tier.ramMb,
        diskGb: reservedDiskGb,
      },
      Date.now,
      hostsWithoutPorts,
    );
    if (!host) break;
    let port: number;
    try {
      port = await allocatePort(env, host.id);
    } catch (error) {
      if (!(error instanceof NoFreePortsError)) throw error;
      hostsWithoutPorts.push(host.id);
      continue;
    }
    reservationAttempts += 1;
    const heartbeatCutoff = Date.now() - HOST_HEARTBEAT_MAX_AGE_MS;
    let results: Array<{ meta?: { changes?: number } }>;
    try {
      results = (await env.DB.batch([
        env.DB.prepare(
          `WITH request(cpu, ram_mb, disk_gb) AS (
             VALUES (?, ?, ?)
           )
           INSERT INTO containers
             (id, user_id, host_id, ssh_port, agents, github_repos, tier,
              placement_class, placement_mode, cpu, ram_mb, disk_gb, status, created_at)
           SELECT ?, ?, h.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?
           FROM host_availability h, request r
           WHERE h.id = ? AND h.status = 'active'
             AND h.tenancy_mode = ?
             AND (h.tenancy_mode <> 'dedicated' OR h.dedicated_user_id = ?)
             AND h.tenant_slots_available > 0
             AND h.vcpu_available >= r.cpu
             AND h.ram_available_mb >= r.ram_mb
             AND h.disk_available_gb >= r.disk_gb
             AND h.last_seen_at IS NOT NULL AND h.last_seen_at >= ?
             AND h.consecutive_failures = 0
             AND h.daemon_version IS NOT NULL
             AND h.reported_ram_total_mb IS NOT NULL
             AND h.reported_cpu_logical IS NOT NULL
           ON CONFLICT(host_id, ssh_port) DO NOTHING`,
        ).bind(
          reservedCpu,
          tier.ramMb,
          reservedDiskGb,
          containerId,
          user.id,
          port,
          agents,
          githubRepos,
          tierName,
          placementClass,
          placementMode,
          tier.cpu,
          tier.ramMb,
          tier.diskGb,
          now,
          host.id,
          placementMode,
          user.id,
          heartbeatCutoff,
        ),
        env.DB.prepare(
          `UPDATE hosts
           SET vcpu_allocated = vcpu_allocated + ?,
               ram_allocated_mb = ram_allocated_mb + ?,
               disk_allocated_gb = disk_allocated_gb + ?
           WHERE id = ? AND changes() = 1`,
        ).bind(reservedCpu, tier.ramMb, reservedDiskGb, host.id),
      ])) as Array<{ meta?: { changes?: number } }>;
    } catch (error) {
      // A concurrent request for the same account may win its user_id unique
      // constraint. Return that row, but never reinterpret other failures as
      // capacity or port contention.
      const existing = await getContainerForUser(env, user.id);
      if (existing) return existing;
      throw error;
    }

    if (!results[0]?.meta?.changes) {
      const existing = await getContainerForUser(env, user.id);
      if (existing) return existing;
      continue;
    }
    const container = await getContainerForUser(env, user.id);
    if (!container) throw new Error("container row vanished");
    try {
      await enqueueJob(env, "provision", container, host);
    } catch (error) {
      const statusDetail = error instanceof HostJobAdmissionError
        ? "host entered maintenance before provisioning could be queued"
        : "provisioning could not be queued";
      await env.DB.prepare(
        "UPDATE containers SET status = 'error', status_detail = ? WHERE id = ?",
      )
        .bind(statusDetail, container.id)
        .run();
      // The reservation is valid and can be retried after the host is active.
      // Return a stable API result instead of turning this maintenance race
      // into an opaque 500 after the user's container row was already created.
      if (error instanceof HostJobAdmissionError) {
        return (await getContainerForUser(env, user.id)) ?? {
          ...container,
          status: "error",
          status_detail: statusDetail,
        };
      }
      throw error;
    }
    return (await getContainerForUser(env, user.id)) ?? container;
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO containers
           (id, user_id, agents, github_repos, tier, placement_class, placement_mode,
            cpu, ram_mb, disk_gb, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waitlisted', ?)`,
      ).bind(
        containerId,
        user.id,
        agents,
        githubRepos,
        tierName,
        placementClass,
        placementMode,
        tier.cpu,
        tier.ramMb,
        tier.diskGb,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO waitlist (user_id, requested_at, admitted_at) VALUES (?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET requested_at = excluded.requested_at, admitted_at = NULL`,
      ).bind(user.id, now),
    ]);
  } catch (error) {
    const existing = await getContainerForUser(env, user.id);
    if (existing) return existing;
    throw error;
  }
  const row = await getContainerForUser(env, user.id);
  if (!row) throw new Error("container row vanished");
  return row;
}
