import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateX25519Keypair,
  sealOpenJson,
  type CredentialPayload,
} from "@workbench/contract";
import { upsertCredentials } from "../src/credentials.js";
import { HOST_HEARTBEAT_MAX_AGE_MS, pickHost } from "../src/capacity.js";
import {
  buildJobRequest,
  enqueueJob,
  enqueueJobForUser,
  getContainerForUser,
  getJob,
  refreshJob,
} from "../src/jobs.js";
import { startProvision } from "../src/placement.js";
import type { Bindings, HostRow, JobRow } from "../src/types.js";
import { fakeDaemon, makeEnv, seedContainer, seedHost, seedUser, stubFetch } from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

const hostKeys = generateX25519Keypair();

describe("buildJobRequest", () => {
  it("seals credentials to the host key for provision; plaintext never appears on the wire", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    const host = await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    const container = await seedContainer(env);
    await upsertCredentials(env, "user-1", {
      llmKeys: { anthropic: "CANARY-key-123" },
      cloudflareToken: "CANARY-cf-456",
    });
    await env.DB.prepare(
      "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES (?, '', 'ssh-ed25519 AAAA k', ?)",
    )
      .bind("user-1", Date.now())
      .run();

    const request = await buildJobRequest(env, "provision", "job-1", container, host);
    expect(request.op).toBe("provision");
    if (request.op !== "provision") throw new Error("unreachable");
    expect(request.spec.sshPort).toBe(30500);
    expect(request.sshKeys).toEqual(["ssh-ed25519 AAAA k"]);
    expect(JSON.stringify(request)).not.toContain("CANARY-"); // sealed, not plaintext

    const opened = sealOpenJson<CredentialPayload>(
      request.sealedCredentials as string,
      hostKeys.privateKey,
    );
    expect(opened).toEqual({
      llmKeys: { anthropic: "CANARY-key-123" },
      cloudflareToken: "CANARY-cf-456",
    });
  });

  it("omits sealedCredentials when the user stored none", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    const host = await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    const container = await seedContainer(env);

    const request = await buildJobRequest(env, "provision", "job-1", container, host);
    expect(request).not.toHaveProperty("sealedCredentials");
  });

  it("builds bare requests for stop/destroy", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    const host = await seedHost(env);
    const container = await seedContainer(env);
    for (const op of ["stop", "destroy"] as const) {
      expect(await buildJobRequest(env, op, "j", container, host)).toEqual({
        op,
        jobId: "j",
        containerId: "container-1",
      });
    }
  });

  it("includes the latest keys and credentials when starting a stopped container", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    const host = await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    const container = await seedContainer(env, { status: "stopped" });
    await env.DB.prepare(
      "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES ('user-1', '', 'ssh-ed25519 AAAA latest', ?)",
    )
      .bind(Date.now())
      .run();
    await upsertCredentials(env, "user-1", { llmKeys: { openai: "CANARY-latest" } });

    const request = await buildJobRequest(env, "start", "j", container, host);
    expect(request).toMatchObject({
      op: "start",
      jobId: "j",
      containerId: "container-1",
      sshKeys: ["ssh-ed25519 AAAA latest"],
      dashboardUrl: "https://usebench.dev",
    });
    if (request.op !== "start" || !request.sealedCredentials) throw new Error("missing snapshot");
    expect(
      sealOpenJson<CredentialPayload>(request.sealedCredentials, hostKeys.privateKey),
    ).toEqual({ llmKeys: { openai: "CANARY-latest" } });
  });
});

