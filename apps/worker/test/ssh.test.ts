import { describe, expect, it } from "vitest";
import { INPUT_LIMITS } from "@workbench/contract";
import { insertSshKey, validPubkey } from "../src/ssh.js";
import { makeEnv, seedUser } from "./helpers/env.js";

describe("SSH key validation", () => {
  it("accepts common key types with or without comments", () => {
    expect(validPubkey("ssh-ed25519 AAAA trailing-ws")).toBe(true);
    expect(validPubkey("ssh-rsa AAAAB3NzaC1yc2E=")).toBe(true);
    expect(validPubkey("ecdsa-sha2-nistp256 AAAAE2Vj comment here")).toBe(true);
    expect(validPubkey("  ssh-ed25519 AAAA trailing-ws  ")).toBe(true);
  });

  it("rejects garbage, private keys, oversized blobs, and legacy DSA", () => {
    expect(validPubkey("not a key")).toBe(false);
    expect(validPubkey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(false);
    expect(validPubkey(`ssh-ed25519 ${"A".repeat(5000)}`)).toBe(false);
    expect(validPubkey("ssh-dss AAAA")).toBe(false);
  });

  it("accepts a key at the shared contract size limit", () => {
    const prefix = "ssh-ed25519 ";
    const key = prefix + "A".repeat(INPUT_LIMITS.sshKeyBytes - prefix.length);
    expect(key).toHaveLength(INPUT_LIMITS.sshKeyBytes);
    expect(validPubkey(key)).toBe(true);
    expect(validPubkey(`${key}A`)).toBe(false);
  });

  it("counts multibyte comments in UTF-8 bytes, not code units", () => {
    const prefix = "ssh-ed25519 AAAA ";
    // At the code-unit limit but twice the byte limit: a code-unit count
    // would accept it.
    const over = prefix + "é".repeat(INPUT_LIMITS.sshKeyBytes - prefix.length);
    expect(over.length).toBeLessThanOrEqual(INPUT_LIMITS.sshKeyBytes);
    expect(validPubkey(over)).toBe(false);
    // A comment that fits the byte budget is accepted.
    const within = prefix + "é".repeat((INPUT_LIMITS.sshKeyBytes - prefix.length) / 2);
    expect(validPubkey(within)).toBe(true);
  });
});

describe("insertSshKey", () => {
  it("enforces the account quota when two final-slot inserts race", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const statements = Array.from(
      { length: INPUT_LIMITS.sshKeysPerAccount - 1 },
      (_, index) => env.DB.prepare(
        "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES (?, ?, ?, ?)",
      ).bind(user.id, `key-${index}`, `ssh-ed25519 AAAA${index}`, index),
    );
    await env.DB.batch(statements);

    const results = await Promise.all([
      insertSshKey(env, user.id, "candidate-a", "ssh-ed25519 AAAA-candidate-a"),
      insertSshKey(env, user.id, "candidate-b", "ssh-ed25519 AAAA-candidate-b"),
    ]);

    expect(results.sort()).toEqual(["inserted", "limit"]);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM ssh_keys WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(INPUT_LIMITS.sshKeysPerAccount);
  });

  it("reports an existing key as a duplicate even when the quota is full", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const duplicate = "ssh-ed25519 AAAA-existing";
    const statements = Array.from(
      { length: INPUT_LIMITS.sshKeysPerAccount },
      (_, index) => env.DB.prepare(
        "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES (?, ?, ?, ?)",
      ).bind(user.id, `key-${index}`, index === 0 ? duplicate : `ssh-ed25519 AAAA${index}`, index),
    );
    await env.DB.batch(statements);

    await expect(insertSshKey(env, user.id, "again", duplicate)).resolves.toBe("duplicate");
  });
});
