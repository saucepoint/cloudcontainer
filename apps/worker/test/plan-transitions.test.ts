import { afterEach, describe, expect, it, vi } from "vitest";
import { getContainerForUser, getJob, refreshJob } from "../src/jobs.js";
import {
  cancelPendingDowngradeForRestoredPaidAccess,
  cancelUnreservedPlanTransition,
  requestPaidUpgrade,
  requestPlanTransition,
  retryPlanTransitions,
} from "../src/plan-transitions.js";
import type { ContainerPlanTransitionRow } from "../src/types.js";
import {
  fakeDaemon,
  makeEnv,
  seedContainer,
  seedHost,
  seedUser,
  stubFetch,
} from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

async function transition(
  env: ReturnType<typeof makeEnv>["env"],
): Promise<ContainerPlanTransitionRow | null> {
  return env.DB.prepare(
    "SELECT * FROM container_plan_transitions WHERE container_id = 'container-1'",
  ).first<ContainerPlanTransitionRow>();
}

describe("in-place plan transitions", () => {
  it("reserves only the free-to-paid delta and applies it once on success", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "paid");
    await seedHost(env, {
      vcpu_allocated: 1,
      ram_allocated_mb: 1536,
      disk_allocated_gb: 10,
    });
    await seedContainer(env);
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    await expect(requestPaidUpgrade(env, "user-1", 10_000)).resolves.toBe("resizing");
    await expect(requestPaidUpgrade(env, "user-1", 10_001)).resolves.toBe("resizing");

    expect(await transition(env)).toMatchObject({
      from_tier: "free",
      to_tier: "paid",
      prior_status: "running",
      state: "resizing",
      reserved_cpu: 1,
      reserved_ram_mb: 2560,
      reserved_disk_gb: 6,
    });
    expect(await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "free",
      status: "upgrade_pending",
      cpu: 1,
      ram_mb: 1536,
      disk_gb: 5,
    });
    expect(daemon.submitted).toHaveLength(1);
    expect(daemon.submitted[0]).toMatchObject({
      op: "resize",
      spec: { tier: "paid", cpu: 2, ramMb: 4096, diskGb: 8 },
    });

    const jobId = String(daemon.submitted[0]?.jobId);
    const job = await getJob(env, jobId);
    if (!job) throw new Error("resize job missing");
    await refreshJob(env, job);

    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "paid",
      placement_class: "regular",
      placement_mode: "shared",
      status: "running",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
    });
    expect(await transition(env)).toMatchObject({ state: "complete" });
    expect(await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
  });

  it("preserves the usable free container while an upgrade waits for capacity", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "paid");
    await seedHost(env, {
      vcpu_capacity: 1,
      vcpu_allocated: 1,
      ram_allocated_mb: 1536,
      disk_allocated_gb: 10,
    });
    await seedContainer(env);

    await expect(requestPaidUpgrade(env, "user-1", 20_000)).resolves
      .toBe("waiting_capacity");
    expect(await transition(env)).toMatchObject({
      state: "waiting_capacity",
      reserved_cpu: 0,
      reserved_ram_mb: 0,
      reserved_disk_gb: 0,
      prior_status: "running",
    });
    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "free",
      status: "upgrade_pending",
      cpu: 1,
      ram_mb: 1536,
      disk_gb: 5,
      host_id: "host-1",
    });
    expect((await env.DB.prepare("SELECT * FROM jobs").all()).results).toEqual([]);

    await expect(cancelUnreservedPlanTransition(env, "container-1", 20_001))
      .resolves.toBe(true);
    expect(await transition(env)).toMatchObject({ state: "cancelled" });
    expect(await getContainerForUser(env, "user-1")).toMatchObject({ status: "running" });
  });

  it("retries a failed resize without reserving the positive delta twice", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "paid");
    await seedHost(env, {
      vcpu_allocated: 1,
      ram_allocated_mb: 1536,
      disk_allocated_gb: 10,
    });
    await seedContainer(env);
    const failing = fakeDaemon({ failWith: "transient resize failure" });
    stubFetch(failing.route);

    expect(await requestPaidUpgrade(env, "user-1", 30_000)).toBe("resizing");
    const failedJob = await getJob(env, String(failing.submitted[0]?.jobId));
    if (!failedJob) throw new Error("resize job missing");
    await refreshJob(env, failedJob);
    expect(await transition(env)).toMatchObject({
      state: "failed_retryable",
      reserved_cpu: 1,
      reserved_ram_mb: 2560,
      reserved_disk_gb: 6,
    });

    vi.unstubAllGlobals();
    const succeeding = fakeDaemon();
    stubFetch(succeeding.route);
    await retryPlanTransitions(env, 30_001);
    expect(succeeding.submitted).toHaveLength(1);
    expect(await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });

    const retryJob = await getJob(env, String(succeeding.submitted[0]?.jobId));
    if (!retryJob) throw new Error("retry resize job missing");
    await refreshJob(env, retryJob);
    expect(await transition(env)).toMatchObject({ state: "complete" });
    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "paid",
      status: "running",
    });
  });

  it("stops a running paid container before downgrading it in place", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "free");
    await seedHost(env, {
      host_type: "regular",
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      tier: "paid",
      placement_class: "regular",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
      status: "running",
    });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    expect(await requestPlanTransition(env, "user-1", "free", 35_000)).toBe("stopping");
    expect(daemon.submitted).toMatchObject([{
      op: "stop",
      containerId: "container-1",
    }]);
    expect(await transition(env)).toMatchObject({
      to_tier: "free",
      target_disk_gb: 8,
      prior_status: "running",
      state: "requested",
    });
    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "paid",
      status: "upgrade_pending",
      disk_gb: 8,
    });

    const stopJob = await getJob(env, String(daemon.submitted[0]?.jobId));
    if (!stopJob) throw new Error("downgrade stop job missing");
    await refreshJob(env, stopJob);
    expect(await transition(env)).toMatchObject({
      prior_status: "stopped",
      state: "requested",
    });
    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "paid",
      status: "upgrade_pending",
    });

    expect(await requestPlanTransition(env, "user-1", "free", 35_001)).toBe("resizing");
    expect(daemon.submitted).toHaveLength(2);
    expect(daemon.submitted[1]).toMatchObject({
      op: "resize",
      containerId: "container-1",
      spec: { tier: "free", cpu: 1, ramMb: 1536, diskGb: 8 },
    });
    const resizeJob = await getJob(env, String(daemon.submitted[1]?.jobId));
    if (!resizeJob) throw new Error("downgrade resize job missing");
    await refreshJob(env, resizeJob);

    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "free",
      status: "stopped",
      cpu: 1,
      ram_mb: 1536,
      disk_gb: 8,
      storage_grandfathered: 1,
    });
    expect(await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({
      vcpu_allocated: 1,
      ram_allocated_mb: 1536,
      disk_allocated_gb: 16,
    });
  });

  it("retries a failed downgrade stop before applying lower limits", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "free");
    await seedHost(env, {
      host_type: "regular",
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      tier: "paid",
      placement_class: "regular",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
    });
    const failing = fakeDaemon({ failWith: "transient stop failure" });
    stubFetch(failing.route);

    expect(await requestPlanTransition(env, "user-1", "free", 36_000)).toBe("stopping");
    const failedStop = await getJob(env, String(failing.submitted[0]?.jobId));
    if (!failedStop) throw new Error("downgrade stop job missing");
    await refreshJob(env, failedStop);
    expect(await transition(env)).toMatchObject({
      prior_status: "running",
      state: "failed_retryable",
      last_error_code: "downgrade_stop_failed",
    });

    vi.unstubAllGlobals();
    const succeeding = fakeDaemon();
    stubFetch(succeeding.route);
    await retryPlanTransitions(env, 36_001);
    expect(succeeding.submitted).toMatchObject([{ op: "stop" }]);
    const retriedStop = await getJob(env, String(succeeding.submitted[0]?.jobId));
    if (!retriedStop) throw new Error("retried downgrade stop job missing");
    await refreshJob(env, retriedStop);

    await retryPlanTransitions(env, 36_002);
    expect(succeeding.submitted).toHaveLength(2);
    expect(succeeding.submitted[1]).toMatchObject({
      op: "resize",
      spec: { tier: "free", ramMb: 1536, diskGb: 8 },
    });
  });

  it("cancels a pending downgrade when paid access is restored after the stop", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "free");
    await seedHost(env, {
      host_type: "regular",
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      tier: "paid",
      placement_class: "regular",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
    });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    expect(await requestPlanTransition(env, "user-1", "free", 36_500)).toBe("stopping");
    const stopJob = await getJob(env, String(daemon.submitted[0]?.jobId));
    if (!stopJob) throw new Error("downgrade stop job missing");

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET subscription_status = 'paid', updated_at = ? WHERE id = 'user-1'",
      ).bind(36_501),
      env.DB.prepare(
        `INSERT INTO account_entitlements
           (user_id, plan, source, state, source_ref, updated_at)
         VALUES ('user-1', 'paid', 'manual', 'manual', 'test-operator', ?)`,
      ).bind(36_501),
    ]);

    expect(await cancelPendingDowngradeForRestoredPaidAccess(env, "user-1", 36_502))
      .toBe(false);
    expect(await transition(env)).toMatchObject({ state: "requested" });

    await refreshJob(env, stopJob);
    expect(await cancelPendingDowngradeForRestoredPaidAccess(env, "user-1", 36_503))
      .toBe(true);
    expect(await transition(env)).toMatchObject({ state: "cancelled" });
    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "paid",
      status: "stopped",
      disk_gb: 8,
    });
    expect(daemon.submitted).toHaveLength(1);
  });

  it("never shrinks a grandfathered free disk during a later paid upgrade", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "paid");
    await seedHost(env, {
      vcpu_allocated: 1,
      ram_allocated_mb: 1536,
      disk_allocated_gb: 20,
    });
    await seedContainer(env, { disk_gb: 10 });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    expect(await requestPaidUpgrade(env, "user-1", 37_000)).toBe("resizing");
    expect(await transition(env)).toMatchObject({
      from_tier: "free",
      to_tier: "paid",
      target_disk_gb: 10,
      reserved_disk_gb: 0,
    });
    expect(daemon.submitted[0]).toMatchObject({
      op: "resize",
      spec: { tier: "paid", cpu: 2, ramMb: 4096, diskGb: 10 },
    });
  });

  it("returns a stopped downgrade to stopped and grandfathers the paid disk", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "free");
    await seedHost(env, {
      host_type: "regular",
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      tier: "paid",
      placement_class: "regular",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
      status: "stopped",
    });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    expect(await requestPlanTransition(env, "user-1", "free", 40_000)).toBe("resizing");
    expect(await transition(env)).toMatchObject({
      to_tier: "free",
      target_disk_gb: 8,
      prior_status: "stopped",
      reserved_cpu: 0,
      reserved_ram_mb: 0,
      reserved_disk_gb: 0,
    });
    const job = await getJob(env, String(daemon.submitted[0]?.jobId));
    if (!job) throw new Error("downgrade resize job missing");
    await refreshJob(env, job);

    expect(await getContainerForUser(env, "user-1")).toMatchObject({
      tier: "free",
      placement_class: "budget",
      status: "stopped",
      cpu: 1,
      ram_mb: 1536,
      disk_gb: 8,
      storage_grandfathered: 1,
    });
    expect(await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({
      vcpu_allocated: 1,
      ram_allocated_mb: 1536,
      disk_allocated_gb: 16,
    });
  });
});
