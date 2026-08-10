import { Hono, type MiddlewareHandler } from "hono";
import { secretMatches } from "./admin-auth.js";
import { createAuth, signedSessionCookie } from "./better-auth.js";
import { getWorkbenchConfiguration } from "./workbench-configuration.js";
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

export async function postLoginPath(env: Bindings, userId: string): Promise<"/configure" | "/dashboard"> {
  return (await getWorkbenchConfiguration(env, userId)) ? "/dashboard" : "/configure";
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

const STAGING_ACCOUNT_STATES = [
  "unverified",
  "verified",
  "premium",
  "verified_premium",
] as const;
type StagingAccountState = (typeof STAGING_ACCOUNT_STATES)[number];

async function configureStagingUser(
  env: Bindings,
  subject: string,
  state: StagingAccountState,
): Promise<UserRow> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subject),
  ));
  const suffix = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = `staging-${suffix}`;
  const now = Date.now();
  const verified = state === "verified" || state === "verified_premium";
  const premium = state === "premium" || state === "verified_premium";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO users
         (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, 'Staging QA account', ?, 1, ?, ?)`,
    ).bind(id, `${id}@accounts.usebench.invalid`, now, now),
    env.DB.prepare(
      `UPDATE users SET verified_at = ?, verification_method = ?,
         subscription_status = ?, updated_at = ? WHERE id = ?`,
    ).bind(verified ? now : null, verified ? "development" : null, premium ? "paid" : "free", now, id),
    env.DB.prepare(
      "DELETE FROM account_entitlements WHERE user_id = ?",
    ).bind(id),
    env.DB.prepare(
      `INSERT INTO account_entitlements
         (user_id, plan, source, state, source_ref, updated_at)
       SELECT ?, 'paid', 'manual', 'manual', 'staging-bypass', ?
       WHERE ? = 1`,
    ).bind(id, now, premium ? 1 : 0),
  ]);
  const user = await getUser(env, id);
  if (!user) throw new Error("Staging QA account could not be created.");
  return user;
}

async function sessionRedirect(env: Bindings, requestUrl: string, user: UserRow): Promise<Response> {
  const context = await createAuth(env, requestUrl).$context;
  const session = await context.internalAdapter.createSession(user.id);
  if (!session) return new Response("Login failed.", { status: 500 });
  return new Response(null, {
    status: 302,
    headers: {
      location: await postLoginPath(env, user.id),
      "set-cookie": await signedSessionCookie(env, session.token, requestUrl),
      "cache-control": "no-store",
    },
  });
}

function stagingBypassEnabled(env: Bindings): env is Bindings & { STAGING_AUTH_BYPASS_SECRET: string } {
  return env.BASE_URL === "https://staging.usebench.dev" && Boolean(env.STAGING_AUTH_BYPASS_SECRET);
}

export const authRoutes = new Hono<AppContext>()
  .get("/auth/dev", async (c) => {
    if (c.env.DEV_AUTH !== "1") return c.notFound();
    const user = await findOrCreateDevelopmentUser(c.env, c.req.query("sub") ?? "dev-user");
    return sessionRedirect(c.env, c.req.url, user);
  })
  .get("/auth/staging-bypass", (c) => {
    if (!stagingBypassEnabled(c.env)) return c.notFound();
    c.header("cache-control", "no-store");
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staging QA login</title></head><body><main><h1>Staging QA login</h1><form method="post"><label>Secret <input name="secret" type="password" required autocomplete="off"></label><label>Account <input name="subject" value="qa" maxlength="64" required autocomplete="off"></label><label>State <select name="state"><option value="unverified">Unverified</option><option value="verified">Verified</option><option value="premium">Premium</option><option value="verified_premium">Verified premium</option></select></label><button type="submit">Sign in</button></form></main></body></html>`);
  })
  .post("/auth/staging-bypass", async (c) => {
    if (!stagingBypassEnabled(c.env)) return c.notFound();
    const body = await c.req.parseBody();
    const provided = typeof body.secret === "string" ? body.secret : "";
    if (!(await secretMatches(provided, c.env.STAGING_AUTH_BYPASS_SECRET))) {
      return c.text("Unauthorized", 401);
    }
    const subject = typeof body.subject === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(body.subject)
      ? body.subject
      : "qa";
    const state = typeof body.state === "string" &&
        (STAGING_ACCOUNT_STATES as readonly string[]).includes(body.state)
      ? body.state as StagingAccountState
      : "unverified";
    const user = await configureStagingUser(c.env, subject, state);
    return sessionRedirect(c.env, c.req.url, user);
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
