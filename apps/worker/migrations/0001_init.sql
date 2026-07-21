-- Workbench D1 schema (spec §8, minus Stripe/email tables)

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,            -- UUID, internal identity
  status               TEXT NOT NULL DEFAULT 'active',       -- active|banned|deleted
  subscription_status  TEXT NOT NULL DEFAULT 'free',
  created_at           INTEGER NOT NULL
);

CREATE TABLE ssh_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  label       TEXT NOT NULL DEFAULT '',
  pubkey      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_ssh_keys_user ON ssh_keys(user_id);

CREATE TABLE hosts (
  id                TEXT PRIMARY KEY,
  ipv4              TEXT NOT NULL,
  ipv6              TEXT,
  ssh_hostname      TEXT NOT NULL,        -- what users put in `ssh -p <port> dev@<this>`
  daemon_endpoint   TEXT NOT NULL,        -- https://host:port for the control daemon
  daemon_cert_fp    TEXT,                 -- pinned server-cert fingerprint (informational)
  daemon_pubkey     TEXT NOT NULL,        -- X25519 pubkey; credential payloads sealed to it
  ram_total_mb      INTEGER NOT NULL,
  ram_allocated_mb  INTEGER NOT NULL DEFAULT 0,
  ram_reserve_mb    INTEGER NOT NULL,     -- upgrade-headroom reserve (§10)
  disk_total_gb     INTEGER NOT NULL,
  disk_allocated_gb INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',   -- active|draining|dead
  joined_at         INTEGER NOT NULL
);

CREATE TABLE containers (
  id                    TEXT PRIMARY KEY,   -- UUID
  user_id               TEXT NOT NULL UNIQUE REFERENCES users(id),  -- one per account
  host_id               TEXT REFERENCES hosts(id),
  ssh_port              INTEGER,
  agent                 TEXT NOT NULL,      -- pi|claude|codex|opencode
  tier                  TEXT NOT NULL DEFAULT 'free',
  cpu                   INTEGER NOT NULL,
  ram_mb                INTEGER NOT NULL,
  disk_gb               INTEGER NOT NULL,
  status                TEXT NOT NULL,      -- waitlisted|provisioning|running|stopped|
                                            -- suspended|upgrade_pending|error|destroying
  status_detail         TEXT,               -- human-readable note for error states
  host_key_fingerprints TEXT,               -- JSON array, shown to defeat blind TOFU
  suspended_at          INTEGER,
  created_at            INTEGER NOT NULL,
  last_upgraded_at      INTEGER
);
CREATE UNIQUE INDEX idx_containers_host_port ON containers(host_id, ssh_port);

CREATE TABLE port_quarantine (
  host_id      TEXT NOT NULL,
  port         INTEGER NOT NULL,
  released_at  INTEGER NOT NULL,   -- reusable after 30 days
  PRIMARY KEY (host_id, port)
);

CREATE TABLE credentials_encrypted (
  user_id              TEXT PRIMARY KEY REFERENCES users(id),
  github_token         TEXT,      -- encrypted b64 (short-lived user-to-server token)
  github_refresh_token TEXT,      -- encrypted b64; NEVER sent to hosts (§10)
  github_expires_at    INTEGER,
  github_login         TEXT,      -- plaintext login name (not a secret)
  cloudflare_token     TEXT,      -- encrypted b64
  llm_keys             TEXT,      -- encrypted b64 JSON map
  rotated_at           INTEGER
);

CREATE TABLE enrollment_tokens (
  token_hash   TEXT PRIMARY KEY,  -- sha256 hex; the token itself is never stored
  user_id      TEXT NOT NULL REFERENCES users(id),
  expires_at   INTEGER NOT NULL,  -- 1 hour TTL
  used_at      INTEGER
);

CREATE TABLE oauth_states (
  state        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- NO payload column by design: credential-bearing payloads travel only in the
-- signed request body (sealed to the host key) and are never persisted (§8).
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  container_id TEXT NOT NULL,
  op           TEXT NOT NULL,
  status       TEXT NOT NULL,     -- queued|running|succeeded|failed
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_jobs_container ON jobs(container_id, created_at DESC);
CREATE INDEX idx_jobs_status ON jobs(status, updated_at);

CREATE TABLE waitlist (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  admitted_at  INTEGER
);

CREATE TABLE session_revocations (
  sid_hash    TEXT PRIMARY KEY,   -- sha256 hex of the session id
  revoked_at  INTEGER NOT NULL
);
