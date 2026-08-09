import type { Bindings } from "./types.js";

export const PORT_RANGE_START = 30000;
export const PORT_RANGE_END = 39999;
export const QUARANTINE_DAYS = 30;

function configuredPortRange(env: Bindings): { start: number; end: number } {
  const start = Number(env.SSH_PORT_RANGE_START);
  const end = Number(env.SSH_PORT_RANGE_END);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1024 ||
    end > 65535 ||
    start > end
  ) {
    throw new Error("invalid SSH port range configuration");
  }
  return { start, end };
}

export class NoFreePortsError extends Error {
  constructor(readonly hostId: string) {
    super("no free ssh ports on host");
    this.name = "NoFreePortsError";
  }
}

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

  const { start, end } = configuredPortRange(env);
  const taken = new Set<number>();
  for (const r of inUse.results) {
    if (r.ssh_port >= start && r.ssh_port <= end) taken.add(r.ssh_port);
  }
  for (const r of quarantined.results) {
    if (r.port >= start && r.port <= end) taken.add(r.port);
  }

  const span = end - start + 1;
  if (taken.size >= span) throw new NoFreePortsError(hostId);

  const rand = new Uint32Array(1);
  for (let i = 0; i < 200; i++) {
    crypto.getRandomValues(rand);
    const port = start + ((rand[0] ?? 0) % span);
    if (!taken.has(port)) return port;
  }
  // Fallback linear scan if random probing was unlucky.
  for (let p = start; p <= end; p++) {
    if (!taken.has(p)) return p;
  }
  throw new NoFreePortsError(hostId);
}
