-- Host placement must account for CPU as well as RAM/disk, and must stop
-- admitting tenants to a daemon that has gone stale. Existing hosts receive a
-- conservative CPU ceiling equal to their current 2 GiB RAM slot count; the
-- host bootstrap records a hardware-derived overcommit ceiling for new hosts.
ALTER TABLE hosts ADD COLUMN vcpu_capacity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hosts ADD COLUMN vcpu_allocated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hosts ADD COLUMN last_seen_at INTEGER;
ALTER TABLE hosts ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

UPDATE hosts
SET vcpu_capacity = MAX(
      1,
      CAST((ram_total_mb - ram_reserve_mb) / 2048 AS INTEGER)
    ),
    vcpu_allocated = COALESCE(
      (
        SELECT SUM(c.cpu)
        FROM containers c
        WHERE c.host_id = hosts.id
      ),
      0
    ),
    last_seen_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;

CREATE INDEX idx_hosts_placement
ON hosts(status, last_seen_at, consecutive_failures);
