import { describe, expect, it } from "vitest";
import {
  generateEd25519Keypair,
  generateX25519Keypair,
  sealJson,
  type JobRequest,
} from "@codestation/contract";
import type { DaemonConfig } from "../src/config.js";
import { containerName, homeVolumeName, Incus, type ExecFn } from "../src/incus.js";
import { JobRunner } from "../src/jobs.js";
import { Provisioner } from "../src/provisioner.js";

const hostKeys = generateX25519Keypair();

function makeConfig(): DaemonConfig {
  return {
    hostId: "host-1",
    listenPort: 8443,
    workerRpcPublicKey: generateEd25519Keypair().publicKey,
    x25519PrivateKey: hostKeys.privateKey,
    baseImage: "codestation-base",
    storagePool: "default",
  };
}

interface Call {
  args: string[];
  stdin?: string;
}

function fakeExec(calls: Call[], respond?: (args: string[]) => string): ExecFn {
  return async (_cmd, args, stdin) => {
    calls.push({ args, stdin });
    // Fresh provision: the container and volume don't exist yet.
    if (args[0] === "info" || (args[0] === "storage" && args[2] === "show")) {
      throw new Error("not found");
    }
    return { stdout: respond ? respond(args) : "", stderr: "" };
  };
}

function provisionRequest(sealed?: string): JobRequest {
  return {
    op: "provision",
    jobId: "job-1",
    containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    spec: { agents: ["claude"], tier: "free", cpu: 1, ramMb: 2048, diskGb: 8, sshPort: 30500 },
    sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test@laptop"],
    dashboardUrl: "https://codestation.example",
    ...(sealed ? { sealedCredentials: sealed } : {}),
  };
}

