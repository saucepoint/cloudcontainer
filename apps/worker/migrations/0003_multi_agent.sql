-- Containers carry one or more coding agents: the single-value `agent` column
-- becomes `agents`, a JSON array (e.g. '["claude","codex"]').
ALTER TABLE containers RENAME COLUMN agent TO agents;
UPDATE containers SET agents = json_array(agents);
