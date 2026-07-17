import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { availableParallelism, freemem, loadavg, totalmem, uptime } from "node:os";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  JobRequestSchema,
  MemoryNonceStore,
  verifyRequest,
  type HealthResponse,
  type JobStatusResponse,
  type StatsResponse,
} from "@codestation/contract";
import { loadConfig } from "./config.js";
import { Incus, realExec } from "./incus.js";
import { JobConflictError, JobRunner } from "./jobs.js";
import { Provisioner } from "./provisioner.js";

const VERSION = "0.1.0";

export function buildApp(opts: {
  config: ReturnType<typeof loadConfig>;
  incus: Incus;
  runner: JobRunner;
  now?: () => number;
}) {
  const { config, incus, runner } = opts;
  const nonces = new MemoryNonceStore(opts.now);
  const app = new Hono<{ Variables: { rawBody: string } }>();

  // Every route requires a valid Worker signature (timestamp + nonce + body hash).
  app.use("*", async (c, next) => {
    const body = c.req.method === "POST" ? await c.req.text() : "";
    const failure = await verifyRequest({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      body,
      headers: { get: (n) => c.req.header(n) ?? null },
      publicKeyB64: config.workerRpcPublicKey,
      nonceStore: nonces,
      now: opts.now,
    });
    if (failure) {
      console.log(JSON.stringify({ event: "rpc_rejected", reason: failure }));
      return c.json({ error: failure }, 401);
    }
    c.set("rawBody", body);
    await next();
  });

  app.get("/health", (c) => {
    const res: HealthResponse = { ok: true, hostId: config.hostId, version: VERSION };
    return c.json(res);
  });

  app.get("/stats", async (c) => {
    const containers = await incus.list();
    const res: StatsResponse = {
      hostId: config.hostId,
      containers: containers
        .filter((ct) => ct.config["user.codestation.id"])
        .map((ct) => ({
          containerId: ct.config["user.codestation.id"] as string,
          incusStatus: ct.status,
        })),
      ramTotalMb: Math.floor(totalmem() / (1024 * 1024)),
      ramAvailableMb: Math.floor(freemem() / (1024 * 1024)),
      cpuLogical: availableParallelism(),
      loadAverage1: loadavg()[0] ?? 0,
      uptimeSec: Math.floor(process.uptime()),
      hostUptimeSec: Math.floor(uptime()),
    };
    return c.json(res);
  });

  app.post("/jobs", (c) => {
    let body: unknown;
    try {
      body = JSON.parse(c.get("rawBody") || "{}");
    } catch {
      return c.json({ error: "invalid job request" }, 400);
    }
    const parsed = JobRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid job request" }, 400);
    }
    try {
      const record = runner.submit(parsed.data);
      return c.json({ jobId: record.jobId, status: record.status }, 202);
    } catch (error) {
      if (error instanceof JobConflictError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  app.get("/jobs/:id", (c) => {
    const record = runner.get(c.req.param("id"));
    if (!record) return c.json({ error: "unknown job" }, 404);
    const res: JobStatusResponse = {
      jobId: record.jobId,
      status: record.status,
      error: record.error,
      result: record.result,
    };
    return c.json(res);
  });

  return app;
}

function main() {
  const config = loadConfig();
  const incus = new Incus(realExec, "incus", config.project);
  const runner = new JobRunner(new Provisioner(incus, config));
  const app = buildApp({ config, incus, runner });

  if (config.tlsCertPath && config.tlsKeyPath) {
    const cert = readFileSync(config.tlsCertPath);
    const key = readFileSync(config.tlsKeyPath);
    serve({
      fetch: app.fetch,
      port: config.listenPort,
      createServer,
      serverOptions: { cert, key },
    });
    console.log(JSON.stringify({ event: "daemon_started", port: config.listenPort, tls: true }));
  } else {
    serve({ fetch: app.fetch, port: config.listenPort });
    console.log(
      JSON.stringify({ event: "daemon_started", port: config.listenPort, tls: false, warning: "plain HTTP — dev only" }),
    );
  }
}

const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) main();