describe("naming", () => {
  it("derives stable incus names from container ids", () => {
    expect(containerName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("cs-aaaaaaaabbbb");
    expect(homeVolumeName("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe("home-cs-aaaaaaaabbbb");
  });
});

describe("provision command construction", () => {
  it("creates volume, init with limits, home + ssh proxy devices, and starts", async () => {
    const calls: Call[] = [];
    const provisioner = new Provisioner(
      new Incus(
        fakeExec(calls, (args) =>
          args.join(" ").includes("ssh-keygen") ? "256 SHA256:abc root@cs (ED25519)\n" : "",
        ),
      ),
      makeConfig(),
    );
    const result = await provisioner.run(provisionRequest());

    const flat = calls.map((c) => c.args.join(" "));
    expect(flat).toContainEqual(expect.stringContaining("storage volume create default home-cs-aaaaaaaabbbb size=8GiB"));
    const init = flat.find((f) => f.startsWith("init codestation-base cs-aaaaaaaabbbb"));
    expect(init).toContain("limits.cpu=1");
    expect(init).toContain("limits.memory=2048MiB");
    expect(init).toContain("boot.autostart=true");
    expect(init).toContain("user.codestation.id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(flat).toContainEqual(
      expect.stringContaining("config device add cs-aaaaaaaabbbb home disk pool=default source=home-cs-aaaaaaaabbbb path=/home/dev"),
    );
    expect(flat).toContainEqual(
      expect.stringContaining("config device add cs-aaaaaaaabbbb ssh proxy listen=tcp:0.0.0.0:30500 connect=tcp:127.0.0.1:22"),
    );
    expect(flat).toContainEqual(expect.stringContaining("start cs-aaaaaaaabbbb"));
    expect(result?.hostKeyFingerprints).toEqual(["256 SHA256:abc root@cs (ED25519)"]);
  });

  it("pipes authorized_keys via stdin with 0600/dev ownership", async () => {
    const calls: Call[] = [];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(provisionRequest());
    const write = calls.find((c) => c.stdin?.includes("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA"));
    expect(write).toBeDefined();
    const script = write!.args.join(" ");
    expect(script).toContain("authorized_keys");
    expect(script).toContain("chown dev:dev");
    expect(script).toContain("chmod 0600");
  });

  it("unseals credentials in memory and writes them 0600 — never into argv", async () => {
    const calls: Call[] = [];
    const sealed = sealJson(
      { llmKeys: { anthropic: "CANARY-anthropic-abc123" }, cloudflareToken: "CANARY-cf-xyz" },
      hostKeys.publicKey,
    );
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(provisionRequest(sealed));

    const envWrite = calls.find((c) => c.stdin?.includes("ANTHROPIC_API_KEY"));
    expect(envWrite?.stdin).toContain("CANARY-anthropic-abc123");
    expect(envWrite?.stdin).toContain("CLOUDFLARE_API_TOKEN");
    expect(envWrite?.args.join(" ")).toContain("chmod 0600");
    // Secrets hygiene: credential values never appear in command arguments.
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain("CANARY-");
    }
  });

  it("installs every selected agent in one idempotent script", async () => {
    const calls: Call[] = [];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    const req = provisionRequest();
    (req as Extract<JobRequest, { op: "provision" }>).spec.agents = ["claude", "codex", "pi"];
    await provisioner.run(req);
    const install = calls.map((c) => c.args.join(" ")).find((f) => f.includes("npm install -g"));
    expect(install).toContain("@anthropic-ai/claude-code");
    expect(install).toContain("@openai/codex");
    expect(install).toContain("@earendil-works/pi-coding-agent");
  });

  it("writes a pasted Codex subscription auth.json to ~/.codex, 0600 — never into argv", async () => {
    const calls: Call[] = [];
    const sealed = sealJson(
      { llmKeys: { codex_subscription_token: '{"tokens":"CANARY-codex-123"}' } },
      hostKeys.publicKey,
    );
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(provisionRequest(sealed));

    const authWrite = calls.find((c) => c.stdin?.includes("CANARY-codex-123"));
    expect(authWrite).toBeDefined();
    const script = authWrite!.args.join(" ");
    expect(script).toContain(".codex/auth.json");
    expect(script).toContain("chmod 0600");
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain("CANARY-");
    }
  });

  it("removes authorized_keys entirely on the no-key path (fail closed)", async () => {
    const calls: Call[] = [];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run({ ...provisionRequest(), sshKeys: [] } as JobRequest);
    const flat = calls.map((c) => c.args.join(" "));
    expect(flat).toContainEqual(expect.stringContaining("rm -f /home/dev/.ssh/authorized_keys"));
  });

  it("fails the job when the sealed payload was sealed to the wrong key", async () => {
    const wrongKey = generateX25519Keypair();
    const sealed = sealJson({ llmKeys: { openai: "x" } }, wrongKey.publicKey);
    const provisioner = new Provisioner(new Incus(fakeExec([])), makeConfig());
    await expect(provisioner.run(provisionRequest(sealed))).rejects.toThrow();
  });
});

describe("resize / destroy", () => {
  it("resize raises cgroup limits and grows the home volume", async () => {
    const calls: Call[] = [];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run({
      op: "resize",
      jobId: "j",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      spec: { agents: ["claude"], tier: "paid", cpu: 2, ramMb: 4096, diskGb: 32, sshPort: 30500 },
    });
    const flat = calls.map((c) => c.args.join(" "));
    expect(flat).toContain("config set cs-aaaaaaaabbbb limits.cpu=2");
    expect(flat).toContain("config set cs-aaaaaaaabbbb limits.memory=4096MiB");
    expect(flat).toContain("storage volume set default home-cs-aaaaaaaabbbb size=32GiB");
  });

  it("destroy is idempotent when the container is already gone", async () => {
    const provisioner = new Provisioner(new Incus(fakeExec([])), makeConfig());
    await expect(
      provisioner.run({ op: "destroy", jobId: "j", containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    ).resolves.toBeNull();
  });
});

describe("job runner", () => {
  it("runs jobs async and reports terminal status; re-delivery is idempotent", async () => {
    const provisioner = new Provisioner(new Incus(fakeExec([])), makeConfig());
    const runner = new JobRunner(provisioner);
    const req: JobRequest = { op: "stop", jobId: "j-stop", containerId: "c-1" };
    const rec = runner.submit(req);
    expect(rec.status === "queued" || rec.status === "running").toBe(true);
    expect(runner.submit(req)).toBe(rec);
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.get("j-stop")?.status).toBe("succeeded");
  });

  it("captures failures with the error message", async () => {
    const failingExec: ExecFn = async () => {
      throw new Error("incus exploded");
    };
    const runner = new JobRunner(new Provisioner(new Incus(failingExec), makeConfig()));
    runner.submit({ op: "start", jobId: "j-fail", containerId: "c-2" });
    await new Promise((r) => setTimeout(r, 50));
    const rec = runner.get("j-fail");
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toContain("incus exploded");
  });
});
