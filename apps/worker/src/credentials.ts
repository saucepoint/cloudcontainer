import {
  CredentialPayloadSchema,
  decryptJsonAtRest,
  encryptJsonAtRest,
  LlmKeysSchema,
  type CredentialPayload,
  type LlmKeys,
} from "@workbench/contract";
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
  return LlmKeysSchema.parse(
    decryptJsonAtRest<unknown>(row.llm_keys, env.CREDENTIAL_MASTER_KEY),
  );
}

export function decryptString(env: Bindings, ciphertext: string | null): string | undefined {
  if (!ciphertext) return undefined;
  return decryptJsonAtRest<string>(ciphertext, env.CREDENTIAL_MASTER_KEY);
}

/** Merge new credentials into the encrypted row. Empty-string values delete a key. */
export async function upsertCredentials(
  env: Bindings,
  userId: string,
  updates: {
    llmKeys?: Record<string, string>;
    cloudflareToken?: string;
    supabaseToken?: string;
    convexToken?: string;
    wranglerOauth?: string;
  },
): Promise<void> {
  const row = await getCredentialsRow(env, userId);
  const existing = decryptLlmKeys(env, row);

  const merged: Record<string, string> = { ...existing } as Record<string, string>;
  for (const [k, v] of Object.entries(updates.llmKeys ?? {})) {
    if (v === "") delete merged[k];
    else merged[k] = v;
  }
  const nextString = (current: string | null, update: string | undefined): string | undefined => {
    if (update === undefined) return decryptString(env, current);
    return update || undefined;
  };
  const cloudflareToken = nextString(row?.cloudflare_token ?? null, updates.cloudflareToken);
  const supabaseToken = nextString(row?.supabase_token ?? null, updates.supabaseToken);
  const convexToken = nextString(row?.convex_token ?? null, updates.convexToken);
  const wranglerOauth = nextString(row?.wrangler_oauth ?? null, updates.wranglerOauth);
  const candidate: CredentialPayload = {
    ...(Object.keys(merged).length > 0 ? { llmKeys: LlmKeysSchema.parse(merged) } : {}),
    ...(cloudflareToken ? { cloudflareToken } : {}),
    ...(supabaseToken ? { supabaseToken } : {}),
    ...(convexToken ? { convexToken } : {}),
    ...(wranglerOauth ? { wranglerOauth } : {}),
  };
  const githubToken = decryptString(env, row?.github_token ?? null);
  if (githubToken) {
    candidate.githubToken = githubToken;
    if (row?.github_login) candidate.githubLogin = row.github_login;
  }
  const validated = CredentialPayloadSchema.parse(candidate);
  const llmCipher = validated.llmKeys
    ? encryptJsonAtRest(validated.llmKeys, env.CREDENTIAL_MASTER_KEY)
    : null;
  const cfCipher = validated.cloudflareToken
    ? encryptJsonAtRest(validated.cloudflareToken, env.CREDENTIAL_MASTER_KEY)
    : null;
  const supabaseCipher = validated.supabaseToken
    ? encryptJsonAtRest(validated.supabaseToken, env.CREDENTIAL_MASTER_KEY)
    : null;
  const convexCipher = validated.convexToken
    ? encryptJsonAtRest(validated.convexToken, env.CREDENTIAL_MASTER_KEY)
    : null;
  const wranglerCipher = validated.wranglerOauth
    ? encryptJsonAtRest(validated.wranglerOauth, env.CREDENTIAL_MASTER_KEY)
    : null;

  await env.DB.prepare(
    `INSERT INTO credentials_encrypted
       (user_id, llm_keys, cloudflare_token, supabase_token, convex_token, wrangler_oauth, rotated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(user_id) DO UPDATE SET
       llm_keys = ?2,
       cloudflare_token = ?3,
       supabase_token = ?4,
       convex_token = ?5,
       wrangler_oauth = ?6,
       rotated_at = ?7`,
  )
    .bind(
      userId,
      llmCipher,
      cfCipher,
      supabaseCipher,
      convexCipher,
      wranglerCipher,
      Date.now(),
    )
    .run();
}

/**
 * Assemble the plaintext credential payload destined for a host. Decrypted
 * in-memory only; the caller immediately seals it to the host's X25519 key.
 * The GitHub *refresh* token is deliberately never included (§9/§10).
 */
export function buildCredentialPayload(env: Bindings, row: CredentialsRow | null): CredentialPayload {
  const payload: CredentialPayload = {};
  if (!row) return CredentialPayloadSchema.parse(payload);
  const llmKeys = decryptLlmKeys(env, row);
  if (Object.keys(llmKeys).length > 0) payload.llmKeys = llmKeys;
  const cf = decryptString(env, row.cloudflare_token);
  if (cf) payload.cloudflareToken = cf;
  const supabase = decryptString(env, row.supabase_token);
  if (supabase) payload.supabaseToken = supabase;
  const convex = decryptString(env, row.convex_token);
  if (convex) payload.convexToken = convex;
  const wrangler = decryptString(env, row.wrangler_oauth);
  if (wrangler) payload.wranglerOauth = wrangler;
  const gh = decryptString(env, row.github_token);
  if (gh) {
    payload.githubToken = gh;
    if (row.github_login) payload.githubLogin = row.github_login;
  }
  return CredentialPayloadSchema.parse(payload);
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

/** Validate a Supabase personal or OAuth access token against the Management API. */
export async function validateSupabaseToken(token: string): Promise<boolean> {
  const res = await fetch("https://api.supabase.com/v1/projects", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

/** Validate a Convex personal access token using the CLI's authorization check. */
export async function validateConvexToken(token: string): Promise<boolean> {
  const res = await fetch("https://api.convex.dev/api/authorize", {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${token}`,
      "convex-client": "workbench-control-plane",
    },
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}
