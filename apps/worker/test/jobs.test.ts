import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateX25519Keypair,
  sealOpenJson,
  type CredentialPayload,
} from "@codestation/contract";
import { upsertCredentials } from "../src/credentials.js";
import {
  buildJobRequest,
  enqueueJob,
  enqueueJobForUser,
  getContainerForUser,
  getJob,
  pickHost,
  refreshJob,
  startProvision,
} from "../src/jobs.js";
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

  it("builds bare requests for start/stop/destroy", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    const host = await seedHost(env);
    const container = await seedContainer(env);
    for (const op of ["start", "stop", "destroy"] as const) {
      expect(await buildJobRequest(env, op, "j", container, host)).toEqual({
        op,
        jobId: "j",
        containerId: "container-1",
      });
    }
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

  it("fails fast when the daemon lost the job (restart), instead of spinning", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "provisioning" });
    stubFetch(
      (url, init) =>
        url.pathname === "/jobs" && init.method === "POST"
          ? Response.json({ ok: true }, { status: 202 })
          : null,
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
    await seedHost(env, { ram_allocated_mb: 2048, disk_allocated_gb: 8 });
    await seedContainer(env, { status: "running" });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const job = await runJob(env, "destroy");
    await refreshJob(env, job);

    expect(await getContainerForUser(env, "user-1")).toBeNull();
    const host = await env.DB.prepare("SELECT * FROM hosts WHERE id = 'host-1'").first<{
      ram_allocated_mb: number;
      disk_allocated_gb: number;
    }>();
    expect(host?.ram_allocated_mb).toBe(0);
    expect(host?.disk_allocated_gb).toBe(0);
    const q = await env.DB.prepare("SELECT * FROM port_quarantine WHERE host_id = 'host-1'").all<{
      port: number;
    }>();
    expect(q.results.map((r) => r.port)).toEqual([30500]);
  });

  it("keeps the job untouched on a transient daemon error (reconciler will time it out)", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env);
    stubFetch(
      (url, init) =>
        url.pathname === "/jobs" && init.method === "POST"
          ? Response.json({ ok: true }, { status: 202 })
          : null,
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

    expect((await pickHost(env, 2048, 8))?.id).toBe("big");
  });

  it("respects the upgrade-headroom reserve", async () => {
    const { env } = makeEnv();
    // 4096 total, 2048 reserved, 1024 allocated -> only 1024 non-reserved free.
    await seedHost(env, { ram_total_mb: 4096, ram_reserve_mb: 2048, ram_allocated_mb: 1024 });
    expect(await pickHost(env, 2048, 8)).toBeNull();
  });

  it("rejects hosts whose ZFS pool cannot fit the disk quota", async () => {
    const { env } = makeEnv();
    await seedHost(env, { disk_total_gb: 40, disk_allocated_gb: 36 });
    expect(await pickHost(env, 2048, 8)).toBeNull();
    expect(await pickHost(env, 2048, 4)).not.toBeNull();
  });

  it("ignores inactive hosts", async () => {
    const { env } = makeEnv();
    await seedHost(env, { status: "draining" });
    expect(await pickHost(env, 2048, 8)).toBeNull();
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
      ram_allocated_mb: number;
      disk_allocated_gb: number;
    }>();
    expect(host?.ram_allocated_mb).toBe(2048);
    expect(host?.disk_allocated_gb).toBe(8);
    expect(daemon.submitted).toMatchObject([{ op: "provision" }]);
  });
});
