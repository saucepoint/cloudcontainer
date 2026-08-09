import type { Bindings } from "./types.js";

export const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export interface NotificationView {
  id: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  createdAt: number;
  expiresAt: number | null;
  readAt: number | null;
}

interface NotificationRow {
  id: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  created_at: number;
  expires_at: number | null;
  read_at: number | null;
}

function activeNotificationWhere(now: number): { sql: string; bind: number } {
  return {
    sql: "n.created_at <= ? AND (n.expires_at IS NULL OR n.expires_at > ?)",
    bind: now,
  };
}

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    severity: row.severity,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    readAt: row.read_at,
  };
}

export async function unreadNotificationCount(
  env: Bindings,
  userId: string,
  now = Date.now(),
): Promise<number> {
  const active = activeNotificationWhere(now);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM notifications n
     WHERE ${active.sql}
       AND (n.user_id IS NULL OR n.user_id = ?)
       AND NOT EXISTS (
         SELECT 1 FROM notification_reads r
         WHERE r.notification_id = n.id AND r.user_id = ?
       )`,
  )
    .bind(active.bind, now, userId, userId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function notificationsForUser(
  env: Bindings,
  userId: string,
  now = Date.now(),
): Promise<NotificationView[]> {
  const active = activeNotificationWhere(now);
  const rows = await env.DB.prepare(
    `SELECT n.id, n.title, n.message, n.severity, n.created_at, n.expires_at,
            r.read_at
     FROM notifications n
     LEFT JOIN notification_reads r
       ON r.notification_id = n.id AND r.user_id = ?
     WHERE ${active.sql}
       AND (n.user_id IS NULL OR n.user_id = ?)
     ORDER BY n.created_at DESC
     LIMIT 100`,
  )
    .bind(userId, active.bind, now, userId)
    .all<NotificationRow>();
  return rows.results.map(toView);
}

export async function createNotification(
  env: Bindings,
  input: {
    title: string;
    message: string;
    severity: NotificationSeverity;
    expiresAt: number | null;
  },
): Promise<NotificationView> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO notifications (id, title, message, severity, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.title, input.message, input.severity, createdAt, input.expiresAt)
    .run();
  return {
    id,
    title: input.title,
    message: input.message,
    severity: input.severity,
    createdAt,
    expiresAt: input.expiresAt,
    readAt: null,
  };
}

export async function createUserNotification(
  env: Bindings,
  input: {
    id: string;
    userId: string;
    title: string;
    message: string;
    severity: NotificationSeverity;
    createdAt?: number;
    expiresAt?: number | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notifications
       (id, user_id, title, message, severity, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.id,
    input.userId,
    input.title,
    input.message,
    input.severity,
    input.createdAt ?? Date.now(),
    input.expiresAt ?? null,
  ).run();
}

export async function markNotificationRead(
  env: Bindings,
  userId: string,
  notificationId: string,
  readAt = Date.now(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
     SELECT n.id, ?, ?
     FROM notifications n
     WHERE n.id = ? AND (n.user_id IS NULL OR n.user_id = ?)`,
  )
    .bind(userId, readAt, notificationId, userId)
    .run();
}

export async function markAllNotificationsRead(
  env: Bindings,
  userId: string,
  readAt = Date.now(),
): Promise<void> {
  const active = activeNotificationWhere(readAt);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
     SELECT n.id, ?, ?
     FROM notifications n
     WHERE ${active.sql}
       AND (n.user_id IS NULL OR n.user_id = ?)
       AND NOT EXISTS (
         SELECT 1 FROM notification_reads r
         WHERE r.notification_id = n.id AND r.user_id = ?
       )`,
  )
    .bind(userId, readAt, active.bind, readAt, userId, userId)
    .run();
}
