import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { adminRoutes } from "../src/admin.js";
import { apiRoutes } from "../src/api.js";
import { app as workerApp } from "../src/index.js";
import { createUserNotification } from "../src/notifications.js";
import type { AppContext } from "../src/types.js";
import { createTestSession, makeEnv, seedContainer, seedUser } from "./helpers/env.js";

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
  it("keeps billing notices scoped to their owning account", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const cookie = await createTestSession(env, user.id);
    const otherUser = await seedUser(env, "user-2");
    const otherCookie = await createTestSession(env, otherUser.id);
    await createUserNotification(env, {
      id: "billing:payment:user-1",
      userId: user.id,
      title: "Payment confirmed",
      message: "Your Paid plan is active.",
      severity: "info",
    });

    const owner = await app().request("/api/notifications", { headers: { cookie } }, env);
    expect(await owner.json()).toMatchObject({
      unreadCount: 1,
      notifications: [{ title: "Payment confirmed" }],
    });
    const other = await app().request(
      "/api/notifications",
      { headers: { cookie: otherCookie } },
      env,
    );
    expect(await other.json()).toEqual({ notifications: [], unreadCount: 0 });
  });

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

  it("limits container-user announcements to accounts with containers", async () => {
    const { env } = makeEnv({ INVITE_ADMIN_SECRET: "admin-secret" });
    const containerUser = await seedUser(env);
    await seedContainer(env, { host_id: null, ssh_port: null });
    const accountUser = await seedUser(env, "user-2");
    const containerCookie = await createTestSession(env, containerUser.id);
    const accountCookie = await createTestSession(env, accountUser.id);

    const created = await app().request(
      "/api/admin/notifications",
      adminJson({
        title: "Container maintenance",
        message: "Save your work before maintenance.",
        severity: "warning",
        audience: "container_users",
      }),
      env,
    );
    expect(created.status).toBe(201);

    const forContainerUser = await app().request(
      "/api/notifications",
      { headers: { cookie: containerCookie } },
      env,
    );
    expect(await forContainerUser.json()).toMatchObject({
      unreadCount: 2,
      notifications: [
        { title: "Container maintenance" },
        { title: "Scheduled service shutdown" },
      ],
    });
    const forAccountUser = await app().request(
      "/api/notifications",
      { headers: { cookie: accountCookie } },
      env,
    );
    expect(await forAccountUser.json()).toEqual({ notifications: [], unreadCount: 0 });
  });

  it("seeds the August 30 shutdown notice for container users", async () => {
    const { env } = makeEnv();
    const containerUser = await seedUser(env);
    await seedContainer(env, { host_id: null, ssh_port: null });
    const accountUser = await seedUser(env, "user-2");
    const containerCookie = await createTestSession(env, containerUser.id);
    const accountCookie = await createTestSession(env, accountUser.id);

    const row = await env.DB.prepare(
      "SELECT title, message, severity, expires_at, audience FROM notifications WHERE id = ?",
    ).bind("system:shutdown:2026-08-30").first<{
      title: string;
      message: string;
      severity: string;
      expires_at: number;
      audience: string;
    }>();
    expect(row).toEqual({
      title: "Scheduled service shutdown",
      message: "All workbench services will shut down on August 30, 2026. Save your work before then.",
      severity: "critical",
      expires_at: 1788134400000,
      audience: "container_users",
    });

    const forContainerUser = await app().request(
      "/api/notifications",
      { headers: { cookie: containerCookie } },
      env,
    );
    expect(await forContainerUser.json()).toMatchObject({
      notifications: [{ id: "system:shutdown:2026-08-30" }],
    });
    const forAccountUser = await app().request(
      "/api/notifications",
      { headers: { cookie: accountCookie } },
      env,
    );
    expect(await forAccountUser.json()).not.toMatchObject({
      notifications: [{ id: "system:shutdown:2026-08-30" }],
    });
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
