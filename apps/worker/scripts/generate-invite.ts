/**
 * Request a one-time invite from the deployed Worker.
 *
 * Usage:
 *   INVITE_ADMIN_SECRET=... npm run create:invite
 *
 * Pass --url or set USEBENCH_URL to target another deployment, such as a
 * local Worker.
 *
 * The shared admin secret is sent only in the Authorization header. The raw
 * invite is printed once; the Worker stores only its keyed HMAC-SHA-256.
 */
import { argv, env, exit } from "node:process";

const PRODUCTION_URL = "https://usebench.dev";

function argument(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const baseUrl = (argument("--url")
  ?? env.USEBENCH_URL
  ?? env.WORKBENCH_URL
  ?? env.CODESTATION_URL
  ?? PRODUCTION_URL).replace(/\/$/, "");
const secret = env.INVITE_ADMIN_SECRET;
let target: URL | null = null;
try {
  if (baseUrl) target = new URL(baseUrl);
} catch {
  // Report the same safe usage error below.
}
const localHttp = target?.protocol === "http:"
  && (target.hostname === "localhost" || target.hostname === "127.0.0.1");

if (!target || (target.protocol !== "https:" && !localHttp)) {
  console.error("Pass an HTTPS --url (HTTP is allowed only for localhost) or set a deployment URL.");
  exit(1);
}
if (!secret) {
  console.error("Set INVITE_ADMIN_SECRET to the same value stored as the Worker secret.");
  exit(1);
}

const response = await fetch(new URL("/api/admin/invites", target), {
  method: "POST",
  headers: {
    accept: "application/json",
    authorization: `Bearer ${secret}`,
  },
});
const body: unknown = await response.json().catch(() => null);
const code = typeof (body as { code?: unknown } | null)?.code === "string"
  ? (body as { code: string }).code
  : null;

if (!response.ok || !code) {
  console.error(`Invite generation failed (${response.status}).`);
  exit(1);
}

console.log(code);
