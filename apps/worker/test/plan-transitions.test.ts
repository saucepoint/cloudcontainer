import { afterEach, describe, expect, it, vi } from "vitest";
import { getContainerForUser, getJob, refreshJob } from "../src/jobs.js";
import {
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
      reserved_cpu: 2,
      reserved_ram_mb: 2560,
      reserved_disk_gb: 6,
    });
    expect(await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({
      vcpu_allocated: 3,
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
      spec: { tier: "paid", cpu: 3, ramMb: 4096, diskGb: 8 },
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
      vcpu_allocated: 3,
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
      reserved_cpu: 2,
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
      vcpu_allocated: 3,
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

  it("returns a stopped downgrade to stopped and grandfathers the paid disk", async () => {
    const { env } = makeEnv();
    await seedUser(env, "user-1", "free");
    await seedHost(env, {
      host_type: "regular",
      vcpu_allocated: 3,
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
