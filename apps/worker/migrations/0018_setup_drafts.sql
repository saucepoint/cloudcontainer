-- Short-lived, non-secret onboarding state. Credential values remain in the
-- encrypted credential row or are entered again; this JSON contains only
-- selections and progress metadata.
CREATE TABLE setup_drafts (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  draft         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_setup_drafts_expiry ON setup_drafts(expires_at);
