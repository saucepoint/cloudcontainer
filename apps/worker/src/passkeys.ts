import { Hono } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { requireUser, getUser, loginAndRedirect } from "./auth.js";
import { readJsonBody } from "./http.js";
import { hashInviteCode, normalizeInviteCode } from "./invites.js";
import {
  randomToken,
  readCookie,
  sha256Hex,
} from "./sessions.js";
import type { AppContext, Bindings, PasskeyRow, UserRow } from "./types.js";

const RP_NAME = "Codestation";
const CEREMONY_TTL_SEC = 5 * 60;
const CEREMONY_COOKIE_PATH = "/auth";
const AUTH_COOKIE = "cs_passkey_auth";
const REGISTRATION_COOKIE = "cs_passkey_registration";
const INVITE_COOKIE = "cs_invite_registration";
const TRANSPORTS = new Set<AuthenticatorTransportFuture>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

type ChallengeKind = "authentication" | "registration" | "invite";

interface ChallengeRow {
  token_hash: string;
  kind: ChallengeKind;
  user_id: string | null;
  challenge: string;
  context: string;
  created_at: number;
  expires_at: number;
}

interface RelyingParty {
  origin: string;
  rpID: string;
}

interface RegistrationContext extends RelyingParty {
  webauthnUserId: string;
}

interface InviteContext extends RegistrationContext {
  codeHash: string;
  pendingUserId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCredentialId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,2048}$/.test(value);
}

function relyingParty(requestUrl: string): RelyingParty {
  const url = new URL(requestUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Passkeys require HTTPS (localhost is allowed for development).");
  }
  return { origin: url.origin, rpID: url.hostname };
}

function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("invalid WebAuthn user handle");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function publicKeyBytes(value: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  return bytes;
}

function parseTransports(value: string): AuthenticatorTransportFuture[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (transport): transport is AuthenticatorTransportFuture =>
        typeof transport === "string" && TRANSPORTS.has(transport as AuthenticatorTransportFuture),
    );
  } catch {
    return [];
  }
}

function ceremonyCookie(name: string, token: string, secure: boolean): string {
  return `${name}=${token}; HttpOnly; Path=${CEREMONY_COOKIE_PATH}; SameSite=Strict; Max-Age=${CEREMONY_TTL_SEC}${secure ? "; Secure" : ""}`;
}

function clearCeremonyCookie(name: string): string {
  return `${name}=; HttpOnly; Path=${CEREMONY_COOKIE_PATH}; SameSite=Strict; Max-Age=0`;
}

async function createChallenge(
  env: Bindings,
  kind: ChallengeKind,
  userId: string | null,
  challenge: string,
  context: object,
): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(now),
    env.DB.prepare(
      `INSERT INTO auth_challenges
         (token_hash, kind, user_id, challenge, context, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      await sha256Hex(token),
      kind,
      userId,
      challenge,
      JSON.stringify(context),
      now,
      now + CEREMONY_TTL_SEC * 1_000,
    ),
  ]);
  return token;
}

/** Atomically consume before verifying so even a failed response cannot be replayed. */
async function consumeChallenge(
  env: Bindings,
  token: string,
  kind: ChallengeKind,
): Promise<ChallengeRow | null> {
  return env.DB.prepare(
    `DELETE FROM auth_challenges
     WHERE token_hash = ? AND kind = ? AND expires_at >= ?
     RETURNING *`,
  )
    .bind(await sha256Hex(token), kind, Date.now())
    .first<ChallengeRow>();
}

function parseContext<T extends object>(row: ChallengeRow): T | null {
  try {
    const value: unknown = JSON.parse(row.context);
    return isRecord(value) ? value as T : null;
  } catch {
    return null;
  }
}

async function registrationOptions(
  env: Bindings,
  user: Pick<UserRow, "id" | "webauthn_user_id">,
  rp: RelyingParty,
) {
  const passkeys = await env.DB.prepare(
    "SELECT credential_id, transports FROM passkeys WHERE user_id = ? ORDER BY created_at",
  )
    .bind(user.id)
    .all<Pick<PasskeyRow, "credential_id" | "transports">>();
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userID: fromHex(user.webauthn_user_id),
    userName: `account-${user.id}`,
    userDisplayName: "Codestation account",
    attestationType: "none",
    timeout: CEREMONY_TTL_SEC * 1_000,
    excludeCredentials: passkeys.results.map((passkey) => ({
      id: passkey.credential_id,
      transports: parseTransports(passkey.transports),
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
}

function responseFromBody<T>(body: unknown): T | null {
  if (!isRecord(body) || !isRecord(body.response)) return null;
  return body.response as T;
}

async function verifyNewPasskey(
  response: RegistrationResponseJSON,
  row: ChallengeRow,
  context: RegistrationContext,
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response,
    expectedChallenge: row.challenge,
    expectedOrigin: context.origin,
    expectedRPID: context.rpID,
    requireUserVerification: true,
  });
}

function passkeyInsert(
  env: Bindings,
  userId: string,
  verification: Extract<VerifiedRegistrationResponse, { verified: true }>,
  createdAt: number,
) {
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  return env.DB.prepare(
    `INSERT INTO passkeys
       (credential_id, user_id, public_key, counter, transports, device_type,
        backed_up, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Passkey', ?)`,
  ).bind(
    credential.id,
    userId,
    credential.publicKey,
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    credentialDeviceType,
    credentialBackedUp ? 1 : 0,
    createdAt,
  );
}

