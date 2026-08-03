import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateEd25519Keypair, generateX25519Keypair } from "@workbench/contract";
import { loadConfig } from "../src/config.js";

function writeConfig(value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "cs-daemon-test-")), "daemon.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const required = {
  hostId: "host-1",
  workerRpcPublicKey: generateEd25519Keypair().publicKey,
  x25519PrivateKey: generateX25519Keypair().privateKey,
};

describe("loadConfig", () => {
  it("applies defaults for optional fields", () => {
    const config = loadConfig(writeConfig(required));
    expect(config).toMatchObject({
      ...required,
      hostType: "budget",
      listenPort: 8443,
      baseImage: "workbench-base",
      storagePool: "default",
      project: "default",
    });
    expect(config.tlsCertPath).toBeUndefined();
  });

  it("keeps explicit values", () => {
    const config = loadConfig(
      writeConfig({
        ...required,
        hostType: "regular",
        listenPort: 9000,
        storagePool: "tank",
        baseImage: "custom",
        project: "tenants",
      }),
    );
    expect(config.listenPort).toBe(9000);
    expect(config.hostType).toBe("regular");
    expect(config.storagePool).toBe("tank");
    expect(config.baseImage).toBe("custom");
    expect(config.project).toBe("tenants");
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

  it("rejects an unknown host type", () => {
    expect(() => loadConfig(writeConfig({ ...required, hostType: "premium-ish" })))
      .toThrow("invalid daemon host type");
  });

  it("rejects malformed control-plane and host keys", () => {
    expect(() => loadConfig(writeConfig({ ...required, workerRpcPublicKey: "short" })))
      .toThrow("workerRpcPublicKey");
    expect(() => loadConfig(writeConfig({ ...required, x25519PrivateKey: "short" })))
      .toThrow("x25519PrivateKey");
  });

  it("rejects invalid identity, port, and partial TLS configuration", () => {
    expect(() => loadConfig(writeConfig({ ...required, hostId: "Wrong Host" })))
      .toThrow("hostId");
    expect(() => loadConfig(writeConfig({ ...required, listenPort: 70000 })))
      .toThrow("listenPort");
    expect(() => loadConfig(writeConfig({ ...required, tlsCertPath: "/tmp/cert" })))
      .toThrow("configured together");
  });
});
