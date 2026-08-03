-- Expand the host registry into a fleet model. Empty/free-only hosts become
-- budget; an exclusively paid legacy host becomes regular. Every legacy host
-- is drained for policy reconciliation. A mixed legacy host cannot satisfy
-- either class policy, so fail before assigning a class.
CREATE TABLE IF NOT EXISTS _migration_0014_class_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);
DELETE FROM _migration_0014_class_guard;
INSERT INTO _migration_0014_class_guard (ok)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM containers c
  WHERE c.host_id IS NOT NULL
  GROUP BY c.host_id
  HAVING SUM(CASE WHEN c.tier = 'paid' THEN 1 ELSE 0 END) > 0
     AND SUM(CASE WHEN c.tier <> 'paid' THEN 1 ELSE 0 END) > 0
) THEN 0 ELSE 1 END;
DROP TABLE _migration_0014_class_guard;

ALTER TABLE hosts ADD COLUMN host_type TEXT NOT NULL DEFAULT 'budget'
  CHECK (host_type IN ('budget', 'regular', 'dedicated'));
ALTER TABLE hosts ADD COLUMN max_tenants INTEGER NOT NULL DEFAULT 1
  CHECK (max_tenants > 0);
ALTER TABLE hosts ADD COLUMN dedicated_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE hosts ADD COLUMN management_hostname TEXT;
ALTER TABLE hosts ADD COLUMN management_port INTEGER NOT NULL DEFAULT 22;
ALTER TABLE hosts ADD COLUMN management_user TEXT NOT NULL DEFAULT 'root';
ALTER TABLE hosts ADD COLUMN daemon_version TEXT;
ALTER TABLE hosts ADD COLUMN reported_ram_total_mb INTEGER;
ALTER TABLE hosts ADD COLUMN reported_cpu_logical INTEGER;

UPDATE hosts
SET host_type = 'regular'
WHERE EXISTS (
  SELECT 1 FROM containers c
  WHERE c.host_id = hosts.id AND c.tier = 'paid'
);

-- Existing machines have not yet had the class-specific Incus policy or the
-- class-reporting daemon applied. Quarantine every legacy row until hostctl
-- deploys, audits, probes, and explicitly reactivates it.
UPDATE hosts SET status = 'draining';

-- The management address is operational metadata, not a credential. Existing
-- hosts default to their tenant-facing SSH hostname and can be corrected while
-- drained before the fleet controller is used.
UPDATE hosts
SET management_hostname = ssh_hostname
WHERE management_hostname IS NULL;

-- Backfill a conservative class-aware slot ceiling without lowering it below
-- the number of rows already assigned to a host.
UPDATE hosts
SET max_tenants = MAX(
  1,
  (SELECT COUNT(*) FROM containers c WHERE c.host_id = hosts.id),
  MIN(
    MAX(CAST(vcpu_capacity / CASE WHEN host_type = 'budget' THEN 2 ELSE 3 END AS INTEGER), 1),
    MAX(CAST((ram_total_mb - ram_reserve_mb) /
      CASE WHEN host_type = 'budget' THEN 1536 ELSE 4096 END AS INTEGER), 1),
    MAX(CAST(disk_total_gb /
      CASE WHEN host_type = 'budget' THEN 10 ELSE 16 END AS INTEGER), 1)
  )
);

-- Persist placement affinity on the desired container row. Assigned rows keep
-- their existing host class during the expand-first rollout; unassigned paid
-- rows target the regular pool and free rows target the budget pool.
ALTER TABLE containers ADD COLUMN placement_class TEXT NOT NULL DEFAULT 'budget'
  CHECK (placement_class IN ('budget', 'regular', 'dedicated'));

UPDATE containers
SET placement_class = CASE
  WHEN host_id IS NOT NULL THEN COALESCE(
    (SELECT h.host_type FROM hosts h WHERE h.id = containers.host_id),
    'budget'
  )
  WHEN tier = 'paid' THEN 'regular'
  ELSE 'budget'
END;

CREATE INDEX idx_hosts_class_placement
ON hosts(host_type, status, last_seen_at, consecutive_failures);

CREATE UNIQUE INDEX idx_hosts_dedicated_user
ON hosts(dedicated_user_id)
WHERE dedicated_user_id IS NOT NULL;

CREATE INDEX idx_containers_placement_waitlist
ON containers(placement_class, status, host_id);
