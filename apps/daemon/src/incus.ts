/**
 * Thin wrapper over the incus CLI (local Unix socket). The exec function is
 * injectable so unit tests can assert exact command construction (§18 L2).
 * Secrets are passed via stdin only — never argv (visible in /proc) and never
 * temp files.
 */
import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, args: string[], stdin?: string) => Promise<ExecResult>;

export const realExec: ExecFn = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")}… failed: ${stderr || err.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    // Always close stdin so commands that read it see EOF instead of hanging.
    if (child.stdin) {
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    }
  });

/** Single-quote a string for POSIX sh. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function containerName(containerId: string): string {
  return `cs-${containerId.replace(/-/g, "").slice(0, 12)}`;
}

export function homeVolumeName(containerId: string): string {
  return `home-${containerName(containerId)}`;
}

interface IncusContainer {
  name: string;
  status: string;
  config: Record<string, string>;
}

const TENANT_PROCESS_LIMIT = 1024;

/**
 * Typed absence signal. Production failures arrive as wrapped incus stderr
 * (matched by pattern below); tests inject this class so a generic
 * `Error("not found")` is never mistaken for container absence.
 */
export class IncusNotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "IncusNotFoundError";
  }
}

function isExplicitNotFound(error: unknown): boolean {
  if (error instanceof IncusNotFoundError) return true;
  if (!(error instanceof Error)) return false;
  return /(?:Instance|Storage.*volume).*not found/i.test(error.message);
}

export class Incus {
  constructor(
    private exec: ExecFn = realExec,
    private bin = "incus",
    private project = "default",
  ) {}

  private run(args: string[], stdin?: string): Promise<ExecResult> {
    const scoped = this.project === "default" ? args : ["--project", this.project, ...args];
    return this.exec(this.bin, scoped, stdin);
  }

  private async listMatching(name?: string): Promise<IncusContainer[]> {
    const { stdout } = await this.run([
      "list",
      ...(name ? [name] : []),
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(stdout) as Array<{
      name: string;
      status: string;
      config?: Record<string, string>;
    }>;
    return parsed.map((container) => ({
      name: container.name,
      status: container.status,
      config: container.config ?? {},
    }));
  }

  list(): Promise<IncusContainer[]> {
    return this.listMatching();
  }

  async status(name: string): Promise<string | null> {
    const containers = await this.listMatching(name);
    return containers.find((container) => container.name === name)?.status ?? null;
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.run(["info", name]);
      return true;
    } catch (error) {
      if (isExplicitNotFound(error)) return false;
      throw error;
    }
  }

  async volumeExists(pool: string, volume: string): Promise<boolean> {
    try {
      await this.run(["storage", "volume", "show", pool, volume]);
      return true;
    } catch (error) {
      if (isExplicitNotFound(error)) return false;
      throw error;
    }
  }

  async createHomeVolume(pool: string, volume: string, sizeGb: number): Promise<void> {
    await this.run(["storage", "volume", "create", pool, volume, `size=${sizeGb}GiB`]);
  }

  async resizeHomeVolume(pool: string, volume: string, sizeGb: number): Promise<void> {
    await this.run(["storage", "volume", "set", pool, volume, `size=${sizeGb}GiB`]);
  }

  async deleteHomeVolume(pool: string, volume: string): Promise<void> {
    await this.run(["storage", "volume", "delete", pool, volume]);
  }

  async init(
    image: string,
    name: string,
    containerId: string,
    cpu: number,
    ramMb: number,
    swapMb: number,
  ): Promise<void> {
    await this.run([
      "init",
      image,
      name,
      "-c", `limits.cpu=${cpu}`,
      "-c", `limits.cpu.allowance=${cpu * 100}%`,
      "-c", `limits.memory=${ramMb}MiB`,
      "-c", "limits.memory.enforce=hard",
      "-c", `limits.memory.swap=${swapMb > 0 ? `${swapMb}MiB` : "false"}`,
      "-c", `limits.processes=${TENANT_PROCESS_LIMIT}`,
      "-c", "boot.autostart=last-state",
      "-c", "boot.autorestart=false",
      "-c", "security.privileged=false",
      "-c", "security.idmap.isolated=true",
      "-c", "security.nesting=false",
      "-c", `user.workbench.id=${containerId}`,
    ]);
  }

  async setLimits(name: string, cpu: number, ramMb: number, swapMb: number): Promise<void> {
    await this.run(["config", "set", name, `limits.cpu=${cpu}`]);
    await this.run(["config", "set", name, `limits.cpu.allowance=${cpu * 100}%`]);
    const setMemory = () => this.run(["config", "set", name, `limits.memory=${ramMb}MiB`]);
    const setSwap = () => this.run([
      "config", "set", name, `limits.memory.swap=${swapMb > 0 ? `${swapMb}MiB` : "false"}`,
    ]);
    // Add swap before a RAM downgrade; raise RAM before removing swap on an
    // upgrade. This avoids a transient lower combined ceiling in either path.
    if (swapMb > 0) {
      await setSwap();
      await setMemory();
    } else {
      await setMemory();
      await setSwap();
    }
  }

  /** Cap the disposable root filesystem inherited from the default profile. */
  async setRootDiskLimit(name: string, sizeGb: number): Promise<void> {
    await this.run([
      "config",
      "device",
      "override",
      name,
      "root",
      `size=${sizeGb}GiB`,
    ]);
  }

  async attachHome(name: string, pool: string, volume: string): Promise<void> {
    await this.run([
      "config", "device", "add", name, "home", "disk",
      `pool=${pool}`, `source=${volume}`, "path=/home/dev",
    ]);
  }

  async addSshProxy(name: string, hostPort: number): Promise<void> {
    await this.run([
      "config", "device", "add", name, "ssh", "proxy",
      `listen=tcp:0.0.0.0:${hostPort}`, "connect=tcp:127.0.0.1:22",
    ]);
  }

  async start(name: string): Promise<void> {
    await this.run(["start", name]);
  }

  async stop(name: string): Promise<void> {
    await this.run(["stop", name, "--force"]);
  }

  async delete(name: string): Promise<void> {
    await this.run(["delete", name, "--force"]);
  }

  /** Run a shell command inside the container; content may be piped via stdin. */
  async shell(name: string, script: string, stdin?: string): Promise<ExecResult> {
    return this.run(["exec", name, "--", "sh", "-c", script], stdin);
  }

  /** Write a file inside the container from memory (stdin -> cat), with owner/mode. */
  async writeFile(
    name: string,
    path: string,
    content: string,
    opts: { owner?: string; mode?: string } = {},
  ): Promise<void> {
    const { owner = "root:root", mode = "0644" } = opts;
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const q = shellQuote;
    await this.shell(
      name,
      `mkdir -p ${q(dir)} && cat > ${q(path)} && chown ${owner} ${q(path)} && chmod ${mode} ${q(path)}`,
      content,
    );
  }

  /** Wait until the container's init system is ready to run commands. */
  async waitReady(name: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        await this.shell(name, "test -d /run/systemd/system && id dev >/dev/null 2>&1");
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`container ${name} not ready: ${String(lastErr)}`);
  }

  async hostKeyFingerprints(name: string): Promise<string[]> {
    const { stdout } = await this.shell(
      name,
      "for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf \"$f\"; done",
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }
}
