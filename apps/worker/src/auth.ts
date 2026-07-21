import { Hono, type MiddlewareHandler } from "hono";
import {
  clearSessionCookie,
  createSession,
  getSessionUserId,
  isSessionRevoked,
  readCookie,
  revokeSession,
  randomToken,
  sha256Hex,
  SESSION_COOKIE,
  sessionCookie,
} from "./sessions.js";
import type { AppContext, Bindings, UserRow } from "./types.js";

export const CREDENTIALS_LOCKED_ERROR =
  "Credentials are set while you set up your workbench. To change them after provisioning, use manual terminal commands.";

export async function credentialsCanBeChanged(env: Bindings, userId: string): Promise<boolean> {
  const container = await env.DB.prepare("SELECT 1 FROM containers WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first();
  return !container;
}

export async function getUser(env: Bindings, userId: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

async function findOrCreateDevUser(env: Bindings, subject: string): Promise<UserRow> {
  const id = `dev-${await sha256Hex(subject)}`;
  const existing = await getUser(env, id);
  if (existing) return existing;

  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, webauthn_user_id, created_at, last_authenticated_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(id, randomToken(), now, now).run();
  } catch (error) {
    const winner = await getUser(env, id);
    if (!winner) throw error;
    return winner;
  }
  const user = await getUser(env, id);
  if (!user) throw new Error("created development user could not be loaded");
  return user;
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
  await env.DB.prepare("UPDATE users SET last_authenticated_at = ? WHERE id = ?")
    .bind(now, user.id)
    .run();
  const sid = await createSession(env, user.id);
  return {
    location: location ?? await postLoginPath(env, user.id),
    cookie: sessionCookie(sid, secure),
  };
}

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

export const authRoutes = new Hono<AppContext>()
  // Local-only development login, exposed only when explicitly enabled.
  .get("/auth/dev", async (c) => {
    if (c.env.DEV_AUTH !== "1") return c.notFound();
    const user = await findOrCreateDevUser(c.env, c.req.query("sub") ?? "dev-user");
    const { location, cookie } = await loginAndRedirect(
      c.env,
      user,
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
