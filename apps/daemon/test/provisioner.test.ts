import { describe, expect, it } from "vitest";
import {
  generateEd25519Keypair,
  generateX25519Keypair,
  sealJson,
  type JobRequest,
} from "@workbench/contract";
import type { DaemonConfig } from "../src/config.js";
import { containerName, homeVolumeName, Incus, IncusNotFoundError, type ExecFn } from "../src/incus.js";
import { JobConflictError, JobRunner } from "../src/jobs.js";
import { Provisioner } from "../src/provisioner.js";

const hostKeys = generateX25519Keypair();

function makeConfig(): DaemonConfig {
  return {
    hostId: "host-1",
    listenPort: 8443,
    workerRpcPublicKey: generateEd25519Keypair().publicKey,
    x25519PrivateKey: hostKeys.privateKey,
    baseImage: "workbench-base",
    storagePool: "default",
    project: "default",
  };
}

interface Call {
  args: string[];
  stdin?: string;
}

function fakeExec(calls: Call[], respond?: (args: string[]) => string): ExecFn {
  return async (_cmd, args, stdin) => {
    calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
    // Fresh provision: the container and volume don't exist yet.
    if (args[0] === "info" || (args[0] === "storage" && args[2] === "show")) {
      throw new IncusNotFoundError();
    }
    const stdout = respond ? respond(args) : "";
    if (args[0] === "list" && !stdout) {
      return {
        stdout: JSON.stringify([{ name: args[1], status: "Running" }]),
        stderr: "",
      };
    }
    return { stdout, stderr: "" };
  };
}

