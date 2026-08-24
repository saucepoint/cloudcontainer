-- Allow system announcements to target accounts that currently have a workbench.
ALTER TABLE notifications ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'
  CHECK (audience IN ('all', 'container_users'));

CREATE INDEX idx_notifications_audience_active
ON notifications(audience, created_at, expires_at);

-- Keep this broadcast live through August 30 UTC so container owners see it
-- before and during the scheduled shutdown. The audience is evaluated at read
-- time, so a newly created workbench owner also receives the notice.
INSERT INTO notifications
  (id, title, message, severity, created_at, expires_at, audience)
VALUES
  (
    'system:shutdown:2026-08-30',
    'Scheduled service shutdown',
    'All workbench services will shut down on August 30, 2026. Save your work before then.',
    'critical',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    1788134400000,
    'container_users'
  );
