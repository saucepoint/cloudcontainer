-- `containers.disk_gb` remains the persistent /home/dev quota. Each container
-- now receives an equally sized disposable rootfs quota, so host accounting
-- reserves both. Recompute from source-of-truth rows for existing hosts.
UPDATE hosts
SET disk_allocated_gb = COALESCE(
  (
    SELECT SUM(c.disk_gb * 2)
    FROM containers c
    WHERE c.host_id = hosts.id
  ),
  0
);
