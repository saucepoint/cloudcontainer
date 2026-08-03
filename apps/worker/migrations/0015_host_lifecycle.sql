-- Make host identities safely reusable while retaining one immutable record
-- per retired generation. Current rows remain the scheduler's source of truth.
ALTER TABLE hosts ADD COLUMN generation INTEGER NOT NULL DEFAULT 1
  CHECK (generation > 0);
ALTER TABLE hosts ADD COLUMN retired_at INTEGER;

CREATE TABLE host_history (
  host_id                 TEXT NOT NULL,
  generation              INTEGER NOT NULL,
  host_type               TEXT NOT NULL,
  ipv4                    TEXT NOT NULL,
  ipv6                    TEXT,
  ssh_hostname            TEXT NOT NULL,
  daemon_endpoint         TEXT NOT NULL,
  daemon_cert_fp          TEXT,
  daemon_pubkey           TEXT NOT NULL,
  management_hostname     TEXT,
  management_port         INTEGER NOT NULL,
  management_user         TEXT NOT NULL,
  ram_total_mb            INTEGER NOT NULL,
  ram_reserve_mb          INTEGER NOT NULL,
  ram_allocated_mb        INTEGER NOT NULL,
  vcpu_capacity           INTEGER NOT NULL,
  vcpu_allocated          INTEGER NOT NULL,
  disk_total_gb           INTEGER NOT NULL,
  disk_allocated_gb       INTEGER NOT NULL,
  max_tenants             INTEGER NOT NULL,
  dedicated_user_id       TEXT,
  joined_at               INTEGER NOT NULL,
  last_seen_at            INTEGER,
  daemon_version          TEXT,
  reported_ram_total_mb   INTEGER,
  reported_cpu_logical    INTEGER,
  retired_at              INTEGER NOT NULL,
  retirement_reason       TEXT NOT NULL,
  PRIMARY KEY (host_id, generation)
);
CREATE INDEX idx_host_history_retired ON host_history(retired_at DESC, host_id);

-- A plan reconciliation is an orderly destroy followed by a fresh placement.
-- Target fields are deliberately separate from the currently reserved tier so
-- destroy finalization can release the original host accounting exactly once.
ALTER TABLE containers ADD COLUMN rehome_tier TEXT
  CHECK (rehome_tier IN ('free', 'paid'));
ALTER TABLE containers ADD COLUMN rehome_placement_class TEXT
  CHECK (rehome_placement_class IN ('budget', 'regular', 'dedicated'));
ALTER TABLE containers ADD COLUMN rehome_requested_at INTEGER;

-- `containers.cpu` is the advertised plan value (1/2). At this migration's
-- release point, host capacity and Incus enforcement reserved 2/3, so repair
-- legacy totals. Migration 0016 updates free-tier allocations to 1.
UPDATE hosts
SET vcpu_allocated = COALESCE((
  SELECT SUM(CASE c.tier WHEN 'free' THEN 2 WHEN 'paid' THEN 3 ELSE 0 END)
  FROM containers c
  WHERE c.host_id = hosts.id
), 0);
