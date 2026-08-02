import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { adminRoutes } from "../src/admin.js";
import { apiRoutes } from "../src/api.js";
import { app as workerApp } from "../src/index.js";
import type { AppContext } from "../src/types.js";
import { createTestSession, makeEnv, seedUser } from "./helpers/env.js";

function app() {
  return new Hono<AppContext>().route("/", adminRoutes).route("/", apiRoutes);
}

function adminJson(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer admin-secret",
    },
    body: JSON.stringify(value),
  };
}

describe("account notifications", () => {
  it("publishes a global notification and tracks each user's read state", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const user = await seedUser(env);
    const cookie = await createTestSession(env, user.id);
    const otherUser = await seedUser(env, "user-2");
    const otherCookie = await createTestSession(env, otherUser.id);

    const created = await app().request(
      "/api/admin/notifications",
      adminJson({
        title: "Scheduled system upgrade",
        message: "Your container will be destroyed during maintenance.",
        severity: "critical",
      }),
      env,
    );
    expect(created.status).toBe(201);
    const notification = (await created.json()) as { notification: { id: string } };

    const list = await app().request("/api/notifications", { headers: { cookie } }, env);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      unreadCount: 1,
      notifications: [{
        id: notification.notification.id,
        title: "Scheduled system upgrade",
        message: "Your container will be destroyed during maintenance.",
        severity: "critical",
        readAt: null,
      }],
    });
    const otherList = await app().request("/api/notifications", { headers: { cookie: otherCookie } }, env);
    expect(await otherList.json()).toMatchObject({ unreadCount: 1 });

    const account = await workerApp.request("/account", { headers: { cookie } }, env);
    const html = await account.text();
    expect(html).toContain('data-notification-count="1"');
    expect(html).toContain("Scheduled system upgrade");
    expect(html).toContain("Your container will be destroyed during maintenance.");

    const read = await app().request(
      `/api/notifications/${notification.notification.id}/read`,
      { method: "POST", headers: { cookie } },
      env,
    );
    expect(read.status).toBe(200);
    const afterRead = await app().request("/api/notifications", { headers: { cookie } }, env);
    expect(await afterRead.json()).toMatchObject({ unreadCount: 0 });
    const otherAfterRead = await app().request("/api/notifications", { headers: { cookie: otherCookie } }, env);
    expect(await otherAfterRead.json()).toMatchObject({ unreadCount: 1 });
  });

  it("rejects malformed announcements and expires old ones", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const user = await seedUser(env);
    const cookie = await createTestSession(env, user.id);

    const invalid = await app().request(
      "/api/admin/notifications",
      adminJson({ title: "", message: "maintenance" }),
      env,
    );
    expect(invalid.status).toBe(400);

    const expired = await app().request(
      "/api/admin/notifications",
      adminJson({ title: "Old notice", message: "gone", expiresAt: Date.now() - 1 }),
      env,
    );
    expect(expired.status).toBe(400);
    await env.DB.prepare(
      `INSERT INTO notifications (id, title, message, severity, created_at, expires_at)
       VALUES ('expired', 'Old notice', 'gone', 'info', ?, ?)`
    ).bind(Date.now() - 10_000, Date.now() - 1).run();

    const missingSecret = await app().request(
      "/api/admin/notifications",
      adminJson({ title: "Notice", message: "message" }),
      makeEnv().env,
    );
    expect(missingSecret.status).toBe(404);

    const list = await app().request("/api/notifications", { headers: { cookie } }, env);
    expect(await list.json()).toEqual({ notifications: [], unreadCount: 0 });
  });

  it("marks all active announcements read without changing their content", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const user = await seedUser(env);
    const cookie = await createTestSession(env, user.id);
    for (const title of ["First", "Second"]) {
      const response = await app().request(
        "/api/admin/notifications",
        adminJson({ title, message: "Please read this." }),
        env,
      );
      expect(response.status).toBe(201);
    }

    const readAll = await app().request(
      "/api/notifications/read-all",
      { method: "POST", headers: { cookie } },
      env,
    );
    expect(readAll.status).toBe(200);
    const afterReadAll = await app().request("/api/notifications", { headers: { cookie } }, env);
    expect(await afterReadAll.json())
      .toMatchObject({ unreadCount: 0, notifications: [{ title: "Second" }, { title: "First" }] });
  });
});
