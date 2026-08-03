import { Hono } from "hono";
import type { AppContext, Bindings } from "./types.js";
import { hashInviteCode, randomInviteCode } from "./invites.js";
import { bearerToken, secretMatches } from "./admin-auth.js";
import { createNotification, NOTIFICATION_SEVERITIES, type NotificationSeverity } from "./notifications.js";
import { readJsonBody } from "./http.js";

function isNotificationSeverity(value: unknown): value is NotificationSeverity {
  return typeof value === "string" && NOTIFICATION_SEVERITIES.some((severity) => severity === value);
}

async function createInvite(env: Bindings, secret: string): Promise<string> {
  // A collision is fantastically unlikely, but the unique hash remains the
  // source of truth and generation retries instead of returning a dead code.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomInviteCode();
    try {
      await env.DB.prepare(
        "INSERT INTO invite_codes (code_hash, created_at) VALUES (?, ?)",
      )
        .bind(await hashInviteCode(code, secret), Date.now())
        .run();
      return code;
    } catch {
      // Retry only with a fresh code; never reveal whether a hash collided.
    }
  }
  throw new Error("could not allocate a unique invite code");
}

export const adminRoutes = new Hono<AppContext>().post("/api/admin/invites", async (c) => {
  if (!c.env.INVITE_ADMIN_SECRET) return c.notFound();
  const provided = bearerToken(c.req.header("authorization"));
  if (!(await secretMatches(provided, c.env.INVITE_ADMIN_SECRET))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const code = await createInvite(c.env, c.env.INVITE_ADMIN_SECRET);
  c.header("cache-control", "no-store");
  return c.json({ code }, 201);
}).post("/api/admin/notifications", async (c) => {
  if (!c.env.INVITE_ADMIN_SECRET) return c.notFound();
  const provided = bearerToken(c.req.header("authorization"));
  if (!(await secretMatches(provided, c.env.INVITE_ADMIN_SECRET))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = await readJsonBody<{
    title?: unknown;
    message?: unknown;
    severity?: unknown;
    expiresAt?: unknown;
  }>(c);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const severity = body?.severity ?? "info";
  if (title.length < 1 || title.length > 160) {
    return c.json({ error: "title must be between 1 and 160 characters" }, 400);
  }
  if (message.length < 1 || message.length > 4_000) {
    return c.json({ error: "message must be between 1 and 4000 characters" }, 400);
  }
  if (!isNotificationSeverity(severity)) {
    return c.json({ error: "severity must be info, warning, or critical" }, 400);
  }
  if (
    body?.expiresAt !== undefined &&
    (typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now())
  ) {
    return c.json({ error: "expiresAt must be a future millisecond timestamp" }, 400);
  }

  const notification = await createNotification(c.env, {
    title,
    message,
    severity,
    expiresAt: typeof body?.expiresAt === "number" ? body.expiresAt : null,
  });
  c.header("cache-control", "no-store");
  return c.json({ notification }, 201);
});
