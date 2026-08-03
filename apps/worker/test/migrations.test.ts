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
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
    ]) {
      db.exec(migration(name));
    }
    db.exec(`
      INSERT INTO users (id, created_at) VALUES ('user-1', 1);
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

describe("0009 passkey and invite authentication migration", () => {
  it("adds WebAuthn handles and rebuilds user foreign keys cleanly", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
      "0008_host_cpu_health.sql",
    ]) {
      db.exec(migration(name));
    }
    db.exec(`
      INSERT INTO users (id, created_at) VALUES ('user-1', 1);
      INSERT INTO ssh_keys (user_id, label, pubkey, created_at)
      VALUES ('user-1', 'laptop', 'ssh-ed25519 AAAA test', 2);
    `);

    db.exec(migration("0009_passkey_invite_auth.sql"));

    const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "webauthn_user_id",
      "status",
      "subscription_status",
      "created_at",
      "last_authenticated_at",
    ]);
    const user = db.prepare(
      "SELECT id, length(webauthn_user_id) AS handle_length FROM users",
    ).get();
    expect(user).toEqual({ id: "user-1", handle_length: 64 });
    expect(db.prepare("SELECT user_id, label FROM ssh_keys").get())
      .toEqual({ user_id: "user-1", label: "laptop" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("0010 Better Auth account migration", () => {
  it("replaces legacy authentication while preserving workbench foreign keys", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
      "0008_host_cpu_health.sql",
      "0009_passkey_invite_auth.sql",
    ]) db.exec(migration(name));
    db.exec(`
      INSERT INTO users (id, webauthn_user_id, created_at)
      VALUES ('user-1', lower(hex(randomblob(32))), 1);
      INSERT INTO ssh_keys (user_id, label, pubkey, created_at)
      VALUES ('user-1', 'laptop', 'ssh-ed25519 AAAA test', 2);
    `);

    db.exec(migration("0010_better_auth_accounts.sql"));

    const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "email",
      "email_verified",
      "image",
      "status",
      "subscription_status",
      "verified_at",
      "verification_method",
      "created_at",
      "updated_at",
    ]);
    expect(db.prepare("SELECT user_id, label FROM ssh_keys").get())
      .toEqual({ user_id: "user-1", label: "laptop" });
    for (const table of ["auth_sessions", "auth_accounts", "auth_verifications", "passkey", "world_id_nullifiers"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
        .toEqual({ name: table });
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_challenges'").get())
      .toBeUndefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("0011 free-tier memory migration", () => {
  it("reduces legacy free reservations and recomputes host accounting", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
      "0008_host_cpu_health.sql",
      "0009_passkey_invite_auth.sql",
      "0010_better_auth_accounts.sql",
    ]) db.exec(migration(name));
    db.exec(`
      INSERT INTO users
        (id, name, email, email_verified, created_at, updated_at)
      VALUES
        ('free-user', 'Free', 'free@example.test', 1, 1, 1),
        ('paid-user', 'Paid', 'paid@example.test', 1, 1, 1);
      INSERT INTO hosts
        (id, ipv4, ssh_hostname, daemon_endpoint, daemon_pubkey,
         ram_total_mb, ram_allocated_mb, ram_reserve_mb, disk_total_gb,
         disk_allocated_gb, status, joined_at)
      VALUES
        ('host-1', '192.0.2.1', 'host.test', 'https://host.test', 'pub',
         8192, 6144, 2048, 100, 20, 'draining', 1);
      INSERT INTO containers
        (id, user_id, host_id, ssh_port, agents, tier, cpu, ram_mb, disk_gb,
         status, created_at)
      VALUES
        ('free-container', 'free-user', 'host-1', 30500, '["claude"]',
         'free', 1, 2048, 5, 'running', 1),
        ('paid-container', 'paid-user', 'host-1', 30501, '["claude"]',
         'paid', 2, 4096, 8, 'running', 1);
    `);

    db.exec(migration("0011_free_tier_memory.sql"));

    expect(db.prepare("SELECT ram_mb FROM containers WHERE tier = 'free'").get())
      .toEqual({ ram_mb: 1536 });
    expect(db.prepare("SELECT ram_mb FROM containers WHERE tier = 'paid'").get())
      .toEqual({ ram_mb: 4096 });
    expect(db.prepare("SELECT ram_allocated_mb FROM hosts WHERE id = 'host-1'").get())
      .toEqual({ ram_allocated_mb: 5632 });
  });
});

describe("0012 developer service token migration", () => {
  it("adds encrypted Supabase and Convex slots without rebuilding credential rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
      "0008_host_cpu_health.sql",
      "0009_passkey_invite_auth.sql",
      "0010_better_auth_accounts.sql",
      "0011_free_tier_memory.sql",
    ]) db.exec(migration(name));
    db.exec(`
      INSERT INTO users
        (id, name, email, email_verified, created_at, updated_at)
      VALUES ('user-1', 'Test', 'test@example.test', 1, 1, 1);
      INSERT INTO credentials_encrypted (user_id, cloudflare_token)
      VALUES ('user-1', 'existing-ciphertext');
    `);

    db.exec(migration("0012_developer_service_tokens.sql"));

    const columns = db.prepare("PRAGMA table_info(credentials_encrypted)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("supabase_token");
    expect(columns.map((column) => column.name)).toContain("convex_token");
    expect(db.prepare(
      "SELECT cloudflare_token, supabase_token, convex_token FROM credentials_encrypted",
    ).get()).toEqual({
      cloudflare_token: "existing-ciphertext",
      supabase_token: null,
      convex_token: null,
    });
  });
});

describe("0014 host fleet migration", () => {
  it("backfills budget hosts, capacity ceilings, management addresses, and placement affinity", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
      "0008_host_cpu_health.sql",
      "0009_passkey_invite_auth.sql",
      "0010_better_auth_accounts.sql",
      "0011_free_tier_memory.sql",
      "0012_developer_service_tokens.sql",
      "0013_notifications.sql",
    ]) db.exec(migration(name));
    db.exec(`
      INSERT INTO users
        (id, name, email, email_verified, subscription_status, created_at, updated_at)
      VALUES
        ('assigned', 'Assigned', 'assigned@example.test', 1, 'paid', 1, 1),
        ('waiting', 'Waiting', 'waiting@example.test', 1, 'paid', 1, 1);
      INSERT INTO hosts
        (id, ipv4, ssh_hostname, daemon_endpoint, daemon_pubkey,
         ram_total_mb, ram_reserve_mb, vcpu_capacity, disk_total_gb,
         status, joined_at)
      VALUES
        ('legacy-host', '192.0.2.10', 'legacy.test', 'https://legacy.test', 'pub',
         8192, 2048, 12, 100, 'active', 1),
        ('retired-host', '192.0.2.11', 'retired.test', 'https://retired.test', 'pub',
         8192, 2048, 12, 100, 'dead', 1);
      INSERT INTO containers
        (id, user_id, host_id, ssh_port, agents, tier, cpu, ram_mb, disk_gb,
         status, created_at)
      VALUES
        ('assigned-container', 'assigned', 'legacy-host', 30500, '["claude"]',
         'paid', 2, 4096, 8, 'running', 1),
        ('waiting-container', 'waiting', NULL, NULL, '["codex"]',
         'paid', 2, 4096, 8, 'waitlisted', 1);
    `);

    db.exec(migration("0014_host_fleet.sql"));

    expect(db.prepare(`
      SELECT host_type, status, max_tenants, management_hostname, management_port,
             management_user, daemon_version
      FROM hosts WHERE id = 'legacy-host'
    `).get()).toEqual({
      host_type: "regular",
      status: "draining",
      max_tenants: 1,
      management_hostname: "legacy.test",
      management_port: 22,
      management_user: "root",
      daemon_version: null,
    });
    expect(db.prepare("SELECT status FROM hosts WHERE id = 'retired-host'").get())
      .toEqual({ status: "dead" });
    expect(db.prepare("SELECT id, placement_class FROM containers ORDER BY id").all())
      .toEqual([
        { id: "assigned-container", placement_class: "regular" },
        { id: "waiting-container", placement_class: "regular" },
      ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects a legacy host that mixes free and paid tenants", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
      "0008_host_cpu_health.sql",
      "0009_passkey_invite_auth.sql",
      "0010_better_auth_accounts.sql",
      "0011_free_tier_memory.sql",
      "0012_developer_service_tokens.sql",
      "0013_notifications.sql",
    ]) db.exec(migration(name));
    db.exec(`
      INSERT INTO users
        (id, name, email, email_verified, subscription_status, created_at, updated_at)
      VALUES
        ('free-user', 'Free', 'free@example.test', 1, 'free', 1, 1),
        ('paid-user', 'Paid', 'paid@example.test', 1, 'paid', 1, 1);
      INSERT INTO hosts
        (id, ipv4, ssh_hostname, daemon_endpoint, daemon_pubkey,
         ram_total_mb, ram_reserve_mb, vcpu_capacity, disk_total_gb,
         status, joined_at)
      VALUES
        ('mixed-host', '192.0.2.11', 'mixed.test', 'https://mixed.test', 'pub',
         16384, 2048, 12, 100, 'draining', 1);
      INSERT INTO containers
        (id, user_id, host_id, ssh_port, agents, tier, cpu, ram_mb, disk_gb,
         status, created_at)
      VALUES
        ('free-container', 'free-user', 'mixed-host', 30500, '["claude"]',
         'free', 1, 1536, 5, 'running', 1),
        ('paid-container', 'paid-user', 'mixed-host', 30501, '["codex"]',
         'paid', 2, 4096, 8, 'running', 1);
    `);

    expect(() => db.exec(migration("0014_host_fleet.sql"))).toThrow();
    expect(db.prepare("PRAGMA table_info(hosts)").all()
      .map((column) => (column as { name: string }).name)).not.toContain("host_type");
  });
});

describe("0015 host lifecycle migration", () => {
  it("separates advertised CPU from actual reservations and adds generation/re-home state", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0003_multi_agent.sql",
      "0004_root_disk_accounting.sql",
      "0005_unique_ssh_keys.sql",
      "0006_wrangler_oauth.sql",
      "0007_github_repositories.sql",
      "0008_host_cpu_health.sql",
      "0009_passkey_invite_auth.sql",
      "0010_better_auth_accounts.sql",
      "0011_free_tier_memory.sql",
      "0012_developer_service_tokens.sql",
      "0013_notifications.sql",
      "0014_host_fleet.sql",
    ]) db.exec(migration(name));
    db.exec(`
      INSERT INTO users
        (id, name, email, email_verified, subscription_status, created_at, updated_at)
      VALUES
        ('free-user', 'Free', 'free@example.test', 1, 'free', 1, 1),
        ('paid-user', 'Paid', 'paid@example.test', 1, 'paid', 1, 1);
      INSERT INTO hosts
        (id, ipv4, ssh_hostname, daemon_endpoint, daemon_pubkey,
         ram_total_mb, ram_reserve_mb, vcpu_capacity, vcpu_allocated,
         disk_total_gb, status, joined_at, host_type, max_tenants)
      VALUES
        ('host-1', '192.0.2.10', 'host.test', 'https://host.test', 'pub',
         16384, 2048, 12, 99, 200, 'draining', 1, 'budget', 4);
      INSERT INTO containers
        (id, user_id, host_id, ssh_port, agents, tier, placement_class,
         cpu, ram_mb, disk_gb, status, created_at)
      VALUES
        ('free-container', 'free-user', 'host-1', 30500, '["claude"]',
         'free', 'budget', 1, 1536, 5, 'running', 1),
        ('paid-container', 'paid-user', 'host-1', 30501, '["codex"]',
         'paid', 'regular', 2, 4096, 8, 'running', 1);
    `);

    db.exec(migration("0015_host_lifecycle.sql"));

    expect(db.prepare(
      "SELECT generation, retired_at, vcpu_allocated FROM hosts WHERE id = 'host-1'",
    ).get()).toEqual({ generation: 1, retired_at: null, vcpu_allocated: 5 });
    const columns = db.prepare("PRAGMA table_info(containers)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "rehome_tier",
      "rehome_placement_class",
      "rehome_requested_at",
    ]));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
