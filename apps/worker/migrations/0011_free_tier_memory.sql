-- Reduce existing free-tier reservations from 2 GiB to 1.5 GiB. Swap is a
-- host-side Incus limit and therefore does not consume the D1 RAM allocation.
UPDATE containers
SET ram_mb = 1536
WHERE tier = 'free' AND ram_mb = 2048;

UPDATE hosts
SET ram_allocated_mb = COALESCE(
  (
    SELECT SUM(c.ram_mb)
    FROM containers c
    WHERE c.host_id = hosts.id
  ),
  0
);
