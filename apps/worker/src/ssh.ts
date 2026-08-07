import { INPUT_LIMITS } from "@workbench/contract";
import { getContainerForUser, getHost } from "./jobs.js";
import type { Bindings, ContainerRow } from "./types.js";

const SSH_KEY_RE = /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/;
export const SSH_KEY_LABEL_MAX_LENGTH = 64;

type SshKeyInsertResult = "inserted" | "duplicate" | "limit";

export function validPubkey(key: string): boolean {
  const normalized = key.trim();
  // Byte length, not code units: the job-request budget is enforced in UTF-8
  // bytes, and key comments may contain multibyte characters.
  return (
    SSH_KEY_RE.test(normalized) &&
    new TextEncoder().encode(normalized).byteLength <= INPUT_LIMITS.sshKeyBytes
  );
}

export function normalizeSshKeyLabel(label: string): string {
  return label.trim().slice(0, SSH_KEY_LABEL_MAX_LENGTH);
}

/** SSH key changes need a ready container so they can be applied immediately. */
export async function sshSetupReady(env: Bindings, userId: string): Promise<boolean> {
  return (await getContainerForUser(env, userId))?.status === "running";
}

/**
 * Insert a key while enforcing the per-account quota in the same SQL
 * statement. This prevents concurrent requests from racing past the limit.
 */
export async function insertSshKey(
  env: Bindings,
  userId: string,
  label: string,
  pubkey: string,
): Promise<SshKeyInsertResult> {
  const normalized = pubkey.trim();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO ssh_keys (user_id, label, pubkey, created_at)
     SELECT ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM ssh_keys WHERE user_id = ?) < ?`,
  )
    .bind(
      userId,
      normalizeSshKeyLabel(label),
      normalized,
      Date.now(),
      userId,
      INPUT_LIMITS.sshKeysPerAccount,
    )
    .run();
  if (inserted.meta.changes) return "inserted";

  const duplicate = await env.DB.prepare(
    "SELECT 1 FROM ssh_keys WHERE user_id = ? AND pubkey = ? LIMIT 1",
  )
    .bind(userId, normalized)
    .first();
  return duplicate ? "duplicate" : "limit";
}

/** `ssh -p <port> dev@<host>` for a placed container, or null when unplaced. */
export async function sshCommandFor(
  env: Bindings,
  container: ContainerRow,
): Promise<string | null> {
  if (!container.host_id || !container.ssh_port) return null;
  const host = await getHost(env, container.host_id);
  return host ? `ssh -p ${container.ssh_port} dev@${host.ssh_hostname}` : null;
}

/** Do not expose a container's SSH endpoint until a key can use it. */
export async function hasSshKey(env: Bindings, userId: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare("SELECT 1 FROM ssh_keys WHERE user_id = ? LIMIT 1")
      .bind(userId)
      .first(),
  );
}

export async function sshKeysView(env: Bindings, userId: string) {
  const rows = await env.DB.prepare(
    "SELECT id, label, pubkey, created_at FROM ssh_keys WHERE user_id = ? ORDER BY created_at, id",
  )
    .bind(userId)
    .all<{ id: number; label: string; pubkey: string; created_at: number }>();
  return rows.results;
}