function provisionRequest(sealed?: string): Extract<JobRequest, { op: "provision" }> {
  return {
    op: "provision",
    jobId: "job-1",
    containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    spec: { agents: ["claude"], tier: "free", cpu: 1, ramMb: 2048, diskGb: 8, sshPort: 30500 },
    sshKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test@laptop"],
    dashboardUrl: "https://workbench.example",
    githubRepos: [],
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
    const init = flat.find((f) => f.startsWith("init workbench-base cs-aaaaaaaabbbb"));
    expect(init).toContain("limits.cpu=2");
    expect(init).toContain("limits.cpu.allowance=200%");
    expect(init).toContain("limits.memory=2048MiB");
    expect(init).toContain("limits.memory.enforce=hard");
    // Restricted Incus projects classify limits.memory.swap as low-level
    // configuration. This host policy therefore relies on swap being absent.
    expect(init).not.toContain("limits.memory.swap");
    expect(init).toContain("limits.processes=1024");
    expect(init).toContain("boot.autostart=last-state");
    expect(init).toContain("boot.autorestart=false");
    expect(init).toContain("security.privileged=false");
    expect(init).toContain("security.idmap.isolated=true");
    // Incus defaults isolated maps to 65,536 IDs and restricted projects
    // reject an explicit security.idmap.size as low-level configuration.
    expect(init).not.toContain("security.idmap.size");
    expect(init).toContain("security.nesting=false");
    expect(init).toContain("user.workbench.id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(flat).toContain(
      "config device override cs-aaaaaaaabbbb root size=8GiB",
    );
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

  it("preconfigures gh and clones selected repositories directly under ~/repos", async () => {
    const calls: Call[] = [];
    const sealed = sealJson(
      { githubToken: "CANARY-gh-access", githubLogin: "octocat" },
      hostKeys.publicKey,
    );
    const request = provisionRequest(sealed);
    request.githubRepos = ["octocat/hello-world", "acme/private-repo"];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(request);

    const ghConfig = calls.find((call) => call.stdin?.includes("oauth_token"));
    expect(ghConfig?.stdin).toContain("CANARY-gh-access");
    expect(ghConfig?.stdin).toContain("user: octocat");
    const commands = calls.map((call) => call.args.join(" "));
    const ghDirectoryChown = commands.findIndex((command) =>
      command.includes("chown dev:dev /home/dev/.config/gh"),
    );
    const firstClone = commands.findIndex((command) => command.includes("gh repo clone"));
    expect(ghDirectoryChown).toBeGreaterThanOrEqual(0);
    expect(firstClone).toBeGreaterThan(ghDirectoryChown);
    expect(commands.some((command) =>
      command.includes("gh auth setup-git --hostname github.com")
    )).toBe(true);
    expect(commands.some((command) => command.includes("credential.helper store"))).toBe(false);
    expect(calls.some((call) => call.stdin?.includes("https://x-access-token:"))).toBe(false);
    expect(commands.some((command) =>
      command.includes("gh repo clone") &&
      command.includes("octocat/hello-world") &&
      command.includes("/home/dev/repos/hello-world"),
    )).toBe(true);
    expect(commands.some((command) =>
      command.includes("gh repo clone") &&
      command.includes("acme/private-repo") &&
      command.includes("/home/dev/repos/private-repo"),
    )).toBe(true);
    expect(commands.filter((command) => command.includes("gh repo clone"))).toHaveLength(2);
    for (const command of commands) expect(command).not.toContain("CANARY-");
  });

  it("rejects repository selections that would clone into the same directory", async () => {
    const calls: Call[] = [];
    const request = provisionRequest();
    request.githubRepos = ["octocat/project", "acme/project"];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());

    await expect(provisioner.run(request)).rejects.toThrow(
      "selected GitHub repositories must have unique names",
    );
    expect(calls).toHaveLength(0);
  });

  it("installs every selected agent in one idempotent script", async () => {
    const calls: Call[] = [];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    const req = provisionRequest();
    (req as Extract<JobRequest, { op: "provision" }>).spec.agents = ["claude", "codex", "pi"];
    await provisioner.run(req);
    const install = calls.map((c) => c.args.join(" ")).find((f) => f.includes("npm install -g"));
    expect(install).toContain("command -v claude");
    expect(install).toContain("command -v codex");
    expect(install).toContain("command -v pi");
    expect(install).toContain("@anthropic-ai/claude-code");
    expect(install).toContain("@openai/codex");
    expect(install).toContain("@earendil-works/pi-coding-agent");
    const selectedAgents = calls.find((call) =>
      call.args.join(" ").includes("/etc/workbench-agents"),
    );
    expect(selectedAgents?.stdin).toBe("claude\ncodex\npi\n");
  });

  it("cleans a failed rootfs and can retry fresh provision without deleting home", async () => {
    const calls: Call[] = [];
    let rootExists = false;
    let homeExists = false;
    let failInstall = true;
    let failCleanupDelete = true;
    const exec: ExecFn = async (_cmd, args, stdin) => {
      calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
      if (args[0] === "info") {
        if (!rootExists) throw new IncusNotFoundError();
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "storage" && args[1] === "volume" && args[2] === "show") {
        if (!homeExists) throw new IncusNotFoundError();
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "storage" && args[1] === "volume" && args[2] === "create") {
        homeExists = true;
      } else if (args[0] === "init") {
        if (rootExists) throw new Error("container already exists");
        rootExists = true;
      } else if (args[0] === "delete") {
        if (failCleanupDelete) {
          failCleanupDelete = false;
          throw new Error("cleanup delete fault");
        }
        rootExists = false;
      } else if (args.join(" ").includes("npm install -g") && failInstall) {
        failInstall = false;
        throw new Error("installer fault");
      }
      return {
        stdout: args.join(" ").includes("ssh-keygen") ? "256 SHA256:abc root@cs (ED25519)\n" : "",
        stderr: "",
      };
    };
    const provisioner = new Provisioner(new Incus(exec), makeConfig());

    await expect(provisioner.run(provisionRequest())).rejects.toThrow("installer fault");
    expect(rootExists).toBe(true); // best-effort cleanup was attempted but faulted
    expect(homeExists).toBe(true);

    await expect(provisioner.run(provisionRequest())).resolves.toMatchObject({
      hostKeyFingerprints: ["256 SHA256:abc root@cs (ED25519)"],
    });
    expect(rootExists).toBe(true);
    expect(calls.filter((c) => c.args.slice(0, 3).join(" ") === "storage volume create")).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === "init")).toHaveLength(2);
    expect(calls.filter((c) => c.args[0] === "delete")).toHaveLength(2);
    expect(calls.some((c) => c.args.slice(0, 3).join(" ") === "storage volume delete")).toBe(false);
  });

  it("writes the Codex subscription auth.json to ~/.codex, 0600 — never into argv", async () => {
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

  it("marks Claude onboarding complete when its subscription token is injected", async () => {
    const calls: Call[] = [];
    const sealed = sealJson(
      { llmKeys: { claude_subscription_token: "CANARY-oat01-claude-123" } },
      hostKeys.publicKey,
    );
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(provisionRequest(sealed));

    const envWrite = calls.find((c) => c.stdin?.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    expect(envWrite?.stdin).toContain("CANARY-oat01-claude-123");

    const stateMerge = calls.find((c) => c.stdin?.includes("hasCompletedOnboarding"));
    expect(stateMerge?.stdin).toContain('current.hasCompletedOnboarding = true');
    expect(stateMerge?.stdin).toContain('/home/dev/.claude.json');
    expect(stateMerge?.stdin).toContain('fs.renameSync(temp, file)');
    expect(stateMerge?.stdin).toContain('fs.rmSync(__filename)');
    expect(stateMerge?.args.join(" ")).toContain("chmod 0600");
    expect(calls.map((c) => c.args.join(" "))).toContainEqual(
      expect.stringContaining("claude-state-merge.cjs"),
    );
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain("CANARY-");
    }
  });

  it("configures selected Pi and OpenCode with ChatGPT and Claude subscription OAuth", async () => {
    const calls: Call[] = [];
    const codexAuth = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "CANARY-codex-id",
        access_token: "CANARY-codex-access",
        refresh_token: "CANARY-codex-refresh",
        account_id: "acct-42",
      },
      last_refresh: "2026-07-17T10:00:00.000Z",
    });
    const sealed = sealJson(
      {
        llmKeys: {
          claude_subscription_token: "CANARY-oat01-claude-123",
          codex_subscription_token: codexAuth,
        },
      },
      hostKeys.publicKey,
    );
    const request = provisionRequest(sealed);
    request.spec.agents = ["pi", "opencode"];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(request);

    const piMerge = calls.find((c) => c.stdin?.includes("/home/dev/.pi/agent/auth.json"));
    expect(piMerge?.stdin).toContain('"anthropic":{"type":"oauth"');
    expect(piMerge?.stdin).toContain('"openai-codex":{"type":"oauth"');
    expect(piMerge?.stdin).toContain('"access":"CANARY-codex-access"');
    expect(piMerge?.stdin).toContain('"refresh":"CANARY-codex-refresh"');
    expect(piMerge?.stdin).toContain("...current, ...add");
    expect(piMerge?.stdin).toContain("fs.chmodSync(file, 0o600)");

    const opencodeMerge = calls.find((c) =>
      c.stdin?.includes("/home/dev/.local/share/opencode/auth.json"),
    );
    expect(opencodeMerge?.stdin).toContain('"anthropic":{"type":"oauth"');
    expect(opencodeMerge?.stdin).toContain('"openai":{"type":"oauth"');
    expect(opencodeMerge?.stdin).toContain('"accountId":"acct-42"');
    expect(opencodeMerge?.stdin).toContain('"access":"CANARY-oat01-claude-123"');
    expect(opencodeMerge?.stdin).toContain("...current, ...add");
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain("CANARY-");
    }
  });

  it("does not configure unselected open-source agents with subscription OAuth", async () => {
    const calls: Call[] = [];
    const sealed = sealJson(
      {
        llmKeys: {
          claude_subscription_token: "CANARY-oat01-claude-123",
          codex_subscription_token: JSON.stringify({
            tokens: {
              access_token: "CANARY-codex-access",
              refresh_token: "CANARY-codex-refresh",
            },
          }),
        },
      },
      hostKeys.publicKey,
    );
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(provisionRequest(sealed));

    expect(calls.some((c) => c.stdin?.includes("/home/dev/.pi/agent/auth.json"))).toBe(false);
    expect(calls.some((c) => c.stdin?.includes("/home/dev/.local/share/opencode/auth.json"))).toBe(false);
  });

  it("merges Copilot and OpenCode Go into OpenCode's auth store via a self-deleting dev-run script", async () => {
    const calls: Call[] = [];
    const sealed = sealJson(
      { llmKeys: { github_copilot: "CANARY-gho-1", opencode_go: "CANARY-ocgo-1" } },
      hostKeys.publicKey,
    );
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(provisionRequest(sealed));

    // OpenCode Go is also exported as an env var; the Copilot token is file-based only.
    const envWrite = calls.find((c) => c.stdin?.includes("OPENCODE_API_KEY"));
    expect(envWrite?.stdin).toContain("CANARY-ocgo-1");
    expect(envWrite?.stdin).not.toContain("CANARY-gho-1");

    const merge = calls.find((c) => c.stdin?.includes("github-copilot"));
    expect(merge?.stdin).toContain('"refresh":"CANARY-gho-1"');
    expect(merge?.stdin).toContain('"opencode":{"type":"api","key":"CANARY-ocgo-1"}');
    expect(merge?.stdin).toContain(".local/share/opencode/auth.json");
    expect(merge?.stdin).toContain("rmSync(__filename)");
    const flat = calls.map((c) => c.args.join(" "));
    expect(flat).toContainEqual(expect.stringContaining("opencode-auth-merge.cjs"));
    // Secrets hygiene: tokens travel via stdin, never in command arguments.
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain("CANARY-");
    }
  });

  it("writes wrangler's config/default.toml from the OAuth payload, 0600 — never into argv", async () => {
    const calls: Call[] = [];
    const sealed = sealJson(
      {
        wranglerOauth: JSON.stringify({
          oauth_token: "CANARY-wr-access",
          refresh_token: "CANARY-wr-refresh",
          expiration_time: "2026-07-10T00:00:00.000Z",
          scopes: ["account:read", "workers:write"],
        }),
      },
      hostKeys.publicKey,
    );
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run(provisionRequest(sealed));

    const toml = calls.find((c) => c.stdin?.includes("oauth_token"));
    expect(toml).toBeDefined();
    expect(toml!.args.join(" ")).toContain(".wrangler/config/default.toml");
    expect(toml!.args.join(" ")).toContain("chmod 0600");
    expect(toml!.stdin).toContain('oauth_token = "CANARY-wr-access"');
    expect(toml!.stdin).toContain('refresh_token = "CANARY-wr-refresh"');
    expect(toml!.stdin).toContain('expiration_time = "2026-07-10T00:00:00.000Z"');
    expect(toml!.stdin).toContain('scopes = ["account:read", "workers:write"]');
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

  it("rejects a decrypted credential payload that does not match the contract", async () => {
    const sealed = sealJson({ llmKeys: { openai: 42 } }, hostKeys.publicKey);
    const calls: Call[] = [];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());

    await expect(provisioner.run(provisionRequest(sealed))).rejects.toThrow(
      "invalid sealed credential payload",
    );
    expect(calls).toHaveLength(0);
  });

  it("fails credential refresh when selected-agent metadata cannot be read", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args.join(" ").includes("/etc/workbench-agents")) {
        throw new Error("agent metadata unavailable");
      }
      return { stdout: "", stderr: "" };
    };
    const provisioner = new Provisioner(new Incus(exec), makeConfig());

    await expect(provisioner.run({
      op: "refresh-credentials",
      jobId: "j-agent-metadata",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      dashboardUrl: "https://workbench.example",
      sealedCredentials: sealJson({}, hostKeys.publicKey),
    })).rejects.toThrow("agent metadata unavailable");
  });

  it("does not mask a command-level metadata read failure", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const script = args.at(-1) ?? "";
      if (script.includes("/etc/workbench-agents")) {
        if (/\btrue\s*$/.test(script)) return { stdout: "", stderr: "metadata read failed" };
        throw new Error("metadata read failed");
      }
      return { stdout: "", stderr: "" };
    };
    const provisioner = new Provisioner(new Incus(exec), makeConfig());

    await expect(provisioner.run({
      op: "refresh-credentials",
      jobId: "j-agent-metadata-command",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      dashboardUrl: "https://workbench.example",
      sealedCredentials: sealJson({}, hostKeys.publicKey),
    })).rejects.toThrow("metadata read failed");
  });

  it("rejects malformed Wrangler auth without exposing its contents in the error", async () => {
    const sealed = sealJson(
      { wranglerOauth: '{"oauth_token":"CANARY-secret"}' },
      hostKeys.publicKey,
    );
    const calls: Call[] = [];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());

    const error = await provisioner.run({
      op: "refresh-credentials",
      jobId: "j-invalid-wrangler",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      dashboardUrl: "https://workbench.example",
      sealedCredentials: sealed,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("invalid Wrangler OAuth payload");
    expect((error as Error).message).not.toContain("CANARY");
    expect(calls.every((call) => call.stdin === undefined)).toBe(true);
  });
});

