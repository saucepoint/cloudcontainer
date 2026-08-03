import { utf8 } from "@workbench/contract";

export async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", utf8(provided)),
    crypto.subtle.digest("SHA-256", utf8(expected)),
  ]);
  const { timingSafeEqual } = crypto.subtle;
  if (typeof timingSafeEqual === "function") {
    return timingSafeEqual.call(crypto.subtle, providedHash, expectedHash);
  }

  // Node's WebCrypto test runtime does not expose Cloudflare's timingSafeEqual.
  // Both inputs are fixed-length hashes and the fallback never exits early.
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}
