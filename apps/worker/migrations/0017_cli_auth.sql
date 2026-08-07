-- Short-lived browser-to-terminal authentication handoff. The CLI callback
-- must be loopback-only; the code is hashed and consumed exactly once.
CREATE TABLE cli_auth_attempts (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  callback_uri TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_cli_auth_attempts_expiry ON cli_auth_attempts(expires_at);

CREATE TABLE cli_auth_codes (
  code_hash  TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  attempt_id TEXT NOT NULL REFERENCES cli_auth_attempts(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX idx_cli_auth_codes_expiry ON cli_auth_codes(expires_at);
