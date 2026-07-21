import { describe, expect, it } from "vitest";
import { Incus, shellQuote, type ExecFn } from "../src/incus.js";

function capture(): { calls: Array<{ args: string[]; stdin?: string }>; exec: ExecFn } {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const exec: ExecFn = async (_cmd, args, stdin) => {
    calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
    return { stdout: "", stderr: "" };
  };
  return { calls, exec };
}

describe("shellQuote", () => {
  it("wraps in single quotes and escapes embedded single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$HOME `whoami` \"x\"")).toBe(`'$HOME \`whoami\` "x"'`);
  });

  it("neutralizes command injection in interpolated values", () => {
    const quoted = shellQuote("'; rm -rf / #");
    // The payload's quote is escaped, so the whole thing stays one sh word.
    expect(quoted).toBe(`''\\''; rm -rf / #'`);
  });
});

describe("Incus.writeFile", () => {
  it("pipes content via stdin (never argv) and applies owner/mode", async () => {
    const { calls, exec } = capture();
    await new Incus(exec).writeFile("cs-x", "/home/dev/.secret", "TOP-SECRET", {
      owner: "dev:dev",
      mode: "0600",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.stdin).toBe("TOP-SECRET");
    const script = call.args.join(" ");
    expect(script).not.toContain("TOP-SECRET");
    expect(script).toContain("mkdir -p '/home/dev'");
    expect(script).toContain("cat > '/home/dev/.secret'");
    expect(script).toContain("chown dev:dev");
    expect(script).toContain("chmod 0600");
  });

  it("defaults to root-owned 0644", async () => {
    const { calls, exec } = capture();
    await new Incus(exec).writeFile("cs-x", "/etc/motd", "hello");
    const script = calls[0]!.args.join(" ");
    expect(script).toContain("chown root:root");
    expect(script).toContain("chmod 0644");
  });
});

describe("Incus.list", () => {
  it("parses names, status, and config; tolerates missing config", async () => {
    const exec: ExecFn = async () => ({
      stdout: JSON.stringify([
        { name: "cs-a", status: "Running", config: { "user.workbench.id": "id-1" } },
        { name: "plain", status: "Stopped" },
      ]),
      stderr: "",
    });
    const list = await new Incus(exec).list();
    expect(list).toEqual([
      { name: "cs-a", status: "Running", config: { "user.workbench.id": "id-1" } },
      { name: "plain", status: "Stopped", config: {} },
    ]);
  });

  it("queries one container's current status", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify([{ name: "cs-a", status: "Stopped" }]),
        stderr: "",
      };
    };

    await expect(new Incus(exec).status("cs-a")).resolves.toBe("Stopped");
    expect(calls[0]).toEqual(["list", "cs-a", "--format", "json"]);
  });

  it("scopes every operation to the configured tenant project", async () => {
    const { calls, exec } = capture();
    await new Incus(exec, "incus", "workbench").exists("cs-x");
    expect(calls[0]?.args).toEqual([
      "--project",
      "workbench",
      "info",
      "cs-x",
    ]);
  });
});

describe("Incus disk limits", () => {
  it("overrides the inherited root device with a hard size", async () => {
    const { calls, exec } = capture();
    await new Incus(exec).setRootDiskLimit("cs-x", 8);
    expect(calls[0]?.args).toEqual([
      "config",
      "device",
      "override",
      "cs-x",
      "root",
      "size=8GiB",
    ]);
  });
});

describe("Incus.exists / volumeExists", () => {
  it("maps command failure to false", async () => {
    const exec: ExecFn = async () => {
      throw new Error("not found");
    };
    const incus = new Incus(exec);
    expect(await incus.exists("cs-x")).toBe(false);
    expect(await incus.volumeExists("default", "home-x")).toBe(false);
  });
});
