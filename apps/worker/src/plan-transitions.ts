import {
  HOST_RAM_OVERCOMMIT_DENOMINATOR,
  HOST_RAM_OVERCOMMIT_NUMERATOR,
  MIXED_TIER_SHARED_CAPABILITY,
  TIERS,
  type Tier,
} from "@workbench/contract";
import {
  cpuReservation,
  diskReservationGb,
  HOST_HEARTBEAT_MAX_AGE_MS,
} from "./capacity.js";
import { effectiveEntitlementForUser } from "./entitlements.js";
import {
  enqueueJob,
  getContainerForUser,
  getHost,
  HostJobAdmissionError,
  LifecycleJobConflictError,
} from "./jobs.js";
import type {
  Bindings,
  ContainerPlanTransitionRow,
  ContainerRow,
  UserRow,
} from "./types.js";

export type PlanTransitionResult =
  | "not_needed"
  | "waiting_capacity"
  | "stopping"
  | "resizing"
  | "ineligible"
  | "conflict";

function transitionForContainer(
  env: Bindings,
  containerId: string,
): Promise<ContainerPlanTransitionRow | null> {
  return env.DB.prepare("SELECT * FROM container_plan_transitions WHERE container_id = ?")
    .bind(containerId)
    .first<ContainerPlanTransitionRow>();
}

async function loadActiveUser(env: Bindings, userId: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'")
    .bind(userId)
    .first<UserRow>();
}

function priorStatus(container: ContainerRow): "running" | "stopped" | null {
  if (container.status === "running" || container.status === "stopped") return container.status;
  return null;
}

