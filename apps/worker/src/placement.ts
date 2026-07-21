import { TIERS, type Agent } from "@workbench/contract";
import { allocatePort } from "./ports.js";
import {
  diskReservationGb,
  HOST_HEARTBEAT_MAX_AGE_MS,
  pickHost,
} from "./capacity.js";
import { enqueueJob, getContainerForUser } from "./jobs.js";
import type { Bindings, ContainerRow, UserRow } from "./types.js";

interface ProvisionInput {
  agents: Agent[];
  githubRepos?: string[];
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
): Promise<ContainerRow> {
  const tier = TIERS.free;
  const containerId = crypto.randomUUID();
  const now = Date.now();
  const agents = JSON.stringify(input.agents);
  const githubRepos = JSON.stringify(input.githubRepos ?? []);
  const reservedDiskGb = diskReservationGb(tier.diskGb);

  // D1 batches are transactional. Capacity is checked in the INSERT itself,
  // then `changes()` gates host accounting on that INSERT winning. This avoids
  // oversubscription when two signups race for the last slot. A unique-port
  // collision rolls the batch back and is retried with a fresh allocation.
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = await pickHost(env, tier.cpu, tier.ramMb, reservedDiskGb);
    if (!host) break;
    const port = await allocatePort(env, host.id);
    const heartbeatCutoff = Date.now() - HOST_HEARTBEAT_MAX_AGE_MS;
    let results: Array<{ meta?: { changes?: number } }>;
    try {
      results = (await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO containers
             (id, user_id, host_id, ssh_port, agents, github_repos, tier, cpu, ram_mb, disk_gb, status, created_at)
           SELECT ?, ?, h.id, ?, ?, ?, 'free', ?, ?, ?, 'provisioning', ?
           FROM hosts h
           WHERE h.id = ? AND h.status = 'active'
             AND h.vcpu_capacity - h.vcpu_allocated >= ?
             AND h.ram_total_mb - h.ram_reserve_mb - h.ram_allocated_mb >= ?
             AND h.disk_total_gb - h.disk_allocated_gb >= ?
             AND h.last_seen_at IS NOT NULL AND h.last_seen_at >= ?
             AND h.consecutive_failures = 0`,
        ).bind(
          containerId,
          user.id,
          port,
          agents,
          githubRepos,
          tier.cpu,
          tier.ramMb,
          tier.diskGb,
          now,
          host.id,
          tier.cpu,
          tier.ramMb,
          reservedDiskGb,
          heartbeatCutoff,
        ),
        env.DB.prepare(
          `UPDATE hosts
           SET vcpu_allocated = vcpu_allocated + ?,
               ram_allocated_mb = ram_allocated_mb + ?,
               disk_allocated_gb = disk_allocated_gb + ?
           WHERE id = ? AND changes() = 1`,
        ).bind(tier.cpu, tier.ramMb, reservedDiskGb, host.id),
      ])) as Array<{ meta?: { changes?: number } }>;
    } catch (error) {
      // Only reservation conflicts are idempotent/retryable here. Errors after
      // a successful placement must remain visible to the caller and user.
      const existing = await getContainerForUser(env, user.id);
      if (existing) return existing;
      if (attempt === 3) throw error;
      continue;
    }

    if (!results[0]?.meta?.changes) continue;
    const container = await getContainerForUser(env, user.id);
    if (!container) throw new Error("container row vanished");
    try {
      await enqueueJob(env, "provision", container, host);
    } catch (error) {
      await env.DB.prepare(
        "UPDATE containers SET status = 'error', status_detail = 'provisioning could not be queued' WHERE id = ?",
      )
        .bind(container.id)
        .run();
      throw error;
    }
    return (await getContainerForUser(env, user.id)) ?? container;
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO containers (id, user_id, agents, github_repos, tier, cpu, ram_mb, disk_gb, status, created_at)
         VALUES (?, ?, ?, ?, 'free', ?, ?, ?, 'waitlisted', ?)`,
      ).bind(containerId, user.id, agents, githubRepos, tier.cpu, tier.ramMb, tier.diskGb, now),
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
