-- Align paid host accounting with the advertised and enforced two-vCPU tier.
-- Existing Incus instances are reconciled to the same limit during the next
-- drained daemon deployment.
UPDATE hosts
SET vcpu_allocated = COALESCE((
  SELECT SUM(CASE c.tier WHEN 'free' THEN 1 WHEN 'paid' THEN 2 ELSE 0 END)
  FROM containers c
  WHERE c.host_id = hosts.id
), 0);
