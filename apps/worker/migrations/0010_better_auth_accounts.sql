-- Replace the bespoke passkey/KV session implementation with Better Auth.
-- Workbench data is preserved, but legacy authentication state is intentionally
-- not migrated: users must authenticate and complete eligibility verification
-- through the new account flow.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE users_better_auth_new (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  email_verified      INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  image               TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'deleted')),
  subscription_status TEXT NOT NULL DEFAULT 'free',
  verified_at         INTEGER,
  verification_method TEXT CHECK (verification_method IN ('world_id', 'invite', 'development')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

INSERT INTO users_better_auth_new (
  id, name, email, email_verified, status, subscription_status, created_at, updated_at
)
SELECT
  id,
  'Existing account',
  'legacy-' || lower(hex(randomblob(16))) || '@accounts.usebench.invalid',
  0,
  status,
  subscription_status,
  created_at,
  created_at
FROM users;

CREATE TABLE ssh_keys_better_auth_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users_better_auth_new(id),
  label      TEXT NOT NULL DEFAULT '',
  pubkey     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO ssh_keys_better_auth_new SELECT id, user_id, label, pubkey, created_at FROM ssh_keys;

CREATE TABLE containers_better_auth_new (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL UNIQUE REFERENCES users_better_auth_new(id),
  host_id               TEXT REFERENCES hosts(id),
  ssh_port              INTEGER,
  agents                TEXT NOT NULL,
  tier                  TEXT NOT NULL DEFAULT 'free',
  cpu                   INTEGER NOT NULL,
  ram_mb                INTEGER NOT NULL,
  disk_gb               INTEGER NOT NULL,
  status                TEXT NOT NULL,
  status_detail         TEXT,
  host_key_fingerprints TEXT,
  suspended_at          INTEGER,
  created_at            INTEGER NOT NULL,
  last_upgraded_at      INTEGER,
  github_repos          TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO containers_better_auth_new SELECT * FROM containers;

CREATE TABLE credentials_encrypted_better_auth_new (
  user_id              TEXT PRIMARY KEY REFERENCES users_better_auth_new(id),
  github_token         TEXT,
  github_refresh_token TEXT,
  github_expires_at    INTEGER,
  github_login         TEXT,
  cloudflare_token     TEXT,
  llm_keys             TEXT,
  rotated_at           INTEGER,
  wrangler_oauth       TEXT
);
INSERT INTO credentials_encrypted_better_auth_new SELECT * FROM credentials_encrypted;

CREATE TABLE enrollment_tokens_better_auth_new (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users_better_auth_new(id),
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
INSERT INTO enrollment_tokens_better_auth_new SELECT * FROM enrollment_tokens;

CREATE TABLE waitlist_better_auth_new (
  user_id      TEXT PRIMARY KEY REFERENCES users_better_auth_new(id),
  requested_at INTEGER NOT NULL,
  admitted_at  INTEGER
);
INSERT INTO waitlist_better_auth_new SELECT * FROM waitlist;

CREATE TABLE invite_redemptions_better_auth_new (
  code_hash   TEXT PRIMARY KEY REFERENCES invite_codes(code_hash),
  user_id     TEXT UNIQUE REFERENCES users_better_auth_new(id) ON DELETE SET NULL,
  redeemed_at INTEGER NOT NULL
);
INSERT INTO invite_redemptions_better_auth_new SELECT * FROM invite_redemptions;

DROP TABLE auth_challenges;
DROP TABLE passkeys;
DROP TABLE session_revocations;
DROP TABLE ssh_keys;
DROP TABLE containers;
DROP TABLE credentials_encrypted;
DROP TABLE enrollment_tokens;
DROP TABLE waitlist;
DROP TABLE invite_redemptions;
DROP TABLE users;

ALTER TABLE users_better_auth_new RENAME TO users;
ALTER TABLE ssh_keys_better_auth_new RENAME TO ssh_keys;
ALTER TABLE containers_better_auth_new RENAME TO containers;
ALTER TABLE credentials_encrypted_better_auth_new RENAME TO credentials_encrypted;
ALTER TABLE enrollment_tokens_better_auth_new RENAME TO enrollment_tokens;
ALTER TABLE waitlist_better_auth_new RENAME TO waitlist;
ALTER TABLE invite_redemptions_better_auth_new RENAME TO invite_redemptions;

CREATE INDEX idx_ssh_keys_user ON ssh_keys(user_id);
CREATE UNIQUE INDEX idx_ssh_keys_user_pubkey ON ssh_keys(user_id, pubkey);
CREATE UNIQUE INDEX idx_containers_host_port ON containers(host_id, ssh_port);

CREATE TABLE auth_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE auth_accounts (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id               TEXT NOT NULL,
  provider_id              TEXT NOT NULL,
  access_token             TEXT,
  refresh_token            TEXT,
  access_token_expires_at  INTEGER,
  refresh_token_expires_at INTEGER,
  scope                    TEXT,
  id_token                 TEXT,
  password                 TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX idx_auth_accounts_user ON auth_accounts(user_id);
CREATE UNIQUE INDEX idx_auth_accounts_provider ON auth_accounts(provider_id, account_id);

CREATE TABLE auth_verifications (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_verifications_identifier ON auth_verifications(identifier);

CREATE TABLE passkey (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  public_key    TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  counter       INTEGER NOT NULL,
  device_type   TEXT NOT NULL,
  backed_up     INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  transports    TEXT,
  created_at    INTEGER,
  aaguid        TEXT
);
CREATE INDEX idx_passkey_user ON passkey(user_id);

CREATE TABLE world_id_nullifiers (
  action            TEXT NOT NULL,
  nullifier_decimal TEXT NOT NULL,
  user_id           TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  verified_at       INTEGER NOT NULL,
  PRIMARY KEY (action, nullifier_decimal)
);

PRAGMA defer_foreign_keys = OFF;
