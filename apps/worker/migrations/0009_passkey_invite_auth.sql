-- Authentication is modeled independently from the user profile. World ID is
-- one external identity provider; invited accounts deliberately have no
-- external identity and therefore require at least one passkey.
--
-- Rebuild the user-referencing tables so the obsolete mandatory World ID
-- columns can be removed without leaving misleading placeholder identities.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE users_auth_new (
  id                    TEXT PRIMARY KEY,
  webauthn_user_id      TEXT UNIQUE NOT NULL, -- random 32-byte hex user handle
  signup_method         TEXT NOT NULL CHECK (signup_method IN ('world_id', 'invite', 'dev')),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'deleted')),
  subscription_status   TEXT NOT NULL DEFAULT 'free',
  created_at            INTEGER NOT NULL,
  last_authenticated_at INTEGER
);

-- Existing accounts were all World ID accounts. randomblob() gives each one a
-- stable, non-identifying WebAuthn user handle for future passkey attachment.
INSERT INTO users_auth_new (
  id, webauthn_user_id, signup_method, status, subscription_status, created_at
)
SELECT
  id, lower(hex(randomblob(32))), 'world_id', status, subscription_status, created_at
FROM users;

CREATE TABLE ssh_keys_auth_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users_auth_new(id),
  label       TEXT NOT NULL DEFAULT '',
  pubkey      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
INSERT INTO ssh_keys_auth_new SELECT id, user_id, label, pubkey, created_at FROM ssh_keys;

CREATE TABLE containers_auth_new (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL UNIQUE REFERENCES users_auth_new(id),
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
INSERT INTO containers_auth_new (
  id, user_id, host_id, ssh_port, agents, tier, cpu, ram_mb, disk_gb,
  status, status_detail, host_key_fingerprints, suspended_at, created_at,
  last_upgraded_at, github_repos
)
SELECT
  id, user_id, host_id, ssh_port, agents, tier, cpu, ram_mb, disk_gb,
  status, status_detail, host_key_fingerprints, suspended_at, created_at,
  last_upgraded_at, github_repos
FROM containers;

CREATE TABLE credentials_encrypted_auth_new (
  user_id              TEXT PRIMARY KEY REFERENCES users_auth_new(id),
  github_token         TEXT,
  github_refresh_token TEXT,
  github_expires_at    INTEGER,
  github_login         TEXT,
  cloudflare_token     TEXT,
  llm_keys             TEXT,
  rotated_at           INTEGER,
  wrangler_oauth       TEXT
);
INSERT INTO credentials_encrypted_auth_new (
  user_id, github_token, github_refresh_token, github_expires_at, github_login,
  cloudflare_token, llm_keys, rotated_at, wrangler_oauth
)
SELECT
  user_id, github_token, github_refresh_token, github_expires_at, github_login,
  cloudflare_token, llm_keys, rotated_at, wrangler_oauth
FROM credentials_encrypted;

CREATE TABLE enrollment_tokens_auth_new (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users_auth_new(id),
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
INSERT INTO enrollment_tokens_auth_new SELECT token_hash, user_id, expires_at, used_at
FROM enrollment_tokens;

CREATE TABLE waitlist_auth_new (
  user_id      TEXT PRIMARY KEY REFERENCES users_auth_new(id),
  requested_at INTEGER NOT NULL,
  admitted_at  INTEGER
);
INSERT INTO waitlist_auth_new SELECT user_id, requested_at, admitted_at FROM waitlist;

CREATE TABLE auth_identities (
  provider              TEXT NOT NULL CHECK (provider IN ('world_id', 'dev')),
  provider_subject      TEXT NOT NULL,
  user_id               TEXT NOT NULL UNIQUE REFERENCES users_auth_new(id) ON DELETE CASCADE,
  protocol_version      TEXT,
  created_at            INTEGER NOT NULL,
  last_authenticated_at INTEGER,
  PRIMARY KEY (provider, provider_subject)
);
INSERT INTO auth_identities (
  provider, provider_subject, user_id, protocol_version, created_at
)
SELECT 'world_id', world_id_session_id, id, NULL, created_at FROM users;

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY, -- base64url credential ID
  user_id       TEXT NOT NULL REFERENCES users_auth_new(id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT NOT NULL DEFAULT '[]',
  device_type   TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up     INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  name          TEXT NOT NULL DEFAULT 'Passkey',
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id, created_at);

-- The raw eight-character invite is returned once and never persisted.
CREATE TABLE invite_codes (
  code_hash  TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  created_at INTEGER NOT NULL
);

-- A separate redemption row makes one-time use enforceable with a UNIQUE key.
-- It is inserted in the same D1 batch as the user and initial passkey.
CREATE TABLE invite_redemptions (
  code_hash   TEXT PRIMARY KEY REFERENCES invite_codes(code_hash),
  -- Keep the redemption after account deletion so an invite can never be used
  -- twice. The former user link is cleared as part of deletion.
  user_id     TEXT UNIQUE REFERENCES users_auth_new(id) ON DELETE SET NULL,
  redeemed_at INTEGER NOT NULL
);

DROP TABLE ssh_keys;
DROP TABLE containers;
DROP TABLE credentials_encrypted;
DROP TABLE enrollment_tokens;
DROP TABLE waitlist;
DROP TABLE users;

ALTER TABLE users_auth_new RENAME TO users;
ALTER TABLE ssh_keys_auth_new RENAME TO ssh_keys;
ALTER TABLE containers_auth_new RENAME TO containers;
ALTER TABLE credentials_encrypted_auth_new RENAME TO credentials_encrypted;
ALTER TABLE enrollment_tokens_auth_new RENAME TO enrollment_tokens;
ALTER TABLE waitlist_auth_new RENAME TO waitlist;

CREATE INDEX idx_ssh_keys_user ON ssh_keys(user_id);
CREATE UNIQUE INDEX idx_ssh_keys_user_pubkey ON ssh_keys(user_id, pubkey);
CREATE UNIQUE INDEX idx_containers_host_port ON containers(host_id, ssh_port);

-- Store only a hash of the browser's ceremony cookie. DELETE ... RETURNING
-- atomically consumes a challenge before verification, preventing replay even
-- though application sessions continue to use eventually consistent KV.
CREATE TABLE auth_challenges (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  kind       TEXT NOT NULL CHECK (kind IN ('authentication', 'registration', 'invite')),
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at);

PRAGMA defer_foreign_keys = OFF;