async function createTransition(
  env: Bindings,
  container: ContainerRow,
  toTier: Tier,
  at: number,
): Promise<ContainerPlanTransitionRow | null> {
  const prior = priorStatus(container);
  if (!prior) return transitionForContainer(env, container.id);
  // Incus/ZFS volumes are never shrunk as part of an automated plan change.
  // This covers Paid-to-Free downgrades as well as a later upgrade of a Free
  // container that already owns a grandfathered allocation.
  const targetDiskGb = Math.max(container.disk_gb, TIERS[toTier].diskGb);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO container_plan_transitions
         (container_id, from_tier, to_tier, target_disk_gb, prior_status, state,
          requested_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'requested', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM jobs WHERE container_id = ?
           AND status IN ('queued','running')
           AND op IN ('provision','rebuild','start','stop','destroy','resize')
       )
       ON CONFLICT(container_id) DO NOTHING`,
    ).bind(
      container.id,
      container.tier,
      toTier,
      targetDiskGb,
      prior,
      at,
      at,
      container.id,
    ),
    env.DB.prepare(
      `UPDATE containers
       SET status = 'upgrade_pending', status_detail = ?
       WHERE id = ? AND status = ? AND changes() = 1`,
    ).bind(
      toTier === "paid"
        ? "paid plan confirmed; waiting to apply larger resources"
        : "paid access ended; waiting to apply free resources",
      container.id,
      prior,
    ),
  ]);
  return transitionForContainer(env, container.id);
}

/**
 * A Paid-to-Free transition deliberately stops a running workbench before
 * lowering its cgroup limits. The transition row remains the durable intent;
 * stop success changes `prior_status` to stopped, after which the normal
 * resize path can safely continue without exposing a start action in between.
 */
async function stopRunningDowngrade(
  env: Bindings,
  container: ContainerRow,
  transition: ContainerPlanTransitionRow,
): Promise<PlanTransitionResult | null> {
  if (transition.to_tier !== "free" || transition.prior_status !== "running") return null;

  const activeJob = await env.DB.prepare(
    `SELECT op FROM jobs
     WHERE container_id = ? AND status IN ('queued','running')
       AND op IN ('provision','rebuild','start','stop','destroy','resize')
     ORDER BY rowid DESC LIMIT 1`,
  ).bind(container.id).first<{ op: string }>();
  if (activeJob) return "stopping";
  if (!container.host_id) return "waiting_capacity";

  const host = await getHost(env, container.host_id);
  if (!host || host.status !== "active") return "waiting_capacity";
  try {
    await enqueueJob(env, "stop", container, host);
  } catch (error) {
    if (error instanceof LifecycleJobConflictError) return "stopping";
    if (error instanceof HostJobAdmissionError) return "waiting_capacity";
    throw error;
  }
  return "stopping";
}

async function reserveTransition(
  env: Bindings,
  container: ContainerRow,
  transition: ContainerPlanTransitionRow,
  at: number,
): Promise<boolean> {
  if (!container.host_id) return false;
  const from = TIERS[transition.from_tier];
  const to = TIERS[transition.to_tier];
  const requestedCpu = Math.max(0, cpuReservation(transition.to_tier) - cpuReservation(transition.from_tier));
  const requestedRam = Math.max(0, to.ramMb - from.ramMb);
  const requestedDisk = Math.max(
    0,
    diskReservationGb(transition.target_disk_gb) - diskReservationGb(container.disk_gb),
  );
  const heartbeatCutoff = at - HOST_HEARTBEAT_MAX_AGE_MS;
  const mixedCapability = `%"${MIXED_TIER_SHARED_CAPABILITY}"%`;

  const results = (await env.DB.batch([
    env.DB.prepare(
      `UPDATE container_plan_transitions
       SET state = 'reserving', updated_at = ?, last_error_code = NULL
       WHERE container_id = ?
         AND state IN ('requested','waiting_capacity','failed_retryable')
         AND NOT EXISTS (
           SELECT 1 FROM jobs WHERE container_id = ?
             AND status IN ('queued','running')
             AND op IN ('provision','rebuild','start','stop','destroy','resize')
         )
         AND (
           (? = 'free' AND EXISTS (
             SELECT 1 FROM users u
             WHERE u.id = ? AND u.verified_at IS NOT NULL
               AND u.verification_method IN ('world_id','invite','development')
           ))
           OR
           (? = 'paid' AND EXISTS (
             SELECT 1 FROM account_entitlements e
             WHERE e.user_id = ? AND e.plan IN ('paid','dedicated')
               AND (
                 (e.source = 'manual' AND (e.service_until IS NULL OR e.service_until > ?))
                 OR
                 (e.source = 'stripe' AND e.state NOT IN ('pending','expired')
                   AND (e.trial_until > ? OR e.service_until > ? OR e.grace_until > ?))
               )
           ))
         )`,
    ).bind(
      at,
      container.id,
      container.id,
      transition.to_tier,
      container.user_id,
      transition.to_tier,
      container.user_id,
      at,
      at,
      at,
      at,
    ),
    env.DB.prepare(
      `UPDATE hosts
       SET vcpu_allocated = vcpu_allocated + ?,
           ram_allocated_mb = ram_allocated_mb + ?,
           disk_allocated_gb = disk_allocated_gb + ?
       WHERE id = ? AND changes() = 1
         AND status = 'active'
         AND tenancy_mode = 'shared'
         AND daemon_capabilities LIKE ?
         AND vcpu_allocated + ? <= vcpu_capacity
         AND (ram_allocated_mb + ?) * ${HOST_RAM_OVERCOMMIT_DENOMINATOR} <=
             (ram_total_mb - ram_reserve_mb) * ${HOST_RAM_OVERCOMMIT_NUMERATOR}
         AND disk_allocated_gb + ? <= disk_total_gb
         AND last_seen_at IS NOT NULL AND last_seen_at >= ?
         AND consecutive_failures = 0
         AND daemon_version IS NOT NULL
         AND reported_ram_total_mb IS NOT NULL
         AND reported_cpu_logical IS NOT NULL`,
    ).bind(
      requestedCpu,
      requestedRam,
      requestedDisk,
      container.host_id,
      mixedCapability,
      requestedCpu,
      requestedRam,
      requestedDisk,
      heartbeatCutoff,
    ),
    env.DB.prepare(
      `UPDATE container_plan_transitions
       SET state = 'resizing', reserved_cpu = reserved_cpu + ?,
           reserved_ram_mb = reserved_ram_mb + ?,
           reserved_disk_gb = reserved_disk_gb + ?, updated_at = ?
       WHERE container_id = ? AND state = 'reserving' AND changes() = 1`,
    ).bind(requestedCpu, requestedRam, requestedDisk, at, container.id),
  ])) as Array<{ meta?: { changes?: number } }>;

  if (results[1]?.meta?.changes) return true;
  await env.DB.prepare(
    `UPDATE container_plan_transitions
     SET state = 'waiting_capacity', updated_at = ?
     WHERE container_id = ? AND state = 'reserving'`,
  ).bind(at, container.id).run();
  return false;
}

async function dispatchResize(
  env: Bindings,
  container: ContainerRow,
  at: number,
): Promise<PlanTransitionResult> {
  const defer = async () => {
    await env.DB.prepare(
      `UPDATE container_plan_transitions
       SET state = 'failed_retryable', updated_at = ?, last_error_code = 'resize_dispatch_deferred'
       WHERE container_id = ? AND state = 'resizing'
         AND NOT EXISTS (
           SELECT 1 FROM jobs WHERE container_id = ?
             AND status IN ('queued','running')
             AND op IN ('provision','rebuild','start','stop','destroy','resize')
         )`,
    ).bind(at, container.id, container.id).run();
  };
  if (!container.host_id) {
    await defer();
    return "waiting_capacity";
  }
  const host = await getHost(env, container.host_id);
  if (!host || host.status !== "active") {
    await defer();
    return "waiting_capacity";
  }
  try {
    await enqueueJob(env, "resize", container, host);
  } catch (error) {
    await defer();
    throw error;
  }
  return "resizing";
}

/**
 * Idempotently realize a paid/free desired tier in place. Positive resource
 * deltas are reserved before a resize is dispatched; the actual row is left
 * unchanged until daemon success.
 */
export async function requestPlanTransition(
  env: Bindings,
  userId: string,
  toTier: Tier,
  at = Date.now(),
): Promise<PlanTransitionResult> {
  const user = await loadActiveUser(env, userId);
  if (!user) return "ineligible";
  const entitlement = await effectiveEntitlementForUser(env, user, at);
  if (!entitlement.eligible || entitlement.plan === null) return "ineligible";
  const desiredTier = entitlement.plan === "free" ? "free" : "paid";
  if (desiredTier !== toTier) return "ineligible";

  let container = await getContainerForUser(env, userId);
  if (!container) return "not_needed";
  let transition = await transitionForContainer(env, container.id);
  if (transition?.state === "complete" || transition?.state === "cancelled") {
    await env.DB.prepare("DELETE FROM container_plan_transitions WHERE container_id = ?")
      .bind(container.id)
      .run();
    transition = null;
  }
  if (transition && transition.to_tier !== toTier) {
    if (!(await cancelUnreservedPlanTransition(env, container.id, at))) return "conflict";
    transition = null;
    container = (await getContainerForUser(env, userId)) ?? container;
  }
  if (container.tier === toTier) return "not_needed";
  transition ??= await createTransition(env, container, toTier, at);
  if (!transition) return "conflict";
  if (transition.state === "resizing") return "resizing";

  container = (await getContainerForUser(env, userId)) ?? container;
  const stopping = await stopRunningDowngrade(env, container, transition);
  if (stopping) return stopping;
  if (transition.state === "failed_retryable" && transition.reserved_cpu +
      transition.reserved_ram_mb + transition.reserved_disk_gb > 0) {
    await env.DB.prepare(
      `UPDATE container_plan_transitions
       SET state = 'resizing', updated_at = ?, last_error_code = NULL
       WHERE container_id = ? AND state = 'failed_retryable'`,
    ).bind(at, container.id).run();
    return dispatchResize(env, container, at);
  }
  if (!(await reserveTransition(env, container, transition, at))) return "waiting_capacity";
  return dispatchResize(env, container, at);
}

export async function requestPaidUpgrade(
  env: Bindings,
  userId: string,
  at = Date.now(),
): Promise<PlanTransitionResult> {
  return requestPlanTransition(env, userId, "paid", at);
}

/** Cancel only transitions that have not claimed host resources or reached Incus. */
export async function cancelUnreservedPlanTransition(
  env: Bindings,
  containerId: string,
  at = Date.now(),
): Promise<boolean> {
  const transition = await transitionForContainer(env, containerId);
  if (
    !transition ||
    transition.reserved_cpu !== 0 ||
    transition.reserved_ram_mb !== 0 ||
    transition.reserved_disk_gb !== 0 ||
    !["requested", "waiting_capacity"].includes(transition.state)
  ) return false;
  const results = (await env.DB.batch([
    env.DB.prepare(
      `UPDATE container_plan_transitions
       SET state = 'cancelled', updated_at = ?, last_error_code = NULL
       WHERE container_id = ? AND state IN ('requested','waiting_capacity')
         AND reserved_cpu = 0 AND reserved_ram_mb = 0 AND reserved_disk_gb = 0`,
    ).bind(at, containerId),
    env.DB.prepare(
      `UPDATE containers SET status = ?, status_detail = NULL
       WHERE id = ? AND status = 'upgrade_pending' AND changes() = 1`,
    ).bind(transition.prior_status, containerId),
  ])) as Array<{ meta?: { changes?: number } }>;
  return Boolean(results[0]?.meta?.changes);
}

export async function retryPlanTransitions(
  env: Bindings,
  at = Date.now(),
): Promise<void> {
  const transitions = await env.DB.prepare(
    `SELECT c.user_id, t.to_tier
     FROM container_plan_transitions t
     JOIN containers c ON c.id = t.container_id
     WHERE t.state IN ('requested','waiting_capacity','failed_retryable')
     ORDER BY t.requested_at, t.container_id
     LIMIT 20`,
  ).all<{ user_id: string; to_tier: Tier }>();
  for (const transition of transitions.results) {
    try {
      await requestPlanTransition(env, transition.user_id, transition.to_tier, at);
    } catch (error) {
      console.error(JSON.stringify({
        event: "plan_transition_retry_failed",
        userId: transition.user_id,
        error: error instanceof Error ? error.name : "retry_failed",
      }));
    }
  }
}
