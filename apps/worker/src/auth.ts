import { Hono, type MiddlewareHandler } from "hono";
import { hmacNullifier } from "@workbench/contract";
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
import {
  createWorldIdContext,
  verifyWorldIdSession,
  WorldIdVerificationError,
} from "./worldid.js";
import type { AppContext, Bindings, UserRow } from "./types.js";

export const CREDENTIALS_LOCKED_ERROR =
  "Credentials are set while you set up your workbench. To change them after provisioning, use manual terminal commands.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

  // The verified provider subject bounds an accepted identity to one account.
  // Its keyed HMAC survives account deletion (§13).
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
  .post("/auth/world-id/context", (c) => {
    c.header("cache-control", "no-store");
    try {
      return c.json(createWorldIdContext(c.env));
    } catch (error) {
      console.log(JSON.stringify({ event: "worldid_sign_failed", error: String(error) }));
      return c.json({ error: "Could not start World ID sign-in." }, 500);
    }
  })
  .post("/auth/world-id/failure", async (c) => {
    const body = await readJsonBody<{
      code?: unknown;
      request_id?: unknown;
      transport?: unknown;
      mini_app?: unknown;
    }>(c);
    const code =
      typeof body?.code === "string" && /^[a-z_]{1,64}$/.test(body.code)
        ? body.code
        : "unknown";
    const requestId =
      typeof body?.request_id === "string" && /^[0-9a-f-]{36}$/i.test(body.request_id)
        ? body.request_id
        : undefined;
    const transport = body?.transport === "bridge" || body?.transport === "mini_app"
      ? body.transport
      : undefined;
    const rawMiniApp = body?.mini_app;
    const miniApp = isRecord(rawMiniApp)
      ? {
        ...(rawMiniApp.verify_version === 1 || rawMiniApp.verify_version === 2
          ? { verifyVersion: rawMiniApp.verify_version }
          : {}),
        ...(rawMiniApp.platform === "ios" || rawMiniApp.platform === "android" || rawMiniApp.platform === "none"
          ? { platform: rawMiniApp.platform }
          : {}),
        ...(rawMiniApp.send_channel === "webkit.minikit" || rawMiniApp.send_channel === "Android.postMessage" || rawMiniApp.send_channel === "none"
          ? { sendChannel: rawMiniApp.send_channel }
          : {}),
        ...(typeof rawMiniApp.minikit_subscribed === "boolean"
          ? { minikitSubscribed: rawMiniApp.minikit_subscribed }
          : {}),
        ...(rawMiniApp.response_channel === "window.message" || rawMiniApp.response_channel === "minikit"
          ? { responseChannel: rawMiniApp.response_channel }
          : {}),
      }
      : undefined;
    // Do not log the SDK debug report wholesale: its request/response payload
    // can contain a short-lived signature or a proof. These transport fields
    // are sufficient to diagnose native-bridge failures safely.
    console.log(JSON.stringify({
      event: "worldid_client_failed",
      code,
      requestId,
      ...(transport ? { transport } : {}),
      ...(miniApp && Object.keys(miniApp).length > 0 ? { miniApp } : {}),
    }));
    return c.body(null, 204);
  })
  .post("/auth/world-id/verify", async (c) => {
    const body = await readJsonBody<{ idkitResponse?: unknown }>(c);
    if (!body || typeof body !== "object" || !("idkitResponse" in body)) {
      return c.json({ error: "missing idkitResponse" }, 400);
    }

    let sessionId: string;
    try {
      sessionId = await verifyWorldIdSession(c.env, body.idkitResponse);
    } catch (err) {
      console.log(JSON.stringify({ event: "worldid_verify_failed", error: String(err) }));
      const status = err instanceof WorldIdVerificationError ? err.status : 502;
      return c.json({ error: "World ID verification failed. Please try again." }, status);
    }

    const login = await findOrCreateUser(
      c.env,
      "world_id",
      sessionId,
      "4.0",
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
  // Local-only development login, exposed only when explicitly enabled.
  .get("/auth/dev", async (c) => {
    if (c.env.DEV_AUTH !== "1") return c.notFound();
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
