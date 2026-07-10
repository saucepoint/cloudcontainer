import { describe, expect, it } from "vitest";
import {
  allocatePort,
  PORT_RANGE_END,
  PORT_RANGE_START,
  QUARANTINE_DAYS,
  quarantinePort,
} from "../src/ports.js";
import { makeEnv, seedHost, seedUser, seedContainer } from "./helpers/env.js";

const DAY_MS = 24 * 3600 * 1000;
const SPAN = PORT_RANGE_END - PORT_RANGE_START + 1;

/** Mark every port on the host taken except `except`, via quarantine rows. */
function blockAllPortsExcept(db: import("node:sqlite").DatabaseSync, hostId: string, except: number[], releasedAt: number) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO port_quarantine (host_id, port, released_at) VALUES (?, ?, ?)",
  );
  const skip = new Set(except);
  db.exec("BEGIN");
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!skip.has(p)) stmt.run(hostId, p, releasedAt);
  }
  db.exec("COMMIT");
}

describe("allocatePort", () => {
  it("returns a port inside the range", async () => {
    const { env } = makeEnv();
    await seedHost(env);
    const port = await allocatePort(env, "host-1");
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(port).toBeLessThanOrEqual(PORT_RANGE_END);
  });

  it("never hands out a port that is in use or freshly quarantined", async () => {
    const { env, db } = makeEnv();
    const now = Date.now();
    await seedHost(env);
    await seedUser(env);
    await seedContainer(env, { ssh_port: PORT_RANGE_START }); // in use
    // Everything else recently quarantined except one survivor.
    const survivor = PORT_RANGE_START + 1234;
    blockAllPortsExcept(db, "host-1", [PORT_RANGE_START, survivor], now);

    expect(await allocatePort(env, "host-1", now)).toBe(survivor);
  });

  it("reuses a quarantined port only after the 30-day quarantine", async () => {
    const { env, db } = makeEnv();
    const now = Date.now();
    await seedHost(env);
    const survivor = PORT_RANGE_START + 42;
    blockAllPortsExcept(db, "host-1", [survivor], now);
    // The survivor was itself quarantined, but long enough ago to be reusable.
    await quarantinePort(env, "host-1", survivor, now - (QUARANTINE_DAYS + 1) * DAY_MS);

    expect(await allocatePort(env, "host-1", now)).toBe(survivor);
  });

  it("throws when the host has no free ports", async () => {
    const { env, db } = makeEnv();
    const now = Date.now();
    await seedHost(env);
    blockAllPortsExcept(db, "host-1", [], now);
    expect(db.prepare("SELECT COUNT(*) AS n FROM port_quarantine").get()?.n).toBe(SPAN);

    await expect(allocatePort(env, "host-1", now)).rejects.toThrow(/no free ssh ports/);
  });

  it("scopes allocation per host", async () => {
    const { env, db } = makeEnv();
    const now = Date.now();
    await seedHost(env, { id: "host-1" });
    await seedHost(env, { id: "host-2", ssh_hostname: "h2", daemon_endpoint: "https://d2" });
    blockAllPortsExcept(db, "host-1", [], now); // host-1 full; host-2 untouched

    const port = await allocatePort(env, "host-2", now);
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
  });
});