async function beginInviteRegistration(env: Bindings, code: string, rp: RelyingParty) {
  const normalized = normalizeInviteCode(code);
  if (!normalized || !env.INVITE_ADMIN_SECRET) return null;
  const codeHash = await hashInviteCode(normalized, env.INVITE_ADMIN_SECRET);
  const available = await env.DB.prepare(
    `SELECT i.code_hash FROM invite_codes i
     LEFT JOIN invite_redemptions r ON r.code_hash = i.code_hash
     WHERE i.code_hash = ? AND r.code_hash IS NULL`,
  )
    .bind(codeHash)
    .first<{ code_hash: string }>();
  if (!available) return null;

  const pendingUser = {
    id: crypto.randomUUID(),
    webauthn_user_id: randomToken(),
  };
  const options = await registrationOptions(env, pendingUser, rp);
  const context: InviteContext = {
    ...rp,
    codeHash,
    pendingUserId: pendingUser.id,
    webauthnUserId: pendingUser.webauthn_user_id,
  };
  const token = await createChallenge(env, "invite", null, options.challenge, context);
  return { options, token };
}

export const passkeyRoutes = new Hono<AppContext>()
  .post("/auth/passkey/authenticate/options", async (c) => {
    let rp: RelyingParty;
    try {
      rp = relyingParty(c.req.url);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Passkeys are unavailable." }, 400);
    }
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      allowCredentials: [],
      timeout: CEREMONY_TTL_SEC * 1_000,
      userVerification: "required",
    });
    const token = await createChallenge(c.env, "authentication", null, options.challenge, rp);
    c.header(
      "set-cookie",
      ceremonyCookie(AUTH_COOKIE, token, c.req.url.startsWith("https://")),
    );
    c.header("cache-control", "no-store");
    return c.json(options);
  })
  .post("/auth/passkey/authenticate/verify", async (c) => {
    const token = readCookie(c.req.header("cookie"), AUTH_COOKIE);
    const body = await readJsonBody<unknown>(c);
    const response = responseFromBody<AuthenticationResponseJSON>(body);
    if (!token || !response || !isCredentialId(response.id)) {
      return c.json({ error: "Passkey sign-in expired. Please try again." }, 400);
    }
    const challenge = await consumeChallenge(c.env, token, "authentication");
    c.header("set-cookie", clearCeremonyCookie(AUTH_COOKIE), { append: true });
    const rp = challenge ? parseContext<RelyingParty>(challenge) : null;
    if (!challenge || !rp) {
      return c.json({ error: "Passkey sign-in expired. Please try again." }, 400);
    }

    const passkey = await c.env.DB.prepare(
      `SELECT p.*, u.status AS user_status
       FROM passkeys p JOIN users u ON u.id = p.user_id
       WHERE p.credential_id = ?`,
    )
      .bind(response.id)
      .first<PasskeyRow & { user_status: UserRow["status"] }>();
    if (!passkey || passkey.user_status !== "active") {
      return c.json({ error: "This passkey could not be verified." }, 401);
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
          id: passkey.credential_id,
          publicKey: publicKeyBytes(passkey.public_key),
          counter: passkey.counter,
          transports: parseTransports(passkey.transports),
        },
      });
      if (!verification.verified) {
        return c.json({ error: "This passkey could not be verified." }, 401);
      }
      const now = Date.now();
      await c.env.DB.prepare(
        `UPDATE passkeys
         SET counter = MAX(counter, ?), device_type = ?, backed_up = ?, last_used_at = ?
         WHERE credential_id = ?`,
      ).bind(
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialDeviceType,
        verification.authenticationInfo.credentialBackedUp ? 1 : 0,
        now,
        passkey.credential_id,
      ).run();
    } catch {
      return c.json({ error: "This passkey could not be verified." }, 401);
    }

    const user = await getUser(c.env, passkey.user_id);
    if (!user || user.status !== "active") {
      return c.json({ error: "This passkey could not be verified." }, 401);
    }
    const login = await loginAndRedirect(c.env, user, c.req.url.startsWith("https://"));
    c.header("set-cookie", login.cookie, { append: true });
    return c.json({ redirect: login.location });
  })
  .post("/auth/passkey/register/options", requireUser, async (c) => {
    const user = c.get("user");
    let rp: RelyingParty;
    try {
      rp = relyingParty(c.req.url);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Passkeys are unavailable." }, 400);
    }
    const options = await registrationOptions(c.env, user, rp);
    const context: RegistrationContext = { ...rp, webauthnUserId: user.webauthn_user_id };
    const token = await createChallenge(
      c.env,
      "registration",
      user.id,
      options.challenge,
      context,
    );
    c.header(
      "set-cookie",
      ceremonyCookie(REGISTRATION_COOKIE, token, c.req.url.startsWith("https://")),
    );
    c.header("cache-control", "no-store");
    return c.json(options);
  })
  .post("/auth/passkey/register/verify", requireUser, async (c) => {
    const token = readCookie(c.req.header("cookie"), REGISTRATION_COOKIE);
    const body = await readJsonBody<unknown>(c);
    const response = responseFromBody<RegistrationResponseJSON>(body);
    if (!token || !response) {
      return c.json({ error: "Passkey setup expired. Please try again." }, 400);
    }
    const challenge = await consumeChallenge(c.env, token, "registration");
    c.header("set-cookie", clearCeremonyCookie(REGISTRATION_COOKIE));
    const context = challenge ? parseContext<RegistrationContext>(challenge) : null;
    const user = c.get("user");
    if (!challenge || !context || challenge.user_id !== user.id) {
      return c.json({ error: "Passkey setup expired. Please try again." }, 400);
    }

    try {
      const verification = await verifyNewPasskey(response, challenge, context);
      if (!verification.verified) {
        return c.json({ error: "The passkey could not be verified." }, 400);
      }
      await passkeyInsert(c.env, user.id, verification, Date.now()).run();
    } catch {
      return c.json({ error: "The passkey could not be added. It may already be registered." }, 409);
    }
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ count: number }>();
    return c.json({ verified: true, passkeyCount: count?.count ?? 1 });
  })
  .post("/auth/invite/register/options", async (c) => {
    const body = await readJsonBody<{ code?: unknown }>(c);
    if (!body || typeof body.code !== "string") {
      return c.json({ error: "Enter your eight-character invite code." }, 400);
    }
    let rp: RelyingParty;
    try {
      rp = relyingParty(c.req.url);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Passkeys are unavailable." }, 400);
    }
    const start = await beginInviteRegistration(c.env, body.code, rp);
    if (!start) return c.json({ error: "That invite code is invalid or has already been used." }, 403);
    c.header(
      "set-cookie",
      ceremonyCookie(INVITE_COOKIE, start.token, c.req.url.startsWith("https://")),
    );
    c.header("cache-control", "no-store");
    return c.json(start.options);
  })
  .post("/auth/invite/register/verify", async (c) => {
    const token = readCookie(c.req.header("cookie"), INVITE_COOKIE);
    const body = await readJsonBody<unknown>(c);
    const response = responseFromBody<RegistrationResponseJSON>(body);
    if (!token || !response) {
      return c.json({ error: "Invite setup expired. Enter the code again." }, 400);
    }
    const challenge = await consumeChallenge(c.env, token, "invite");
    c.header("set-cookie", clearCeremonyCookie(INVITE_COOKIE), { append: true });
    const context = challenge ? parseContext<InviteContext>(challenge) : null;
    if (!challenge || !context) {
      return c.json({ error: "Invite setup expired. Enter the code again." }, 400);
    }

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyNewPasskey(response, challenge, context);
    } catch {
      return c.json({ error: "The passkey could not be verified." }, 400);
    }
    if (!verification.verified) {
      return c.json({ error: "The passkey could not be verified." }, 400);
    }
    try {
      const now = Date.now();
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO users
             (id, webauthn_user_id, signup_method, created_at, last_authenticated_at)
           VALUES (?, ?, 'invite', ?, ?)`,
        ).bind(context.pendingUserId, context.webauthnUserId, now, now),
        passkeyInsert(c.env, context.pendingUserId, verification, now),
        c.env.DB.prepare(
          `INSERT INTO invite_redemptions (code_hash, user_id, redeemed_at)
           VALUES (?, ?, ?)`,
        ).bind(context.codeHash, context.pendingUserId, now),
      ]);
    } catch {
      return c.json({ error: "That invite code has already been used." }, 409);
    }

    const user = await getUser(c.env, context.pendingUserId);
    if (!user) return c.json({ error: "Account setup failed. Please sign in with your passkey." }, 500);
    const login = await loginAndRedirect(c.env, user, c.req.url.startsWith("https://"));
    c.header("set-cookie", login.cookie, { append: true });
    return c.json({ verified: true, redirect: login.location });
  });
