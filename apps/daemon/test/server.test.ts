import { describe, expect, it } from "vitest";
import {
  generateEd25519Keypair,
  generateX25519Keypair,
  INPUT_LIMITS,
  signRequest,
} from "@workbench/contract";
import type { DaemonConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { Incus, type ExecFn } from "../src/incus.js";
import { JobRunner } from "../src/jobs.js";
import { Provisioner } from "../src/provisioner.js";

const workerKeys = generateEd25519Keypair();

function makeApp() {
  const config: DaemonConfig = {
    hostId: "host-1",
    hostType: "budget",
    listenPort: 8443,
    workerRpcPublicKey: workerKeys.publicKey,
    x25519PrivateKey: generateX25519Keypair().privateKey,
    baseImage: "workbench-base",
    storagePool: "default",
    project: "default",
  };
  const listJson = JSON.stringify([
    { name: "workbench-abc000", status: "Running", config: { "user.workbench.id": "c-123" } },
    { name: "unrelated", status: "Running", config: {} },
  ]);
  const exec: ExecFn = async (_c, args) => ({
    stdout: args[0] === "list" ? listJson : "",
    stderr: "",
  });
  const incus = new Incus(exec);
  const runner = new JobRunner(new Provisioner(incus, config));
  return buildApp({ config, incus, runner, version: "release-abc123" });
}

function signedInit(method: "GET" | "POST", path: string, body = ""): RequestInit {
  const headers = signRequest(method, path, body, workerKeys.privateKey);
  return {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body } : {}),
  };
}

describe("daemon HTTP API", () => {
  it("rejects unsigned requests", async () => {
    const app = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(401);
  });

  it("rejects an oversized declared job body before signature verification", async () => {
    const app = makeApp();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-length": String(INPUT_LIMITS.jobRequestBytes + 1) },
      body: "{}",
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body is too large" });
  });

  it("rejects an oversized streamed job body before buffering it", async () => {
    const app = makeApp();
    const res = await app.request("/jobs", {
      method: "POST",
      body: "x".repeat(INPUT_LIMITS.jobRequestBytes + 1),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body is too large" });
  });

  it("rejects oversized POST bodies on any path before signature buffering", async () => {
    const app = makeApp();
    // Signed correctly, but the body limit runs before the signature
    // middleware reads (and buffers) the body.
    const body = "x".repeat(INPUT_LIMITS.jobRequestBytes + 1);
    const res = await app.request("/stats", signedInit("POST", "/stats", body));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body is too large" });
  });

  it("rejects requests signed by an unknown key", async () => {
    const app = makeApp();
    const rogue = generateEd25519Keypair();
    const headers = signRequest("GET", "/health", "", rogue.privateKey);
    const res = await app.request("/health", { headers });
    expect(res.status).toBe(401);
  });

  it("serves health and stats to properly signed requests", async () => {
    const app = makeApp();
    const health = await app.request("/health", signedInit("GET", "/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      hostId: "host-1",
      hostType: "budget",
      tenancyMode: "shared",
      capabilities: ["mixed-tier-shared-v1"],
      version: "release-abc123",
    });

    const stats = await app.request("/stats", signedInit("GET", "/stats"));
    const body = (await stats.json()) as {
      containers: unknown[];
      cpuLogical: number;
      ramAvailableMb: number;
      hostUptimeSec: number;
      hostType: string;
      tenancyMode: string;
      capabilities: string[];
      version: string;
    };
    expect(body.containers).toEqual([{ containerId: "c-123", incusStatus: "Running" }]);
    expect(body.cpuLogical).toBeGreaterThan(0);
    expect(body.ramAvailableMb).toBeGreaterThanOrEqual(0);
    expect(body.hostUptimeSec).toBeGreaterThan(0);
    expect(body.hostType).toBe("budget");
    expect(body.tenancyMode).toBe("shared");
    expect(body.capabilities).toEqual(["mixed-tier-shared-v1"]);
    expect(body.version).toBe("release-abc123");
  });

  it("rejects a replayed signed request", async () => {
    const app = makeApp();
    const init = signedInit("GET", "/health");
    expect((await app.request("/health", init)).status).toBe(200);
    expect((await app.request("/health", init)).status).toBe(401);
  });

  it("accepts a job and reports its status", async () => {
    const app = makeApp();
    const body = JSON.stringify({ op: "stop", jobId: "j-9", containerId: "c-123" });
    const res = await app.request("/jobs", signedInit("POST", "/jobs", body));
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    const status = await app.request("/jobs/j-9", signedInit("GET", "/jobs/j-9"));
    expect(await status.json()).toMatchObject({ jobId: "j-9", status: "succeeded" });
  });

  it("rejects malformed job payloads", async () => {
    const app = makeApp();
    const body = JSON.stringify({ op: "melt-the-host", jobId: "j", containerId: "c" });
    const res = await app.request("/jobs", signedInit("POST", "/jobs", body));
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed signed JSON", async () => {
    const app = makeApp();
    const body = '{"op":"stop"';
    const res = await app.request("/jobs", signedInit("POST", "/jobs", body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid job request" });
  });

  it("rejects reusing a job id for a different operation", async () => {
    const app = makeApp();
    const first = JSON.stringify({ op: "stop", jobId: "j-reused", containerId: "c-123" });
    const conflicting = JSON.stringify({ op: "start", jobId: "j-reused", containerId: "c-123" });

    expect((await app.request("/jobs", signedInit("POST", "/jobs", first))).status).toBe(202);
    const res = await app.request("/jobs", signedInit("POST", "/jobs", conflicting));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "job id already belongs to a different operation",
    });
  });
});
