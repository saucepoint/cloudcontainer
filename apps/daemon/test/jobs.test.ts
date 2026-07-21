import { describe, expect, it } from "vitest";
import type { JobRequest } from "@workbench/contract";
import { JobRunner } from "../src/jobs.js";
import type { Provisioner } from "../src/provisioner.js";

function runnerWithSpy() {
  const ran: JobRequest[] = [];
  const failing = new Set<string>();
  const provisioner = {
    run: async (request: JobRequest) => {
      ran.push(request);
      if (failing.has(request.jobId)) throw new Error("incus service unavailable");
      return null;
    },
  } as unknown as Provisioner;
  return { runner: new JobRunner(provisioner), ran, failing };
}

async function settled(runner: JobRunner, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = runner.get(jobId);
    if (record && (record.status === "succeeded" || record.status === "failed")) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} never settled`);
}

function syncKeys(jobId: string, revision?: number): JobRequest {
  return {
    op: "sync-keys",
    jobId,
    containerId: "c-1",
    sshKeys: ["ssh-ed25519 AAAA k"],
    dashboardUrl: "https://workbench.example",
    ...(revision !== undefined ? { revision } : {}),
  };
}

describe("JobRunner snapshot revisions", () => {
  it("discards an older snapshot that arrives after a newer one", async () => {
    const { runner, ran } = runnerWithSpy();
    // The newer job lands first (its control-plane dispatch overtook the older one).
    runner.submit(syncKeys("j-new", 6));
    runner.submit(syncKeys("j-old", 5));

    expect((await settled(runner, "j-new")).status).toBe("succeeded");
    const stale = await settled(runner, "j-old");
    expect(stale.status).toBe("succeeded");
    expect(ran.map((request) => request.jobId)).toEqual(["j-new"]);
  });

  it("applies snapshots in revision order when they arrive in order", async () => {
    const { runner, ran } = runnerWithSpy();
    runner.submit(syncKeys("j-1", 5));
    runner.submit(syncKeys("j-2", 6));

    expect((await settled(runner, "j-2")).status).toBe("succeeded");
    expect(ran.map((request) => request.jobId)).toEqual(["j-1", "j-2"]);
  });

  it("never applies an older snapshot even when the newer one failed", async () => {
    const { runner, ran, failing } = runnerWithSpy();
    failing.add("j-new");
    runner.submit(syncKeys("j-new", 6));
    runner.submit(syncKeys("j-old", 5));

    expect((await settled(runner, "j-new")).status).toBe("failed");
    expect((await settled(runner, "j-old")).status).toBe("succeeded");
    expect(ran.map((request) => request.jobId)).toEqual(["j-new"]);
  });

  it("tracks watermarks per container and op", async () => {
    const { runner, ran } = runnerWithSpy();
    runner.submit(syncKeys("j-keys", 6));
    runner.submit({
      op: "refresh-credentials",
      jobId: "j-creds",
      containerId: "c-1",
      dashboardUrl: "https://workbench.example",
      sealedCredentials: "sealed",
      revision: 3,
    });

    expect((await settled(runner, "j-creds")).status).toBe("succeeded");
    expect(ran.map((request) => request.jobId)).toEqual(["j-keys", "j-creds"]);
  });

  it("runs unversioned snapshots from older control planes as before", async () => {
    const { runner, ran } = runnerWithSpy();
    runner.submit(syncKeys("j-versioned", 6));
    runner.submit(syncKeys("j-unversioned"));

    expect((await settled(runner, "j-unversioned")).status).toBe("succeeded");
    expect(ran.map((request) => request.jobId)).toEqual(["j-versioned", "j-unversioned"]);
  });
});
