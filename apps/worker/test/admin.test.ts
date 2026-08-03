import { afterEach, describe, expect, it, vi } from "vitest";
import { generateX25519Keypair } from "@workbench/contract";
import { Hono } from "hono";
import { fleetAdminRoutes } from "../src/fleet-admin.js";
import { getJob, refreshJob } from "../src/jobs.js";
import type { AppContext, Bindings } from "../src/types.js";
import {
  fakeDaemon,
  makeEnv,
  seedContainer,
  seedHost,
  seedUser,
  stubFetch,
} from "./helpers/env.js";

const ADMIN_SECRET = "fleet-admin-secret";
const hostKeys = generateX25519Keypair();

function app() {
  return new Hono<AppContext>().route("/", fleetAdminRoutes);
}

function adminRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_SECRET}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    id: "budget-fsn-1",
    hostType: "budget",
    ipv4: "192.0.2.10",
    sshHostname: "ssh-1.example.test",
    daemonEndpoint: "https://daemon-1.example.test:8443",
    daemonPublicKey: hostKeys.publicKey,
    managementHostname: "management-1.example.test",
    managementPort: 22,
    managementUser: "root",
    ramTotalMb: 32768,
    ramReserveMb: 3072,
    vcpuCapacity: 24,
    diskTotalGb: 700,
    maxTenants: 12,
    ...overrides,
  };
}

function fleetEnv(): { env: Bindings } {
  return makeEnv({ FLEET_ADMIN_SECRET: ADMIN_SECRET });
}

afterEach(() => vi.unstubAllGlobals());