describe("enqueueJob", () => {
  async function setup() {
    const { env } = makeEnv();
    await seedUser(env);
    const host = await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    const container = await seedContainer(env);
    return { env, host, container };
  }

  it("marks the job running after the daemon accepts it", async () => {
    const { env, host, container } = await setup();
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const job = await enqueueJob(env, "stop", container, host);
    expect(job.status).toBe("running");
    expect(daemon.submitted).toHaveLength(1);
    expect(daemon.submitted[0]).toMatchObject({ op: "stop", containerId: "container-1" });
  });

  it("allows only one active lifecycle job per container", async () => {
    const { env, host, container } = await setup();
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const results = await Promise.allSettled([
      enqueueJob(env, "stop", container, host),
      enqueueJob(env, "stop", container, host),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({ message: "container state changed or lifecycle operation already in progress" }),
    });
    expect((await env.DB.prepare("SELECT * FROM jobs").all()).results).toHaveLength(1);
    expect(daemon.submitted).toHaveLength(1);
  });

  it("does not fail or resurrect a queued job while daemon submission is in flight", async () => {
    const { env, host, container } = await setup();
    let submissionStarted!: () => void;
    let releaseSubmission!: () => void;
    const started = new Promise<void>((resolve) => {
      submissionStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSubmission = resolve;
    });
    stubFetch((url, init) => {
      if (url.pathname === "/jobs" && init.method === "POST") {
        const request = JSON.parse(String(init.body)) as { jobId: string };
        submissionStarted();
        return release.then(() =>
          Response.json({ jobId: request.jobId, status: "queued" }, { status: 202 })
        );
      }
      if (url.pathname.startsWith("/jobs/")) return new Response("gone", { status: 404 });
      return null;
    });

    const enqueue = enqueueJob(env, "stop", container, host);
    await started;
    const queued = await env.DB.prepare("SELECT * FROM jobs").first<JobRow>();
    if (!queued) throw new Error("queued job missing");
    expect(queued.status).toBe("queued");

    await expect(refreshJob(env, queued)).resolves.toMatchObject({ status: "queued" });
    releaseSubmission();
    await expect(enqueue).resolves.toMatchObject({ status: "running" });
    expect((await getContainerForUser(env, "user-1"))?.status).toBe("running");
  });

  it("rejects a lifecycle job built from a stale container snapshot", async () => {
    const { env, host, container } = await setup();
    await env.DB.prepare("UPDATE containers SET status = 'stopped' WHERE id = ?")
      .bind(container.id)
      .run();
    stubFetch(() => {
      throw new Error("stale work must not be dispatched");
    });

    await expect(enqueueJob(env, "stop", container, host)).rejects.toThrow(
      "container state changed",
    );
    expect((await env.DB.prepare("SELECT * FROM jobs").all()).results).toHaveLength(0);
  });

  it("fails the job and drops the container to error when the daemon is unreachable (lifecycle op)", async () => {
    const { env, host, container } = await setup();
    stubFetch(() => {
      throw new Error("connect refused");
    });

    const job = await enqueueJob(env, "stop", container, host);
    expect(job.status).toBe("failed");
    const fresh = await getContainerForUser(env, "user-1");
    expect(fresh?.status).toBe("error");
  });

  it("stamps desired-state sync jobs with their monotonic row revision", async () => {
    const { env, host, container } = await setup();
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    await enqueueJob(env, "sync-keys", container, host);
    await enqueueJob(env, "sync-keys", container, host);
    await enqueueJob(env, "refresh-credentials", container, host);
    await enqueueJob(env, "stop", container, host);

    const revisions = daemon.submitted.map((request) =>
      (request as { revision?: number }).revision,
    );
    expect(revisions[0]).toEqual(expect.any(Number));
    // Later snapshots always carry a higher revision than earlier ones, so a
    // delayed older job can be discarded on the host instead of overwriting
    // newer desired state.
    expect(revisions[1]!).toBeGreaterThan(revisions[0]!);
    expect(revisions[2]!).toBeGreaterThan(revisions[1]!);
    // Lifecycle ops are serialized by the job table and carry no revision.
    expect(revisions[3]).toBeUndefined();
  });

  it("leaves container state alone when a background op fails (sync-keys)", async () => {
    const { env, host, container } = await setup();
    stubFetch(() => {
      throw new Error("connect refused");
    });

    const job = await enqueueJob(env, "sync-keys", container, host);
    expect(job.status).toBe("failed");
    expect((await getContainerForUser(env, "user-1"))?.status).toBe("running");
  });

  it("never persists credential material in job rows (§8: no payload column)", async () => {
    const { env, host, container } = await setup();
    await upsertCredentials(env, "user-1", { llmKeys: { openai: "CANARY-secret" } });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    await enqueueJob(env, "refresh-credentials", container, host);
    const rows = await env.DB.prepare("SELECT * FROM jobs").all<JobRow>();
    expect(JSON.stringify(rows.results)).not.toContain("CANARY-");
  });
});

