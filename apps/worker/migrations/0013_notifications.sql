-- Global account notifications. A notification is unread for a user until a
-- row is recorded in notification_reads; this lets one announcement fan out to
-- every account without copying its content into user rows.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info'
             CHECK (severity IN ('info', 'warning', 'critical')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX idx_notifications_active ON notifications(created_at, expires_at);

CREATE TABLE notification_reads (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         INTEGER NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX idx_notification_reads_user ON notification_reads(user_id);