describe("fleet administration", () => {
  it("is hidden when unconfigured and rejects a wrong bearer token", async () => {
    const unconfigured = makeEnv();
    expect((await app().request("/api/admin/hosts", {}, unconfigured.env)).status).toBe(404);

    const { env } = fleetEnv();
    expect((await app().request("/api/admin/hosts", {
      headers: { authorization: "Bearer wrong" },
    }, env)).status).toBe(401);
  });

  it("registers new hosts as draining and lists only operational metadata", async () => {
    const { env } = fleetEnv();
    const response = await app().request(
      "/api/admin/hosts",
      adminRequest("POST", registration()),
      env,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      host: {
        id: "budget-fsn-1",
        hostType: "budget",
        status: "draining",
        maxTenants: 12,
        tenantCount: 0,
        lastSeenAt: null,
      },
    });
    expect((await app().request(
      "/api/admin/hosts",
      adminRequest("POST", registration()),
      env,
    )).status).toBe(409);
    expect((await app().request(
      "/api/admin/hosts",
      adminRequest("POST", registration({
        id: "budget-low-reserve",
        ramTotalMb: 8192,
        ramReserveMb: 3071,
        vcpuCapacity: 16,
        maxTenants: 3,
      })),
      env,
    )).status).toBe(400);

    const listed = await app().request("/api/admin/hosts", adminRequest("GET"), env);
    const body = await listed.json() as { hosts: Array<Record<string, unknown>> };
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0]).not.toHaveProperty("daemonPublicKey");
  });

  it("probes a drained daemon, records its release and hardware report, then activates it", async () => {
    const { env } = fleetEnv();
    await seedHost(env, {
      status: "draining",
      host_type: "regular",
      last_seen_at: null,
      daemon_version: null,
    });
    stubFetch((url) => url.pathname === "/stats"
      ? Response.json({
          hostId: "host-1",
          hostType: "regular",
          version: "abc123",
          containers: [],
          ramTotalMb: 65536,
          cpuLogical: 16,
          uptimeSec: 10,
        })
      : null);

    const probe = await app().request(
      "/api/admin/hosts/host-1/probe",
      adminRequest("POST"),
      env,
    );
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({
      host: {
        status: "draining",
        daemonVersion: "abc123",
        reportedRamTotalMb: 65536,
        reportedCpuLogical: 16,
      },
    });

    const activate = await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "active" }),
      env,
    );
    expect(activate.status).toBe(200);
    expect(await activate.json()).toMatchObject({ host: { status: "active" } });
  });

  it("rejects daemon host-class mismatches and keeps the host out of service", async () => {
    const { env } = fleetEnv();
    await seedHost(env, { status: "draining", host_type: "budget", last_seen_at: null });
    stubFetch(() => Response.json({
      hostId: "host-1",
      hostType: "regular",
      version: "wrong-class",
      containers: [],
      ramTotalMb: 65536,
      uptimeSec: 10,
    }));

    const probe = await app().request(
      "/api/admin/hosts/host-1/probe",
      adminRequest("POST"),
      env,
    );
    expect(probe.status).toBe(502);
    expect(await env.DB.prepare(
      "SELECT status, consecutive_failures, last_seen_at FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({ status: "draining", consecutive_failures: 1, last_seen_at: null });
  });

  it("rejects capacity above four reservations per signed online vCPU", async () => {
    const { env } = fleetEnv();
    await seedHost(env, {
      status: "draining",
      last_seen_at: null,
      vcpu_capacity: 17,
    });
    stubFetch(() => Response.json({
      hostId: "host-1",
      hostType: "budget",
      version: "undersized",
      containers: [],
      ramTotalMb: 65536,
      cpuLogical: 4,
      uptimeSec: 10,
    }));

    expect((await app().request(
      "/api/admin/hosts/host-1/probe",
      adminRequest("POST"),
      env,
    )).status).toBe(502);
    expect(await env.DB.prepare(
      "SELECT last_seen_at, consecutive_failures FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({ last_seen_at: null, consecutive_failures: 1 });
  });

  it("requires current daemons to report CPU hardware before activation", async () => {
    const { env } = fleetEnv();
    await seedHost(env, {
      status: "draining",
      last_seen_at: null,
      daemon_version: null,
      reported_ram_total_mb: null,
      reported_cpu_logical: null,
    });
    stubFetch(() => Response.json({
      hostId: "host-1",
      hostType: "budget",
      version: "missing-cpu",
      containers: [],
      ramTotalMb: 65536,
      uptimeSec: 10,
    }));

    expect((await app().request(
      "/api/admin/hosts/host-1/probe",
      adminRequest("POST"),
      env,
    )).status).toBe(502);
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "active" }),
      env,
    )).status).toBe(409);
  });

  it("does not activate a host whose registered capacity is below existing reservations", async () => {
    const { env } = fleetEnv();
    await seedHost(env, {
      status: "draining",
      vcpu_capacity: 1,
      vcpu_allocated: 2,
    });
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "active" }),
      env,
    )).status).toBe(409);
  });

  it("keeps rolling reconciliation compatible but rejects legacy stats for fleet activation", async () => {
    const { env } = fleetEnv();
    await seedHost(env, {
      status: "draining",
      daemon_version: "stale-release",
      reported_cpu_logical: 32,
    });
    stubFetch(() => Response.json({
      hostId: "host-1",
      containers: [],
      ramTotalMb: 65536,
      uptimeSec: 10,
    }));

    const probe = await app().request(
      "/api/admin/hosts/host-1/probe",
      adminRequest("POST"),
      env,
    );
    expect(probe.status).toBe(502);
    expect(await env.DB.prepare(
      `SELECT last_seen_at, daemon_version, reported_ram_total_mb,
              reported_cpu_logical, consecutive_failures
       FROM hosts WHERE id = 'host-1'`,
    ).first()).toEqual({
      last_seen_at: null,
      daemon_version: null,
      reported_ram_total_mb: null,
      reported_cpu_logical: null,
      consecutive_failures: 1,
    });
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "active" }),
      env,
    )).status).toBe(409);
  });

  it("assigns dedicated hosts only to dedicated paid accounts", async () => {
    const { env } = fleetEnv();
    await seedUser(env, "free-user", "free");
    await seedUser(env, "dedicated-user", "dedicated");

    const rejected = await app().request(
      "/api/admin/hosts",
      adminRequest("POST", registration({
        id: "dedicated-1",
        hostType: "dedicated",
        maxTenants: 1,
        dedicatedUserId: "free-user",
      })),
      env,
    );
    expect(rejected.status).toBe(409);

    const accepted = await app().request(
      "/api/admin/hosts",
      adminRequest("POST", registration({
        id: "dedicated-1",
        hostType: "dedicated",
        maxTenants: 1,
        dedicatedUserId: "dedicated-user",
      })),
      env,
    );
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      host: { hostType: "dedicated", dedicatedUserId: "dedicated-user", maxTenants: 1 },
    });

    const duplicateAssignment = await app().request(
      "/api/admin/hosts",
      adminRequest("POST", registration({
        id: "dedicated-2",
        hostType: "dedicated",
        maxTenants: 1,
        dedicatedUserId: "dedicated-user",
      })),
      env,
    );
    expect(duplicateAssignment.status).toBe(409);
  });

  it("changes endpoints only while drained and requires a new probe before activation", async () => {
    const { env } = fleetEnv();
    await seedHost(env, {
      status: "active",
      last_seen_at: Date.now(),
      daemon_version: "old",
      reported_ram_total_mb: 65536,
      reported_cpu_logical: 16,
    });

    const activeUpdate = await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { daemonEndpoint: "https://daemon-2.test:8443" }),
      env,
    );
    expect(activeUpdate.status).toBe(409);

    await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "draining" }),
      env,
    );
    const updated = await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", {
        daemonEndpoint: "https://daemon-2.test:8443",
        managementHostname: "management-2.test",
      }),
      env,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      host: {
        status: "draining",
        daemonEndpoint: "https://daemon-2.test:8443",
        managementHostname: "management-2.test",
        daemonVersion: null,
        reportedRamTotalMb: null,
        reportedCpuLogical: null,
        lastSeenAt: null,
      },
    });
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "active" }),
      env,
    )).status).toBe(409);
  });

  it("re-registers calculated capacity only while drained and within resource ceilings", async () => {
    const { env } = fleetEnv();
    await seedHost(env, { status: "active" });
    const capacity = {
      ramTotalMb: 32768,
      ramReserveMb: 4096,
      vcpuCapacity: 24,
      diskTotalGb: 500,
      maxTenants: 10,
    };

    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { capacity }),
      env,
    )).status).toBe(409);
    await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "draining" }),
      env,
    );
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { capacity: { ...capacity, maxTenants: 25 } }),
      env,
    )).status).toBe(409);
    await env.DB.prepare(
      "UPDATE hosts SET vcpu_allocated = 12, ram_allocated_mb = 20000, disk_allocated_gb = 400 WHERE id = 'host-1'",
    ).run();
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { capacity: { ...capacity, vcpuCapacity: 8 } }),
      env,
    )).status).toBe(409);

    const updated = await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { capacity }),
      env,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      host: {
        status: "draining",
        ramTotalMb: 32768,
        ramReserveMb: 4096,
        vcpuCapacity: 24,
        diskTotalGb: 500,
        maxTenants: 10,
        lastSeenAt: null,
        reportedRamTotalMb: null,
        reportedCpuLogical: null,
      },
    });
  });

  it("retires only drained hosts and never reactivates a dead identity", async () => {
    const { env } = fleetEnv();
    await seedHost(env, { status: "active" });
    await seedUser(env);
    await seedContainer(env);
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "dead" }),
      env,
    )).status).toBe(409);
    await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "draining" }),
      env,
    );
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "dead" }),
      env,
    )).status).toBe(409);
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "dead", force: true }),
      env,
    )).status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT host_id, status, placement_class FROM containers WHERE id = 'container-1'",
    ).first()).toEqual({ host_id: null, status: "waitlisted", placement_class: "budget" });
    expect((await env.DB.prepare(
      "SELECT * FROM host_history WHERE host_id = 'host-1'",
    ).all()).results).toHaveLength(1);
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "active" }),
      env,
    )).status).toBe(409);
  });

  it("evacuates a force-dead dedicated host and frees its account assignment", async () => {
    const { env } = fleetEnv();
    await seedUser(env, "dedicated-user", "dedicated");
    await seedHost(env, {
      host_type: "dedicated",
      max_tenants: 1,
      dedicated_user_id: "dedicated-user",
      vcpu_allocated: 3,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      user_id: "dedicated-user",
      tier: "paid",
      placement_class: "dedicated",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
    });
    await env.DB.prepare(
      `INSERT INTO jobs (id, container_id, op, status, created_at, updated_at)
       VALUES ('running-job', 'container-1', 'start', 'running', 1, 1)`,
    ).run();
    await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "draining" }),
      env,
    );
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "dead", force: true }),
      env,
    )).status).toBe(200);

    expect(await env.DB.prepare(
      `SELECT host_id, ssh_port, tier, placement_class, status
       FROM containers WHERE id = 'container-1'`,
    ).first()).toEqual({
      host_id: null,
      ssh_port: null,
      tier: "paid",
      placement_class: "dedicated",
      status: "waitlisted",
    });
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = 'running-job'").first())
      .toEqual({ status: "failed" });
    expect(await env.DB.prepare(
      `SELECT status, dedicated_user_id, vcpu_allocated, ram_allocated_mb,
              disk_allocated_gb FROM hosts WHERE id = 'host-1'`,
    ).first()).toEqual({
      status: "dead",
      dedicated_user_id: null,
      vcpu_allocated: 0,
      ram_allocated_mb: 0,
      disk_allocated_gb: 0,
    });

    expect((await app().request(
      "/api/admin/hosts",
      adminRequest("POST", registration({
        id: "dedicated-2",
        hostType: "dedicated",
        maxTenants: 1,
        dedicatedUserId: "dedicated-user",
      })),
      env,
    )).status).toBe(201);
  });

  it("rescues rows stranded by a legacy already-dead host", async () => {
    const { env } = fleetEnv();
    await seedUser(env);
    await seedHost(env, { status: "dead" });
    await seedContainer(env);

    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "dead", force: true }),
      env,
    )).status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT host_id, status FROM containers WHERE id = 'container-1'",
    ).first()).toEqual({ host_id: null, status: "waitlisted" });
  });

  it("reclasses only empty drained hosts and requires a fresh probe", async () => {
    const { env } = fleetEnv();
    await seedHost(env, { status: "draining" });
    const response = await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", {
        hostType: "regular",
        capacity: {
          ramTotalMb: 16384,
          ramReserveMb: 3072,
          vcpuCapacity: 8,
          diskTotalGb: 160,
          maxTenants: 2,
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      host: {
        hostType: "regular",
        vcpuCapacity: 8,
        ramTotalMb: 16384,
        maxTenants: 2,
        daemonVersion: null,
        lastSeenAt: null,
      },
    });
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "active" }),
      env,
    )).status).toBe(409);
  });

  it("replaces a dead host id by generation and deregisters without losing history", async () => {
    const { env } = fleetEnv();
    await seedHost(env, { status: "draining" });
    await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "dead" }),
      env,
    );
    const replaced = await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PUT", registration({
        id: "host-1",
        hostType: "regular",
        vcpuCapacity: 8,
        ramTotalMb: 16384,
        ramReserveMb: 3072,
        diskTotalGb: 160,
        maxTenants: 2,
      })),
      env,
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({
      host: { id: "host-1", generation: 2, hostType: "regular", status: "draining" },
    });
    expect((await env.DB.prepare(
      "SELECT * FROM host_history WHERE host_id = 'host-1'",
    ).all()).results).toHaveLength(1);

    await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("PATCH", { status: "dead" }),
      env,
    );
    expect((await app().request(
      "/api/admin/hosts/host-1",
      adminRequest("DELETE"),
      env,
    )).status).toBe(204);
    expect(await env.DB.prepare("SELECT id FROM hosts WHERE id = 'host-1'").first()).toBeNull();
    const history = await app().request(
      "/api/admin/hosts/host-1/history",
      adminRequest("GET"),
      env,
    );
    expect(history.status).toBe(200);
    expect((await history.json() as { history: unknown[] }).history).toHaveLength(2);
  });

  it("orderly re-homing destroys the old instance before applying the current plan", async () => {
    const { env } = fleetEnv();
    await seedUser(env, "user-1", "free");
    await seedHost(env, {
      vcpu_allocated: 1,
      ram_allocated_mb: 1536,
      disk_allocated_gb: 10,
    });
    await seedContainer(env);
    await env.DB.prepare(
      "UPDATE users SET subscription_status = 'paid' WHERE id = 'user-1'",
    ).run();
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const response = await app().request(
      "/api/admin/containers/container-1/rehome",
      adminRequest("POST", { confirmDataLoss: true }),
      env,
    );
    expect(response.status).toBe(202);
    const body = await response.json() as { job: { id: string } };
    const job = await getJob(env, body.job.id);
    if (!job) throw new Error("re-home job missing");
    await refreshJob(env, job);

    expect(await env.DB.prepare(
      `SELECT host_id, tier, placement_class, cpu, ram_mb, disk_gb, status,
              rehome_tier FROM containers WHERE id = 'container-1'`,
    ).first()).toEqual({
      host_id: null,
      tier: "paid",
      placement_class: "regular",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
      status: "waitlisted",
      rehome_tier: null,
    });
    expect(await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({ vcpu_allocated: 0, ram_allocated_mb: 0, disk_allocated_gb: 0 });
    expect(await env.DB.prepare("SELECT admitted_at FROM waitlist WHERE user_id = 'user-1'").first())
      .toEqual({ admitted_at: null });
  });

  it("drains and releases a dedicated assignment when its account re-homes away", async () => {
    const { env } = fleetEnv();
    await seedUser(env, "user-1", "dedicated");
    await seedHost(env, {
      host_type: "dedicated",
      max_tenants: 1,
      dedicated_user_id: "user-1",
      vcpu_allocated: 3,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      tier: "paid",
      placement_class: "dedicated",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
    });
    await env.DB.prepare(
      "UPDATE users SET subscription_status = 'paid' WHERE id = 'user-1'",
    ).run();
    const daemon = fakeDaemon();
    stubFetch(daemon.route);
    const response = await app().request(
      "/api/admin/containers/container-1/rehome",
      adminRequest("POST", { confirmDataLoss: true }),
      env,
    );
    const body = await response.json() as { job: { id: string } };
    const job = await getJob(env, body.job.id);
    if (!job) throw new Error("re-home job missing");
    await refreshJob(env, job);

    expect(await env.DB.prepare(
      "SELECT status, dedicated_user_id FROM hosts WHERE id = 'host-1'",
    ).first()).toEqual({ status: "draining", dedicated_user_id: null });
  });
});