describe("resize / destroy", () => {
  it("applies a stopped container's latest key and credential snapshot on start", async () => {
    const calls: Call[] = [];
    const sealed = sealJson(
      { llmKeys: { anthropic: "CANARY-after-stop" } },
      hostKeys.publicKey,
    );
    const provisioner = new Provisioner(
      new Incus(fakeExec(calls, (args) => args[0] === "list"
        ? JSON.stringify([{ name: "cs-aaaaaaaabbbb", status: "Stopped" }])
        : "")),
      makeConfig(),
    );

    await provisioner.run({
      op: "start",
      jobId: "j-start",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      sshKeys: ["ssh-ed25519 AAAA new-laptop"],
      dashboardUrl: "https://workbench.example",
      sealedCredentials: sealed,
    });

    expect(calls.map((call) => call.args.join(" "))).toContain("start cs-aaaaaaaabbbb");
    expect(calls.some((call) => call.stdin?.includes("ssh-ed25519 AAAA new-laptop"))).toBe(true);
    expect(calls.some((call) => call.stdin?.includes("CANARY-after-stop"))).toBe(true);
    expect(calls.some((call) => call.stdin?.includes("https://workbench.example"))).toBe(true);
  });

  it("retries start setup without starting an already-running container again", async () => {
    const calls: Call[] = [];
    let status = "Stopped";
    let metadataReads = 0;
    const exec: ExecFn = async (_cmd, args, stdin) => {
      calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
      if (args[0] === "list") {
        return {
          stdout: JSON.stringify([{ name: "cs-aaaaaaaabbbb", status }]),
          stderr: "",
        };
      }
      if (args[0] === "start") {
        status = "Running";
        return { stdout: "", stderr: "" };
      }
      if (args.join(" ").includes("/etc/workbench-agents")) {
        metadataReads += 1;
        if (metadataReads === 1) throw new Error("metadata temporarily unavailable");
        return { stdout: "claude\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const provisioner = new Provisioner(new Incus(exec), makeConfig());
    const request: JobRequest = {
      op: "start",
      jobId: "retry-start",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      sshKeys: [],
      dashboardUrl: "https://workbench.example",
      sealedCredentials: sealJson({}, hostKeys.publicKey),
    };

    await expect(provisioner.run(request)).rejects.toThrow("metadata temporarily unavailable");
    await expect(provisioner.run(request)).resolves.toBeNull();

    expect(calls.filter((call) => call.args[0] === "start")).toHaveLength(1);
  });

  it("does not stop an already-stopped container again", async () => {
    const calls: Call[] = [];
    const provisioner = new Provisioner(
      new Incus(fakeExec(calls, (args) => args[0] === "list"
        ? JSON.stringify([{ name: "cs-c1", status: "Stopped" }])
        : "")),
      makeConfig(),
    );

    await provisioner.run({ op: "stop", jobId: "retry-stop", containerId: "c-1" });

    expect(calls.some((call) => call.args[0] === "stop")).toBe(false);
  });

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
    expect(flat).toContain("config set cs-aaaaaaaabbbb limits.cpu.allowance=200%");
    expect(flat).toContain("config set cs-aaaaaaaabbbb limits.memory=4096MiB");
    expect(flat).toContain("config device override cs-aaaaaaaabbbb root size=32GiB");
    expect(flat).toContain("storage volume set default home-cs-aaaaaaaabbbb size=32GiB");
  });

  it("keeps the provisioned CPU floor when the presented tier has one vCPU", async () => {
    const calls: Call[] = [];
    const provisioner = new Provisioner(new Incus(fakeExec(calls)), makeConfig());
    await provisioner.run({
      op: "resize",
      jobId: "j",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      spec: { agents: ["claude"], tier: "free", cpu: 1, ramMb: 2048, diskGb: 8, sshPort: 30500 },
    });
    const flat = calls.map((c) => c.args.join(" "));
    expect(flat).toContain("config set cs-aaaaaaaabbbb limits.cpu=2");
    expect(flat).toContain("config set cs-aaaaaaaabbbb limits.cpu.allowance=200%");
  });

  it("destroy is idempotent when the container is already gone", async () => {
    const provisioner = new Provisioner(new Incus(fakeExec([])), makeConfig());
    await expect(
      provisioner.run({ op: "destroy", jobId: "j", containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    ).resolves.toBeNull();
  });

  it("fails destroy instead of treating an unavailable Incus service as absent", async () => {
    const unavailable: ExecFn = async () => {
      throw new Error("incus service unavailable");
    };
    const provisioner = new Provisioner(new Incus(unavailable), makeConfig());

    await expect(provisioner.run({
      op: "destroy",
      jobId: "destroy-unavailable",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    })).rejects.toThrow("incus service unavailable");
  });

  it("fails destroy when the volume probe fails operationally", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "info") throw new IncusNotFoundError();
      throw new Error("storage service unavailable");
    };
    const provisioner = new Provisioner(new Incus(exec), makeConfig());

    await expect(provisioner.run({
      op: "destroy",
      jobId: "destroy-storage-unavailable",
      containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    })).rejects.toThrow("storage service unavailable");
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
    expect(runner.pendingContainerCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.get("j-stop")?.status).toBe("succeeded");
    expect(runner.pendingContainerCount()).toBe(0);
  });

  it("rejects reusing a job id for a different operation", () => {
    const runner = new JobRunner(new Provisioner(new Incus(fakeExec([])), makeConfig()));
    runner.submit({ op: "stop", jobId: "j-reused", containerId: "c-1" });

    expect(() =>
      runner.submit({ op: "start", jobId: "j-reused", containerId: "c-1" }),
    ).toThrow(JobConflictError);
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
