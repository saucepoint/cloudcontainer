-- A completed workbench configuration is durable product state, distinct from
-- the short-lived wizard checkpoint in setup_drafts. Existing containers are
-- backfilled so their immutable launch configuration remains visible.
CREATE TABLE workbench_configurations (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  agents        TEXT NOT NULL,
  github_repos  TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT INTO workbench_configurations (user_id, agents, github_repos, created_at, updated_at)
SELECT user_id, agents, github_repos, created_at, created_at
FROM containers;
