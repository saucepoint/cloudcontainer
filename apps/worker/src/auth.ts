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
  SESSION_COOKIE,
  sessionCookie,
} from "./sessions.js";
import { signSessionRequest, verifySessionProof } from "./worldid.js";
import type { AppContext, Bindings, UserRow } from "./types.js";

export const CREDENTIALS_LOCKED_ERROR =
  "Credentials are set during server setup. To change them after creating your server, use manual terminal commands.";

export async function credentialsCanBeChanged(env: Bindings, userId: string): Promise<boolean> {
  const container = await env.DB.prepare("SELECT 1 FROM containers WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first();
  return !container;
}

async function getUser(env: Bindings, userId: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

/** Look up or create the account for a World ID session identity. Returns null if banned. */
async function findOrCreateUser(env: Bindings, sessionId: string): Promise<UserRow | null> {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE world_id_session_id = ?")
    .bind(sessionId)
    .first<UserRow>();
  if (existing) return existing.status === "banned" ? null : existing;

  // Signup: `session_id` is stable per (RP, human) — it already bounds one
  // human to one account, same as a nullifier — so we reject banned ones
  // (HMAC match survives account deletion, §13).
  const banned = await env.DB.prepare(
    "SELECT nullifier_hmac FROM banned_nullifiers WHERE nullifier_hmac = ?",
  )
    .bind(hmacNullifier(sessionId, env.NULLIFIER_HMAC_KEY))
    .first();
  if (banned) return null;

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, world_id_nullifier, world_id_session_id, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, sessionId, sessionId, Date.now())
      .run();
    return getUser(env, id);
  } catch (error) {
    // Two tabs can complete the same World ID proof concurrently. The unique
    // session identity chooses the winner; the other request logs into it.
    const winner = await env.DB.prepare("SELECT * FROM users WHERE world_id_session_id = ?")
      .bind(sessionId)
      .first<UserRow>();
    if (winner) return winner.status === "banned" ? null : winner;
    throw error;
  }
}

async function loginAndRedirect(env: Bindings, user: UserRow, secure: boolean) {
  const sid = await createSession(env, user.id);
  const container = await env.DB.prepare("SELECT id FROM containers WHERE user_id = ?")
    .bind(user.id)
    .first();
  const location = container ? "/dashboard" : "/onboarding";
  return { location, cookie: sessionCookie(sid, secure) };
}

export const authRoutes = new Hono<AppContext>()
  // Client fetches this right before opening the IDKit session request; the RP
  // signature itself carries the replay-protection (nonce + short TTL), so no
  // server-side state needs to be stashed for this step.
  .get("/auth/session/rp-context", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ app_id: c.env.WORLD_ID_APP_ID, rp_context: signSessionRequest(c.env) });
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
      identity = await verifySessionProof(c.env, body.idkitResponse);
    } catch (err) {
      console.log(JSON.stringify({ event: "worldid_verify_failed", error: String(err) }));
      return c.json({ error: "World ID verification failed. Please try again." }, 502);
    }

    const user = await findOrCreateUser(c.env, identity.sessionId);
    if (!user) return c.json({ error: "This World ID is not eligible for an account." }, 403);
    const { location, cookie } = await loginAndRedirect(c.env, user, c.env.BASE_URL.startsWith("https"));
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
    const user = await findOrCreateUser(c.env, `dev|${sub}`);
    if (!user) return c.text("banned", 403);
    const { location, cookie } = await loginAndRedirect(
      c.env,
      user,
      c.env.BASE_URL.startsWith("https"),
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
    c.req.path.startsWith("/api")
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
  await next();
};

/** Credential changes are an onboarding-only action. Check again on OAuth
 * completion so a flow begun in another tab cannot update a new server. */
export const requireCredentialSetup: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!(await credentialsCanBeChanged(c.env, c.get("user").id))) {
    return c.json({ error: CREDENTIALS_LOCKED_ERROR }, 409);
  }
  await next();
};

/** Extra strongly-consistent revocation check for destructive operations (§12). */
export const requireUnrevokedSession: MiddlewareHandler<AppContext> = async (c, next) => {
  if (await isSessionRevoked(c.env, c.get("sessionId"))) {
    return c.json({ error: "session revoked" }, 401);
  }
  await next();
};
