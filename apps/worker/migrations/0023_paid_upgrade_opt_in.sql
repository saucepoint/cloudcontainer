-- Before Premium instance upgrades required an explicit owner action, billing
-- could leave Free containers waiting indefinitely for Paid capacity. Retire
-- only legacy intents that have not claimed resources or reached the daemon.
UPDATE containers
SET status = (
      SELECT t.prior_status
      FROM container_plan_transitions t
      WHERE t.container_id = containers.id
    ),
    status_detail = NULL
WHERE status = 'upgrade_pending'
  AND EXISTS (
    SELECT 1
    FROM container_plan_transitions t
    WHERE t.container_id = containers.id
      AND t.to_tier = 'paid'
      AND t.state IN ('requested', 'waiting_capacity')
      AND t.reserved_cpu = 0
      AND t.reserved_ram_mb = 0
      AND t.reserved_disk_gb = 0
  )
  AND NOT EXISTS (
    SELECT 1
    FROM jobs j
    WHERE j.container_id = containers.id
      AND j.status IN ('queued', 'running')
      AND j.op IN ('provision', 'rebuild', 'start', 'stop', 'destroy', 'resize')
  );

UPDATE container_plan_transitions
SET state = 'cancelled',
    updated_at = unixepoch() * 1000,
    last_error_code = NULL
WHERE to_tier = 'paid'
  AND state IN ('requested', 'waiting_capacity')
  AND reserved_cpu = 0
  AND reserved_ram_mb = 0
  AND reserved_disk_gb = 0
  AND EXISTS (
    SELECT 1
    FROM containers c
    WHERE c.id = container_plan_transitions.container_id
      AND c.status IN ('running', 'stopped')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM jobs j
    WHERE j.container_id = container_plan_transitions.container_id
      AND j.status IN ('queued', 'running')
      AND j.op IN ('provision', 'rebuild', 'start', 'stop', 'destroy', 'resize')
  );
