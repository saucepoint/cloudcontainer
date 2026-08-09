import { Hono, type MiddlewareHandler } from "hono";
import { createAuth, signedSessionCookie } from "./better-auth.js";
import { effectiveEntitlementForUser } from "./entitlements.js";
import type { AppContext, Bindings, UserRow } from "./types.js";

export const CREDENTIALS_LOCKED_ERROR =
  "Credentials are set while you set up your workbench. To change them after provisioning, use manual terminal commands.";

export async function credentialsCanBeChanged(env: Bindings, userId: string): Promise<boolean> {
  const container = await env.DB.prepare("SELECT 1 FROM containers WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first();
  return !container;
}

async function getUser(env: Bindings, userId: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function postLoginPath(env: Bindings, userId: string): Promise<string> {
  const user = await getUser(env, userId);
  if (!user || !(await effectiveEntitlementForUser(env, user)).eligible) return "/verify";
  const container = await env.DB.prepare("SELECT id FROM containers WHERE user_id = ?")
    .bind(userId)
    .first();
  return container ? "/dashboard" : "/onboarding";
}

async function loadAccount(c: Parameters<MiddlewareHandler<AppContext>>[0]) {
  const auth = createAuth(c.env, c.req.url);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const user = await getUser(c.env, session.user.id);
  if (!user || user.status !== "active") return null;
  c.set("user", user);
  return user;
}

function deny(c: Parameters<MiddlewareHandler<AppContext>>[0]) {
  return c.req.path.startsWith("/api")
    ? c.json({ error: "unauthenticated" }, 401)
    : c.redirect("/");
}

/** Require a valid Better Auth session without enforcing product eligibility. */
export const requireAccount: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!(await loadAccount(c))) return deny(c);
  return next();
};

/** Require either permanent free eligibility or a current paid/manual entitlement. */
export const requireEligibleAccount: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = await loadAccount(c);
  if (!user) return deny(c);
  if (!(await effectiveEntitlementForUser(c.env, user)).eligible) {
    return c.req.path.startsWith("/api")
      ? c.json({ error: "an active plan or free-tier verification is required", redirect: "/verify" }, 403)
      : c.redirect("/verify");
  }
  return next();
};

/** Rolling source compatibility for route modules; new code should use the explicit name. */
export const requireUser = requireEligibleAccount;

async function findOrCreateDevelopmentUser(env: Bindings, subject: string): Promise<UserRow> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subject),
  ));
  const suffix = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = `dev-${suffix}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, email, email_verified, verified_at, verification_method, created_at, updated_at)
     VALUES (?, 'Development account', ?, 1, ?, 'development', ?, ?)`,
  ).bind(id, `${id}@accounts.usebench.invalid`, now, now, now).run();
  const user = await getUser(env, id);
  if (!user) throw new Error("Development account could not be created.");
  return user;
}

export const authRoutes = new Hono<AppContext>()
  .get("/auth/dev", async (c) => {
    if (c.env.DEV_AUTH !== "1") return c.notFound();
    const user = await findOrCreateDevelopmentUser(c.env, c.req.query("sub") ?? "dev-user");
    const auth = createAuth(c.env, c.req.url);
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(user.id);
    if (!session) return c.text("Development login failed.", 500);
    return new Response(null, {
      status: 302,
      headers: {
        location: await postLoginPath(c.env, user.id),
        "set-cookie": await signedSessionCookie(c.env, session.token, c.req.url),
        "cache-control": "no-store",
      },
    });
  })
  .post("/auth/logout", async (c) => {
    const auth = createAuth(c.env, c.req.url);
    const response = await auth.api.signOut({
      headers: c.req.raw.headers,
      asResponse: true,
    });
    const headers = new Headers({ location: "/" });
    for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers });
  });

export const requireCredentialSetup: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!(await credentialsCanBeChanged(c.env, c.get("user").id))) {
    return c.json({ error: CREDENTIALS_LOCKED_ERROR }, 409);
  }
  return next();
};
