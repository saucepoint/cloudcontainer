/**
 * Test doubles for the Worker's Cloudflare bindings.
 *
 * - D1 is faked over `node:sqlite` (both are SQLite, so the SQL — including
 *   `?N` params, ON CONFLICT upserts, and json_array — behaves identically)
 *   with the real migrations from ../migrations applied.
 * - Daemon/GitHub/Cloudflare HTTP is intercepted via `stubFetch`, never real.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { generateEd25519Keypair, generateSymmetricKey } from "@workbench/contract";
import { createAuth, signedSessionCookie } from "../../src/better-auth.js";
import type { Bindings, ContainerRow, HostRow, UserRow } from "../../src/types.js";

// -- fake D1 over node:sqlite -------------------------------------------------

/** What D1 accepts as bind values; matches node:sqlite's SQLInputValue. */
type SqlValue = string | number | bigint | null | Uint8Array;

class FakeD1Statement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: SqlValue[] = [],
  ) {}

  bind(...params: SqlValue[]): FakeD1Statement {
    return new FakeD1Statement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true };
  }

  async raw<T extends unknown[]>(): Promise<T[]> {
    const rows = this.db.prepare(this.sql).all(...this.params) as Array<Record<string, unknown>>;
    return rows.map((row) => Object.values(row) as T);
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync();
  }

  runSync(): { success: true; meta: { changes: number } } {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes) } };
  }
}