describe("enqueueJobForUser", () => {
  it("is a no-op without a placed, steady-state container", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "provisioning" });
    stubFetch(() => {
      throw new Error("should not dispatch");
    });

    await enqueueJobForUser(env, "user-1", "sync-keys");
    const jobs = await env.DB.prepare("SELECT * FROM jobs").all();
    expect(jobs.results).toHaveLength(0);
  });

  it("dispatches for a running container", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    await seedContainer(env, { status: "running" });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    await enqueueJobForUser(env, "user-1", "sync-keys");
    expect(daemon.submitted).toMatchObject([{ op: "sync-keys" }]);
  });

  it("defers updates for a stopped container until its enriched start job", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    await seedContainer(env, { status: "stopped" });
    stubFetch(() => {
      throw new Error("should not dispatch while stopped");
    });

    await enqueueJobForUser(env, "user-1", "refresh-credentials");
    expect((await env.DB.prepare("SELECT * FROM jobs").all()).results).toHaveLength(0);
  });
});

describe("refreshJob", () => {
  async function runJob(env: Bindings, op: JobRow["op"]) {
    const host = await env.DB.prepare("SELECT * FROM hosts WHERE id = 'host-1'").first<HostRow>();
    const container = await getContainerForUser(env, "user-1");
    if (!host || !container) throw new Error("test setup missing host/container");
    return enqueueJob(env, op, container, host);
  }

  it("folds a succeeded provision into `running` and stores host key fingerprints", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    await seedContainer(env, { status: "provisioning" });
    const submitted = fakeDaemon();
    stubFetch(
      (url, init) => (init.method === "POST" ? submitted.route(url, init) : null),
      (url) =>
        url.pathname.startsWith("/jobs/")
          ? Response.json({
              jobId: url.pathname.split("/")[2],
              status: "succeeded",
              error: null,
              result: { hostKeyFingerprints: ["256 SHA256:abc (ED25519)"] },
            })
          : null,
    );

    const job = await runJob(env, "provision");
    const refreshed = await refreshJob(env, job);
    expect(refreshed.status).toBe("succeeded");

    const container = await getContainerForUser(env, "user-1");
    expect(container?.status).toBe("running");
    expect(JSON.parse(container?.host_key_fingerprints ?? "[]")).toEqual([
      "256 SHA256:abc (ED25519)",
    ]);
  });

  it("does not apply stale provision metadata after a newer lifecycle result", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, {
      status: "running",
      host_key_fingerprints: JSON.stringify(["new-fingerprint"]),
    });
    await env.DB.prepare(
      `INSERT INTO jobs (id, container_id, op, status, created_at, updated_at)
       VALUES ('old-provision', 'container-1', 'provision', 'running', 1, 1),
              ('new-provision', 'container-1', 'provision', 'succeeded', 2, 2)`,
    ).run();
    const job = await getJob(env, "old-provision");
    if (!job) throw new Error("test job missing");
    stubFetch((url) =>
      url.pathname === "/jobs/old-provision"
        ? Response.json({
            jobId: "old-provision",
            status: "succeeded",
            error: null,
            result: { hostKeyFingerprints: ["stale-fingerprint"] },
          })
        : null,
    );

    await refreshJob(env, job);

    const container = await getContainerForUser(env, "user-1");
    expect(JSON.parse(container?.host_key_fingerprints ?? "[]")).toEqual(["new-fingerprint"]);
  });

  it("fails fast when the daemon lost the job (restart), instead of spinning", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "provisioning" });
    stubFetch(
      (url, init) => {
        if (url.pathname !== "/jobs" || init.method !== "POST") return null;
        const request = JSON.parse(String(init.body)) as { jobId: string };
        return Response.json({ jobId: request.jobId, status: "queued" }, { status: 202 });
      },
      (url) => (url.pathname.startsWith("/jobs/") ? new Response("gone", { status: 404 }) : null),
    );

    const job = await runJob(env, "provision");
    const refreshed = await refreshJob(env, job);
    expect(refreshed.status).toBe("failed");
    expect(refreshed.error).toMatch(/daemon restarted/);
    expect((await getContainerForUser(env, "user-1"))?.status).toBe("error");
  });

  it("destroy success quarantines the port, releases host accounting, and drops the row", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env, { vcpu_allocated: 1, ram_allocated_mb: 2048, disk_allocated_gb: 16 });
    await seedContainer(env, { status: "running" });
    await env.DB.prepare(
      "INSERT INTO waitlist (user_id, requested_at, admitted_at) VALUES ('user-1', 1, 2)",
    ).run();
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const job = await runJob(env, "destroy");
    await refreshJob(env, job);

    expect(await getContainerForUser(env, "user-1")).toBeNull();
    const host = await env.DB.prepare("SELECT * FROM hosts WHERE id = 'host-1'").first<{
      vcpu_allocated: number;
      ram_allocated_mb: number;
      disk_allocated_gb: number;
    }>();
    expect(host?.vcpu_allocated).toBe(0);
    expect(host?.ram_allocated_mb).toBe(0);
    expect(host?.disk_allocated_gb).toBe(0);
    const q = await env.DB.prepare("SELECT * FROM port_quarantine WHERE host_id = 'host-1'").all<{
      port: number;
    }>();
    expect(q.results.map((r) => r.port)).toEqual([30500]);
    expect((await env.DB.prepare("SELECT * FROM waitlist").all()).results).toHaveLength(0);
  });

  it("keeps destroy retryable when an atomic finalization step fails", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env, { vcpu_allocated: 1, ram_allocated_mb: 2048, disk_allocated_gb: 16 });
    await seedContainer(env, { status: "destroying" });
    await env.DB.prepare(
      `INSERT INTO jobs (id, container_id, op, status, created_at, updated_at)
       VALUES ('destroy-failure', 'container-1', 'destroy', 'running', 1, 1)`,
    ).run();
    await env.DB.prepare(
      `CREATE TRIGGER reject_container_delete BEFORE DELETE ON containers
       BEGIN SELECT RAISE(FAIL, 'delete failed'); END`,
    ).run();
    const job = await getJob(env, "destroy-failure");
    if (!job) throw new Error("test job missing");
    stubFetch((url) =>
      url.pathname === "/jobs/destroy-failure"
        ? Response.json({
            jobId: "destroy-failure",
            status: "succeeded",
            error: null,
            result: null,
          })
        : null,
    );

    await expect(refreshJob(env, job)).rejects.toThrow("delete failed");

    expect(await getJob(env, job.id)).toMatchObject({ status: "running" });
    expect(await getContainerForUser(env, "user-1")).toMatchObject({ status: "destroying" });
    const host = await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first();
    expect(host).toEqual({ vcpu_allocated: 1, ram_allocated_mb: 2048, disk_allocated_gb: 16 });
    expect((await env.DB.prepare("SELECT * FROM port_quarantine").all()).results).toHaveLength(0);
  });

  it("applies destroy completion side effects once when dashboard and cron poll concurrently", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env, {
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 32,
    });
    await seedContainer(env, { status: "destroying" });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs (id, container_id, op, status, created_at, updated_at)
       VALUES ('destroy-race', 'container-1', 'destroy', 'running', ?, ?)`,
    )
      .bind(now, now)
      .run();
    const job = await getJob(env, "destroy-race");
    if (!job) throw new Error("test job missing");
    stubFetch((url) =>
      url.pathname === "/jobs/destroy-race"
        ? Response.json({
            jobId: "destroy-race",
            status: "succeeded",
            error: null,
            result: null,
          })
        : null,
    );

    await Promise.all([refreshJob(env, job), refreshJob(env, job)]);

    const host = await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first<{ vcpu_allocated: number; ram_allocated_mb: number; disk_allocated_gb: number }>();
    expect(host).toEqual({ vcpu_allocated: 1, ram_allocated_mb: 2048, disk_allocated_gb: 16 });
  });

  it("renews the D1 lease when the daemon reports a running heartbeat", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "provisioning" });
    await env.DB.prepare(
      `INSERT INTO jobs (id, container_id, op, status, created_at, updated_at)
       VALUES ('heartbeat', 'container-1', 'provision', 'running', 1, 1)`,
    ).run();
    const job = await getJob(env, "heartbeat");
    if (!job) throw new Error("test job missing");
    stubFetch((url) =>
      url.pathname === "/jobs/heartbeat"
        ? Response.json({
            jobId: "heartbeat",
            status: "running",
            error: null,
            result: null,
          })
        : null,
    );

    const refreshed = await refreshJob(env, job);
    expect(refreshed.status).toBe("running");
    expect(refreshed.updated_at).toBeGreaterThan(1);
  });

  it("keeps the job untouched on a transient daemon error (reconciler will time it out)", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env);
    stubFetch(
      (url, init) => {
        if (url.pathname !== "/jobs" || init.method !== "POST") return null;
        const request = JSON.parse(String(init.body)) as { jobId: string };
        return Response.json({ jobId: request.jobId, status: "queued" }, { status: 202 });
      },
      () => {
        throw new Error("flaky network");
      },
    );

    const job = await runJob(env, "stop");
    const refreshed = await refreshJob(env, job);
    expect(refreshed.status).toBe("running");
  });
});

describe("pickHost (scheduler §10)", () => {
  it("prefers the host with the most unallocated non-reserved RAM", async () => {
    const { env } = makeEnv();
    await seedHost(env, { id: "small", ram_total_mb: 32768, ram_reserve_mb: 8192, ram_allocated_mb: 20000 });
    await seedHost(env, { id: "big", ram_total_mb: 65536, ram_reserve_mb: 16384, ram_allocated_mb: 0 });

    expect((await pickHost(env, 1, 2048, 8))?.id).toBe("big");
  });

  it("respects the upgrade-headroom reserve", async () => {
    const { env } = makeEnv();
    // 4096 total, 2048 reserved, 1024 allocated -> only 1024 non-reserved free.
    await seedHost(env, { ram_total_mb: 4096, ram_reserve_mb: 2048, ram_allocated_mb: 1024 });
    expect(await pickHost(env, 1, 2048, 8)).toBeNull();
  });

  it("rejects hosts whose ZFS pool cannot fit the disk quota", async () => {
    const { env } = makeEnv();
    await seedHost(env, { disk_total_gb: 40, disk_allocated_gb: 36 });
    expect(await pickHost(env, 1, 2048, 8)).toBeNull();
    expect(await pickHost(env, 1, 2048, 4)).not.toBeNull();
  });

  it("ignores inactive hosts", async () => {
    const { env } = makeEnv();
    await seedHost(env, { status: "draining" });
    expect(await pickHost(env, 1, 2048, 8)).toBeNull();
  });

  it("rejects a host whose vCPU reservation ceiling is full", async () => {
    const { env } = makeEnv();
    await seedHost(env, { vcpu_capacity: 3, vcpu_allocated: 3 });
    expect(await pickHost(env, 1, 2048, 8)).toBeNull();
  });

  it("rejects stale or currently failing daemon heartbeats", async () => {
    const { env } = makeEnv();
    await seedHost(env, {
      last_seen_at: Date.now() - HOST_HEARTBEAT_MAX_AGE_MS - 1,
    });
    expect(await pickHost(env, 1, 2048, 8)).toBeNull();

    const fresh = makeEnv();
    await seedHost(fresh.env, { consecutive_failures: 1 });
    expect(await pickHost(fresh.env, 1, 2048, 8)).toBeNull();
  });
});

describe("startProvision", () => {
  it("waitlists the user when no host has capacity", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);

    const container = await startProvision(env, user, { agents: ["claude"] });
    expect(container.status).toBe("waitlisted");
    expect(container.host_id).toBeNull();
    const wl = await env.DB.prepare("SELECT * FROM waitlist WHERE user_id = 'user-1'").first();
    expect(wl).not.toBeNull();
  });

  it("places, allocates a port, bumps host accounting, and dispatches the provision job", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const container = await startProvision(env, user, { agents: ["claude", "pi"] });
    expect(container.status).toBe("provisioning");
    expect(container.ssh_port).toBeGreaterThan(0);
    expect(JSON.parse(container.agents)).toEqual(["claude", "pi"]);

    const host = await env.DB.prepare("SELECT * FROM hosts WHERE id = 'host-1'").first<{
      vcpu_allocated: number;
      ram_allocated_mb: number;
      disk_allocated_gb: number;
    }>();
    expect(host?.vcpu_allocated).toBe(1);
    expect(host?.ram_allocated_mb).toBe(2048);
    expect(host?.disk_allocated_gb).toBe(16);
    expect(daemon.submitted).toMatchObject([{ op: "provision" }]);
  });

  it("does not turn an unrelated placement database failure into a waitlist row", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    const database = env.DB;
    env.DB = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async () => {
            throw new Error("database unavailable");
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    await expect(startProvision(env, user, { agents: ["claude"] })).rejects.toThrow(
      "database unavailable",
    );
    expect(await env.DB.prepare("SELECT * FROM containers").all()).toMatchObject({ results: [] });
    expect(await env.DB.prepare("SELECT * FROM waitlist").all()).toMatchObject({ results: [] });
  });

  it("uses another eligible host when the preferred host has no SSH ports", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, {
      id: "ports-full",
      ram_total_mb: 65536,
      ram_reserve_mb: 8192,
      daemon_pubkey: hostKeys.publicKey,
    });
    await seedHost(env, {
      id: "ports-free",
      ram_total_mb: 32768,
      ram_reserve_mb: 8192,
      daemon_pubkey: hostKeys.publicKey,
    });
    await env.DB.prepare(
      `WITH RECURSIVE ports(port) AS (
         VALUES(30000) UNION ALL SELECT port + 1 FROM ports WHERE port < 39999
       )
       INSERT INTO port_quarantine (host_id, port, released_at)
       SELECT 'ports-full', port, ? FROM ports`,
    )
      .bind(Date.now())
      .run();
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const container = await startProvision(env, user, { agents: ["claude"] });

    expect(container.host_id).toBe("ports-free");
    expect(daemon.submitted).toHaveLength(1);
  });

  it("surfaces a post-placement job enqueue failure instead of treating it as a duplicate", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    const database = env.DB;
    env.DB = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.startsWith("INSERT INTO jobs")) throw new Error("job insert failed");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    await expect(startProvision(env, user, { agents: ["claude"] })).rejects.toThrow(
      "job insert failed",
    );
    const container = await env.DB.prepare(
      "SELECT status, status_detail FROM containers WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ status: string; status_detail: string | null }>();
    expect(container).toEqual({
      status: "error",
      status_detail: "provisioning could not be queued",
    });
  });

  it("does not oversubscribe the final host slot when two provisions race", async () => {
    const { env } = makeEnv();
    const alice = await seedUser(env, "alice");
    const bob = await seedUser(env, "bob");
    await seedHost(env, {
      vcpu_capacity: 1,
      ram_total_mb: 4096,
      ram_reserve_mb: 2048,
      disk_total_gb: 16,
      daemon_pubkey: hostKeys.publicKey,
    });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const containers = await Promise.all([
      startProvision(env, alice, { agents: ["codex"] }),
      startProvision(env, bob, { agents: ["claude"] }),
    ]);

    expect(containers.map((container) => container.status).sort()).toEqual([
      "provisioning",
      "waitlisted",
    ]);
    const host = await env.DB.prepare(
      "SELECT vcpu_allocated, ram_allocated_mb, disk_allocated_gb FROM hosts WHERE id = 'host-1'",
    ).first<{ vcpu_allocated: number; ram_allocated_mb: number; disk_allocated_gb: number }>();
    expect(host).toEqual({ vcpu_allocated: 1, ram_allocated_mb: 2048, disk_allocated_gb: 16 });
    expect(daemon.submitted).toHaveLength(1);
  });
});
