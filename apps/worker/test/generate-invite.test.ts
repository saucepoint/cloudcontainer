import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInviteCommand } from "../scripts/invite-command.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

describe("invite generation command", () => {
  it("scopes the dedicated npm command to staging", () => {
    const rootPackage = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(rootPackage.scripts["create:invite:staging"]).toContain("--environment staging");
  });

  it("uses staging credentials and URL when production values are exported", () => {
    const directory = mkdtempSync(join(tmpdir(), "usebench-invite-"));
    temporaryDirectories.push(directory);
    const envFile = join(directory, "staging.env");
    writeFileSync(envFile, "INVITE_ADMIN_SECRET=staging-secret\n", { mode: 0o600 });

    const command = resolveInviteCommand(["--environment", "staging"], {
      INVITE_ADMIN_SECRET: "production-secret",
      USEBENCH_URL: "https://usebench.dev",
      USEBENCH_STAGING_ENV_FILE: envFile,
    });

    expect(command).toMatchObject({
      baseUrl: "https://staging.usebench.dev",
      deployment: "staging",
      secret: "staging-secret",
      secretSource: envFile,
    });
  });

  it("does not fall back to an exported production secret", () => {
    const directory = mkdtempSync(join(tmpdir(), "usebench-invite-"));
    temporaryDirectories.push(directory);

    expect(() => resolveInviteCommand(["--environment", "staging"], {
      INVITE_ADMIN_SECRET: "production-secret",
      USEBENCH_STAGING_ENV_FILE: join(directory, "missing.env"),
    })).toThrow("Could not read staging invite credentials");
  });
});
