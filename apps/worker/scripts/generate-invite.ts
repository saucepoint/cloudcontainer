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
import { resolveInviteCommand } from "./invite-command.js";

let command: ReturnType<typeof resolveInviteCommand>;
try {
  command = resolveInviteCommand(argv.slice(2), env);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not resolve invite credentials.");
  exit(1);
}

const { baseUrl, deployment, secret, secretSource } = command;
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
  console.error(`Set ${secretSource} to the same value stored as the ${deployment} Worker secret.`);
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
  const credentialHint = response.status === 401
    ? ` The secret from ${secretSource} does not match the ${deployment} Worker secret.`
    : "";
  console.error(`Invite generation failed (${response.status}).${credentialHint}`);
  exit(1);
}

console.log(code);
