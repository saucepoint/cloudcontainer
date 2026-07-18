import { Hono, type MiddlewareHandler } from "hono";
import { hmacNullifier } from "@codestation/contract";
import { readJsonBody } from "./http.js";
import {
  clearSessionCookie,
  createSession,
  getSessionUserId,
  isSessionRevoked,
  readCookie,
  revokeSession,
  randomToken,
  SESSION_COOKIE,
  sessionCookie,
} from "./sessions.js";
import { signWorldIdRequest, verifyWorldIdProof } from "./worldid.js";
import type { AppContext, Bindings, UserRow } from "./types.js";

export const CREDENTIALS_LOCKED_ERROR =
  "Credentials are set during server setup. To change them after creating your server, use manual terminal commands.";

export async function credentialsCanBeChanged(env: Bindings, userId: string): Promise<boolean> {
  const container = await env.DB.prepare("SELECT 1 FROM containers WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first();
  return !container;
}

export async function getUser(env: Bindings, userId: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

interface IdentityLogin {
  user: UserRow;
  isNew: boolean;
}

/** Look up or create an account for a verified external identity. Returns null if banned. */
async function findOrCreateUser(
  env: Bindings,
  provider: "world_id" | "dev",
  identityKey: string,
  protocolVersion: string | null,
): Promise<IdentityLogin | null> {
  const existing = await env.DB.prepare(
    `SELECT u.* FROM auth_identities i
     JOIN users u ON u.id = i.user_id
     WHERE i.provider = ? AND i.provider_subject = ?`,
  )
    .bind(provider, identityKey)
    .first<UserRow>();
  if (existing) return existing.status === "banned" ? null : { user: existing, isNew: false };

  // The v4 session ID or action-scoped normalized nullifier bounds an accepted
  // identity to one account. The HMAC match survives account deletion (§13).
  const banned = await env.DB.prepare(
    "SELECT nullifier_hmac FROM banned_nullifiers WHERE nullifier_hmac = ?",
  )
    .bind(hmacNullifier(identityKey, env.NULLIFIER_HMAC_KEY))
    .first();
  if (banned) return null;

  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
           (id, webauthn_user_id, signup_method, created_at, last_authenticated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(id, randomToken(), provider, now, now),
      env.DB.prepare(
        `INSERT INTO auth_identities
           (provider, provider_subject, user_id, protocol_version, created_at, last_authenticated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(provider, identityKey, id, protocolVersion, now, now),
    ]);
    const user = await getUser(env, id);
    if (!user) throw new Error("created user could not be loaded");
    return { user, isNew: true };
  } catch (error) {
    // Two tabs can complete the same proof concurrently. The unique identity
    // chooses the winner; the other request logs into it.
    const winner = await env.DB.prepare(
      `SELECT u.* FROM auth_identities i
       JOIN users u ON u.id = i.user_id
       WHERE i.provider = ? AND i.provider_subject = ?`,
    )
      .bind(provider, identityKey)
      .first<UserRow>();
    if (winner) {
      return winner.status === "banned" ? null : { user: winner, isNew: false };
    }
    throw error;
  }
}

export async function postLoginPath(env: Bindings, userId: string): Promise<string> {
  const container = await env.DB.prepare("SELECT id FROM containers WHERE user_id = ?")
    .bind(userId)
    .first();
  return container ? "/dashboard" : "/onboarding";
}

export async function loginAndRedirect(
  env: Bindings,
  user: UserRow,
  secure: boolean,
  location?: string,
) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET last_authenticated_at = ? WHERE id = ?").bind(now, user.id),
    env.DB.prepare(
      "UPDATE auth_identities SET last_authenticated_at = ? WHERE user_id = ?",
    ).bind(now, user.id),
  ]);
  const sid = await createSession(env, user.id);
  return {
    location: location ?? await postLoginPath(env, user.id),
    cookie: sessionCookie(sid, secure),
  };
}

export const authRoutes = new Hono<AppContext>()
  // Client fetches this immediately before opening IDKit. New sign-ins bind
  // the fixed login action; saved v4 sessions retain their actionless context.
  .get("/auth/session/rp-context", (c) => {
    const mode = c.req.query("mode") === "session" ? "session" : "proof";
    c.header("cache-control", "no-store");
    return c.json({
      app_id: c.env.WORLD_ID_APP_ID,
      action: c.env.WORLD_ID_ACTION,
      rp_context: signWorldIdRequest(c.env, mode),
    });
  })
  // Capture a World App protocol outcome when the native client only shows a
  // generic error. The browser intentionally sends no proof, identity, or
  // session value to this endpoint.
  .post("/auth/session/failure", async (c) => {
    const body = await readJsonBody<{ code?: unknown; request_id?: unknown }>(c);
    const code =
      typeof body?.code === "string" && /^[a-z_]{1,64}$/.test(body.code)
        ? body.code
        : "unknown";
    const requestId =
      typeof body?.request_id === "string" && /^[0-9a-f-]{36}$/i.test(body.request_id)
        ? body.request_id
        : undefined;
    console.log(JSON.stringify({ event: "worldid_client_failed", code, requestId }));
    return c.body(null, 204);
  })
  .post("/auth/session/verify", async (c) => {
    const body = await readJsonBody<{ idkitResponse?: unknown }>(c);
    if (!body || typeof body !== "object" || !("idkitResponse" in body)) {
      return c.json({ error: "missing idkitResponse" }, 400);
    }

    let identity;
    try {
      identity = await verifyWorldIdProof(c.env, body.idkitResponse);
    } catch (err) {
      console.log(JSON.stringify({ event: "worldid_verify_failed", error: String(err) }));
      return c.json({ error: "World ID verification failed. Please try again." }, 502);
    }

    const login = await findOrCreateUser(
      c.env,
      "world_id",
      identity.identityKey,
      identity.protocolVersion,
    );
    if (!login) return c.json({ error: "This World ID is not eligible for an account." }, 403);
    const { location, cookie } = await loginAndRedirect(
      c.env,
      login.user,
      c.req.url.startsWith("https://"),
      login.isNew ? "/security?welcome=1" : undefined,
    );
    c.header("set-cookie", cookie);
    return c.json({ redirect: location });
  })
  // World ID bypass, two modes: DEV_AUTH="1" opens it for local dev (visible
  // "Dev login" button); the DEV_AUTH_TOKEN secret enables it on a deployment
  // via /auth/dev?token=… without exposing signup to the public.
  .get("/auth/dev", async (c) => {
    const tokenOk =
      Boolean(c.env.DEV_AUTH_TOKEN) && c.req.query("token") === c.env.DEV_AUTH_TOKEN;
    if (c.env.DEV_AUTH !== "1" && !tokenOk) return c.notFound();
    const sub = c.req.query("sub") ?? "dev-user";
    const login = await findOrCreateUser(c.env, "dev", `dev|${sub}`, null);
    if (!login) return c.text("banned", 403);
    const { location, cookie } = await loginAndRedirect(
      c.env,
      login.user,
      c.req.url.startsWith("https://"),
    );
    return new Response(null, {
      status: 302,
      headers: {
        location,
        "set-cookie": cookie,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  })
  .post("/auth/logout", async (c) => {
    const sid = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    if (sid) await revokeSession(c.env, sid);
    return new Response(null, {
      status: 302,
      headers: { location: "/", "set-cookie": clearSessionCookie() },
    });
  });

/** Load the session user; JSON 401 for /api paths, redirect to landing otherwise. */
export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
  const deny = () =>
    c.req.path.startsWith("/api") || c.req.path.startsWith("/auth/passkey/register")
      ? c.json({ error: "unauthenticated" }, 401)
      : c.redirect("/");
  const sid = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (!sid) return deny();
  const userId = await getSessionUserId(c.env, sid);
  if (!userId) return deny();
  const user = await getUser(c.env, userId);
  if (!user || user.status !== "active") return deny();
  c.set("user", user);
  c.set("sessionId", sid);
  return next();
};

/** Credential changes are an onboarding-only action. Check again on OAuth
 * completion so a flow begun in another tab cannot update a new server. */
export const requireCredentialSetup: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!(await credentialsCanBeChanged(c.env, c.get("user").id))) {
    return c.json({ error: CREDENTIALS_LOCKED_ERROR }, 409);
  }
  return next();
};

/** Extra strongly-consistent revocation check for destructive operations (§12). */
export const requireUnrevokedSession: MiddlewareHandler<AppContext> = async (c, next) => {
  if (await isSessionRevoked(c.env, c.get("sessionId"))) {
    return c.json({ error: "session revoked" }, 401);
  }
  return next();
};
