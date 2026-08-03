-- Reduce free-tier enforcement and host accounting from the historical
-- two-vCPU reservation to the one-vCPU plan value. Existing Incus instances
-- are reconciled to the new limit during the next drained daemon deployment.
UPDATE hosts
SET vcpu_allocated = COALESCE((
  SELECT SUM(CASE c.tier WHEN 'free' THEN 1 WHEN 'paid' THEN 3 ELSE 0 END)
  FROM containers c
  WHERE c.host_id = hosts.id
), 0);
