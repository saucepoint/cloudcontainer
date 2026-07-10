import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function writeConfig(value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "cs-daemon-test-")), "daemon.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const required = {
  hostId: "host-1",
  workerRpcPublicKey: "pub",
  x25519PrivateKey: "priv",
};

describe("loadConfig", () => {
  it("applies defaults for optional fields", () => {
    const config = loadConfig(writeConfig(required));
    expect(config).toMatchObject({
      ...required,
      listenPort: 8443,
      baseImage: "codestation-base",
      storagePool: "default",
    });
    expect(config.tlsCertPath).toBeUndefined();
  });

  it("keeps explicit values", () => {
    const config = loadConfig(
      writeConfig({ ...required, listenPort: 9000, storagePool: "tank", baseImage: "custom" }),
    );
    expect(config.listenPort).toBe(9000);
    expect(config.storagePool).toBe("tank");
    expect(config.baseImage).toBe("custom");
  });

  it.each(["hostId", "workerRpcPublicKey", "x25519PrivateKey"] as const)(
    "rejects a config missing %s",
    (field) => {
      const bad: Record<string, unknown> = { ...required };
      delete bad[field];
      expect(() => loadConfig(writeConfig(bad))).toThrow(field);
    },
  );

  it("throws on an unreadable path", () => {
    expect(() => loadConfig("/nonexistent/daemon.json")).toThrow();
  });
});
