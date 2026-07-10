import {
  decryptJsonAtRest,
  encryptJsonAtRest,
  type CredentialPayload,
  type LlmKeys,
} from "@codestation/contract";
import type { Bindings, CredentialsRow } from "./types.js";

export async function getCredentialsRow(
  env: Bindings,
  userId: string,
): Promise<CredentialsRow | null> {
  return env.DB.prepare("SELECT * FROM credentials_encrypted WHERE user_id = ?")
    .bind(userId)
    .first<CredentialsRow>();
}

export function decryptLlmKeys(env: Bindings, row: CredentialsRow | null): LlmKeys {
  if (!row?.llm_keys) return {};
  return decryptJsonAtRest<LlmKeys>(row.llm_keys, env.CREDENTIAL_MASTER_KEY);
}

export function decryptString(env: Bindings, ciphertext: string | null): string | undefined {
  if (!ciphertext) return undefined;
  return decryptJsonAtRest<string>(ciphertext, env.CREDENTIAL_MASTER_KEY);
}

/** Merge new LLM keys / Cloudflare token into the encrypted row. Empty-string values delete a key. */
export async function upsertCredentials(
  env: Bindings,
  userId: string,
  updates: { llmKeys?: Record<string, string>; cloudflareToken?: string },
): Promise<void> {
  const row = await getCredentialsRow(env, userId);
  const existing = decryptLlmKeys(env, row);

  const merged: Record<string, string> = { ...existing } as Record<string, string>;
  for (const [k, v] of Object.entries(updates.llmKeys ?? {})) {
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  const llmCipher =
    Object.keys(merged).length > 0
      ? encryptJsonAtRest(merged, env.CREDENTIAL_MASTER_KEY)
      : null;

  let cfCipher = row?.cloudflare_token ?? null;
  if (updates.cloudflareToken !== undefined) {
    cfCipher =
      updates.cloudflareToken === ""
        ? null
        : encryptJsonAtRest(updates.cloudflareToken, env.CREDENTIAL_MASTER_KEY);
  }

  await env.DB.prepare(
    `INSERT INTO credentials_encrypted (user_id, llm_keys, cloudflare_token, rotated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET llm_keys = ?2, cloudflare_token = ?3, rotated_at = ?4`,
  )
    .bind(userId, llmCipher, cfCipher, Date.now())
    .run();
}

/**
 * Assemble the plaintext credential payload destined for a host. Decrypted
 * in-memory only; the caller immediately seals it to the host's X25519 key.
 * The GitHub *refresh* token is deliberately never included (§9/§10).
 */
export function buildCredentialPayload(env: Bindings, row: CredentialsRow | null): CredentialPayload {
  const payload: CredentialPayload = {};
  if (!row) return payload;
  const llmKeys = decryptLlmKeys(env, row);
  if (Object.keys(llmKeys).length > 0) payload.llmKeys = llmKeys;
  const cf = decryptString(env, row.cloudflare_token);
  if (cf) payload.cloudflareToken = cf;
  const gh = decryptString(env, row.github_token);
  if (gh) {
    payload.githubToken = gh;
    if (row.github_login) payload.githubLogin = row.github_login;
  }
  return payload;
}

/** Validate a pasted Cloudflare API token with a live call (§5 wizard). */
export async function validateCloudflareToken(token: string): Promise<boolean> {
  const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return false;
  const json = (await res.json()) as { success?: boolean };
  return json.success === true;
}
