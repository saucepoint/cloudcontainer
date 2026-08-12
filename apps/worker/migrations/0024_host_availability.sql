-- Keep one canonical projection of the capacity currently available for new
-- tenant placement. Allocation counters are the transactional reservation
-- ledger; availability is allowed to become negative when an in-place plan
-- change takes a host beyond its oversubscription target.
UPDATE hosts
SET vcpu_capacity = reported_cpu_logical * 4
WHERE reported_cpu_logical IS NOT NULL
  AND status <> 'dead'
  AND vcpu_capacity <> reported_cpu_logical * 4;

CREATE VIEW host_availability AS
SELECT h.*,
       h.vcpu_capacity - h.vcpu_allocated AS vcpu_available,
       CAST(
         ((h.ram_total_mb - h.ram_reserve_mb) * 5) / 4
         AS INTEGER
       ) AS ram_capacity_mb,
       CAST(
         ((h.ram_total_mb - h.ram_reserve_mb) * 5) / 4
         AS INTEGER
       ) - h.ram_allocated_mb AS ram_available_mb,
       h.disk_total_gb - h.disk_allocated_gb AS disk_available_gb,
       h.max_tenants - (
         SELECT COUNT(*) FROM containers c WHERE c.host_id = h.id
       ) AS tenant_slots_available
FROM hosts h;
