import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

describe("0008 host CPU and health migration", () => {
  it("backfills conservative vCPU capacity and current allocations", () => {
    const db = new DatabaseSync(":memory:");
    for (const name of [
      "0001_init.sql",
      "0002_worldid_session.sql",
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
    ]) {
      db.exec(migration(name));
    }
    db.exec(`
      INSERT INTO users
        (id, world_id_nullifier, world_id_session_id, created_at)
      VALUES ('user-1', 'null-1', 'session-1', 1);
      INSERT INTO hosts
        (id, ipv4, ssh_hostname, daemon_endpoint, daemon_pubkey,
         ram_total_mb, ram_reserve_mb, disk_total_gb, status, joined_at)
      VALUES
        ('host-1', '192.0.2.1', 'host-1.test', 'https://host-1.test', 'pub',
         8192, 2048, 100, 'active', 1);
      INSERT INTO containers
        (id, user_id, host_id, ssh_port, agents, tier, cpu, ram_mb, disk_gb,
         status, created_at)
      VALUES
        ('container-1', 'user-1', 'host-1', 30500, '["claude"]', 'paid',
         2, 4096, 32, 'running', 1);
    `);

    db.exec(migration("0008_host_cpu_health.sql"));

    const host = db.prepare(`
      SELECT vcpu_capacity, vcpu_allocated, last_seen_at, consecutive_failures
      FROM hosts WHERE id = 'host-1'
    `).get() as Record<string, number>;
    expect(host.vcpu_capacity).toBe(3);
    expect(host.vcpu_allocated).toBe(2);
    expect(host.last_seen_at).toBeGreaterThan(0);
    expect(host.consecutive_failures).toBe(0);
  });
});
