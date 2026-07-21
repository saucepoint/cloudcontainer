import { toHex, utf8 } from "@workbench/contract";

const INVITE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const INVITE_LENGTH = 8;
const UNBIASED_BYTE_LIMIT = Math.floor(256 / INVITE_ALPHABET.length) * INVITE_ALPHABET.length;
const INVITE_HMAC_DOMAIN = "workbench-invite-v1\0";

export function normalizeInviteCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : null;
}

/**
 * Key invite lookups with the Cloudflare secret. Eight-character codes have
 * intentionally limited entropy; an HMAC keeps a D1-only leak from enabling
 * an offline code search.
 */
export async function hashInviteCode(code: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    utf8(`${INVITE_HMAC_DOMAIN}${code}`),
  );
  return toHex(new Uint8Array(signature));
}

export function randomInviteCode(): string {
  let code = "";
  while (code.length < INVITE_LENGTH) {
    const bytes = new Uint8Array(INVITE_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
      if (code.length === INVITE_LENGTH) break;
    }
  }
  return code;
}
