import { describe, expect, it } from "vitest";
import {
  generateEd25519Keypair,
  generateX25519Keypair,
  signRequest,
} from "@codestation/contract";
import type { DaemonConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { Incus, type ExecFn } from "../src/incus.js";
import { JobRunner } from "../src/jobs.js";
import { Provisioner } from "../src/provisioner.js";

const workerKeys = generateEd25519Keypair();

function makeApp() {
  const config: DaemonConfig = {
    hostId: "host-1",
    listenPort: 8443,
    workerRpcPublicKey: workerKeys.publicKey,
    x25519PrivateKey: generateX25519Keypair().privateKey,
    baseImage: "codestation-base",
    storagePool: "default",
  };
  const listJson = JSON.stringify([
    { name: "cs-abc", status: "Running", config: { "user.codestation.id": "c-123" } },
    { name: "unrelated", status: "Running", config: {} },
  ]);
  const exec: ExecFn = async (_c, args) => ({
    stdout: args[0] === "list" ? listJson : "",
    stderr: "",
  });
  const incus = new Incus(exec);
  const runner = new JobRunner(new Provisioner(incus, config));
  return buildApp({ config, incus, runner });
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
    expect(await health.json()).toMatchObject({ ok: true, hostId: "host-1" });

    const stats = await app.request("/stats", signedInit("GET", "/stats"));
    const body = (await stats.json()) as { containers: unknown[] };
    expect(body.containers).toEqual([{ containerId: "c-123", incusStatus: "Running" }]);
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
});