class FakeD1 {
  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this.db, sql);
  }

  async batch(statements: FakeD1Statement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    this.db.exec("BEGIN");
    try {
      for (const statement of statements) out.push(statement.runSync());
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

// -- env builder ----------------------------------------------------------------

interface TestEnv {
  env: Bindings;
  db: DatabaseSync;
  /** Ed25519 keypair whose private half signs Worker->daemon RPCs. */
  rpcKeys: { publicKey: string; privateKey: string };
}

function migrationsSql(): string {
  const dir = new URL("../../migrations/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), "utf8"))
    .join("\n");
}

export function makeEnv(overrides: Partial<Bindings> = {}): TestEnv {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(migrationsSql());
  const rpcKeys = generateEd25519Keypair();
  const env = {
    DB: new FakeD1(db),
    BASE_URL: "https://usebench.dev",
    DEV_AUTH: "0",
    GITHUB_APP_CLIENT_ID: "",
    GITHUB_APP_SLUG: "",
    AUTH_GOOGLE_CLIENT_ID: "",
    AUTH_GITHUB_CLIENT_ID: "",
    WORLD_ID_APP_ID: "",
    WORLD_ID_RP_ID: "",
    WORLD_ID_ACTION: "verify-account-1",
    WORLD_ID_ENVIRONMENT: "production",
    SSH_PORT_RANGE_START: "30000",
    SSH_PORT_RANGE_END: "39999",
    BETTER_AUTH_SECRET: "test-better-auth-secret-must-be-at-least-32-characters",
    CREDENTIAL_MASTER_KEY: generateSymmetricKey(),
    WORKER_RPC_PRIVATE_KEY: rpcKeys.privateKey,
    ...overrides,
  } as unknown as Bindings;
  return { env, db, rpcKeys };
}

// -- seed rows -------------------------------------------------------------------

export async function seedUser(
  env: Bindings,
  id = "user-1",
  subscriptionStatus = "free",
): Promise<UserRow> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users
       (id, name, email, email_verified, subscription_status, verified_at,
        verification_method, created_at, updated_at)
     VALUES (?, 'Test user', ?, 1, ?, ?, 'development', ?, ?)`,
  ).bind(id, `${id}@example.test`, subscriptionStatus, now, now, now).run();
  if (subscriptionStatus === "paid" || subscriptionStatus === "dedicated") {
    await env.DB.prepare(
      `INSERT INTO account_entitlements
         (user_id, plan, source, state, source_ref, updated_at)
       VALUES (?, ?, 'manual', 'manual', 'test-operator', ?)`,
    ).bind(id, subscriptionStatus, now).run();
  }
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!row) throw new Error("seedUser failed");
  return row;
}

export async function createTestSession(env: Bindings, userId: string): Promise<string> {
  const context = await createAuth(env).$context;
  const session = await context.internalAdapter.createSession(userId);
  if (!session) throw new Error("createTestSession failed");
  return signedSessionCookie(env, session.token, "http://localhost");
}

export async function seedHost(
  env: Bindings,
  overrides: Partial<HostRow> = {},
): Promise<HostRow> {
  const host: HostRow = {
    id: "host-1",
    ipv4: "203.0.113.1",
    ipv6: null,
    ssh_hostname: "host-1.workbench.test",
    daemon_endpoint: "https://daemon-1.test:8443",
    daemon_cert_fp: null,
    daemon_pubkey: overrides.daemon_pubkey ?? "",
    ram_total_mb: 65536,
    ram_allocated_mb: 0,
    ram_reserve_mb: 16384,
    vcpu_capacity: 64,
    vcpu_allocated: 0,
    disk_total_gb: 1000,
    disk_allocated_gb: 0,
    status: "active",
    joined_at: Date.now(),
    last_seen_at: Date.now(),
    consecutive_failures: 0,
    host_type: "budget",
    tenancy_mode: overrides.tenancy_mode ??
      (overrides.host_type === "dedicated" ? "dedicated" : "shared"),
    max_tenants: 32,
    dedicated_user_id: null,
    management_hostname: "host-1.workbench.test",
    management_port: 22,
    management_user: "root",
    daemon_version: "test-release",
    reported_ram_total_mb: 65536,
    reported_cpu_logical: 16,
    generation: 1,
    retired_at: null,
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO hosts (id, ipv4, ipv6, ssh_hostname, daemon_endpoint, daemon_cert_fp, daemon_pubkey,
       ram_total_mb, ram_allocated_mb, ram_reserve_mb, vcpu_capacity, vcpu_allocated,
       disk_total_gb, disk_allocated_gb, status, joined_at, last_seen_at, consecutive_failures,
       host_type, tenancy_mode, max_tenants, dedicated_user_id,
       management_hostname, management_port,
       management_user, daemon_version, reported_ram_total_mb, reported_cpu_logical,
       generation, retired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      host.id, host.ipv4, host.ipv6, host.ssh_hostname, host.daemon_endpoint,
      host.daemon_cert_fp, host.daemon_pubkey, host.ram_total_mb, host.ram_allocated_mb,
      host.ram_reserve_mb, host.vcpu_capacity, host.vcpu_allocated, host.disk_total_gb,
      host.disk_allocated_gb, host.status, host.joined_at, host.last_seen_at,
      host.consecutive_failures, host.host_type, host.tenancy_mode,
      host.max_tenants, host.dedicated_user_id,
      host.management_hostname, host.management_port, host.management_user, host.daemon_version,
      host.reported_ram_total_mb, host.reported_cpu_logical,
      host.generation, host.retired_at,
    )
    .run();
  return host;
}

export async function seedContainer(
  env: Bindings,
  overrides: Partial<ContainerRow> = {},
): Promise<ContainerRow> {
  const container: ContainerRow = {
    id: "container-1",
    user_id: "user-1",
    host_id: "host-1",
    ssh_port: 30500,
    agents: JSON.stringify(["claude"]),
    github_repos: "[]",
    tier: "free",
    placement_class: "budget",
    placement_mode: overrides.placement_mode ??
      (overrides.placement_class === "dedicated" ? "dedicated" : "shared"),
    cpu: 1,
    ram_mb: 1536,
    disk_gb: 5,
    status: "running",
    status_detail: null,
    host_key_fingerprints: null,
    suspended_at: null,
    created_at: Date.now(),
    last_upgraded_at: null,
    rehome_tier: null,
    rehome_placement_class: null,
    rehome_requested_at: null,
    storage_grandfathered: 0,
    suspension_reason: null,
    billing_suspended_at: null,
    destroy_after: null,
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO containers (id, user_id, host_id, ssh_port, agents, tier, placement_class, placement_mode,
       cpu, ram_mb, disk_gb, status, status_detail, host_key_fingerprints, suspended_at,
       created_at, last_upgraded_at, rehome_tier, rehome_placement_class,
       rehome_requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      container.id, container.user_id, container.host_id, container.ssh_port,
      container.agents, container.tier, container.placement_class, container.placement_mode, container.cpu,
      container.ram_mb, container.disk_gb,
      container.status, container.status_detail, container.host_key_fingerprints,
      container.suspended_at, container.created_at, container.last_upgraded_at,
      container.rehome_tier, container.rehome_placement_class,
      container.rehome_requested_at,
    )
    .run();
  return container;
}

// -- fetch interception ------------------------------------------------------------

export type FetchRoute = (url: URL, init: RequestInit) => Response | Promise<Response> | null;

/**
 * Replace global fetch for the current test. Routes are tried in order; the
 * first non-null response wins, anything unmatched throws (tests must never
 * hit the network). Restore with `vi.unstubAllGlobals()` in afterEach.
 */
export function stubFetch(...routes: FetchRoute[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    throw new Error(`unexpected fetch in test: ${url.href}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * A daemon that accepts every job and reports it terminal on poll. Captures
 * submitted job requests so tests can assert on the wire payload.
 */
export function fakeDaemon(opts: { failWith?: string } = {}) {
  const submitted: Array<Record<string, unknown>> = [];
  const route: FetchRoute = (url, init) => {
    if (url.pathname === "/jobs" && init.method === "POST") {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      submitted.push(request);
      return Response.json({ jobId: request.jobId, status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/jobs\/(.+)$/);
    if (m) {
      return Response.json({
        jobId: m[1],
        status: opts.failWith ? "failed" : "succeeded",
        error: opts.failWith ?? null,
        result: null,
      });
    }
    return null;
  };
  return { submitted, route };
}
