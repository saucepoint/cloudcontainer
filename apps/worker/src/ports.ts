import type { Bindings } from "./types.js";

export const PORT_RANGE_START = 30000;
export const PORT_RANGE_END = 39999;
export const QUARANTINE_DAYS = 30;

/**
 * Allocate an SSH port on a host: random probe within the range, avoiding
 * ports in use and ports quarantined less than 30 days ago (§8).
 */
export async function allocatePort(
  env: Bindings,
  hostId: string,
  now: number = Date.now(),
): Promise<number> {
  const inUse = await env.DB.prepare(
    "SELECT ssh_port FROM containers WHERE host_id = ? AND ssh_port IS NOT NULL",
  )
    .bind(hostId)
    .all<{ ssh_port: number }>();
  const cutoff = now - QUARANTINE_DAYS * 24 * 3600 * 1000;
  const quarantined = await env.DB.prepare(
    "SELECT port FROM port_quarantine WHERE host_id = ? AND released_at > ?",
  )
    .bind(hostId, cutoff)
    .all<{ port: number }>();

  const taken = new Set<number>();
  for (const r of inUse.results) taken.add(r.ssh_port);
  for (const r of quarantined.results) taken.add(r.port);

  const span = PORT_RANGE_END - PORT_RANGE_START + 1;
  if (taken.size >= span) throw new Error("no free ssh ports on host");

  const rand = new Uint32Array(1);
  for (let i = 0; i < 200; i++) {
    crypto.getRandomValues(rand);
    const port = PORT_RANGE_START + ((rand[0] ?? 0) % span);
    if (!taken.has(port)) return port;
  }
  // Fallback linear scan if random probing was unlucky.
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!taken.has(p)) return p;
  }
  throw new Error("no free ssh ports on host");
}

export async function quarantinePort(
  env: Bindings,
  hostId: string,
  port: number,
  now: number = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO port_quarantine (host_id, port, released_at) VALUES (?, ?, ?)",
  )
    .bind(hostId, port, now)
    .run();
}
