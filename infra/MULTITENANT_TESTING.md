# Multi-tenant staging and acceptance

This procedure is the release gate for testing more than one untrusted Incus
tenant on a host. It is intentionally destructive and belongs on staging
hardware with disposable accounts and data.

The current small development VPS is registered for one 1 vCPU/2 GiB tenant
slot. The new 70% disk safety policy can reject that undersized pool entirely;
do not weaken it just to preserve a slot. In either case, one host tenant cannot
prove east-west isolation or CPU oversubscription. Use a host with at least
16 GiB RAM and adequate mirrored storage for this test.

## What this baseline enforces

- D1 reserves vCPU, non-reserved RAM, both 5 GiB disk quotas, and an SSH port
  in one transaction.
- Placement requires an active host, a successful current health streak, and a
  daemon heartbeat no older than 15 minutes.
- Three consecutive failed health checks mark a host `unhealthy`; one failed
  check immediately makes it ineligible for new placement. A valid signed
  stats response restores it.
- The daemon operates only in a dedicated restricted Incus project with
  aggregate CPU, memory, process, disk, and instance ceilings.
- Each tenant receives an unprivileged isolated idmap, one CPU-worth of
  allowance, a hard 2 GiB memory limit without swap, 1024 processes, hard root
  and home quotas, anti-spoofing, east-west port isolation, and a 100 Mbit/s
  NIC ceiling.
- A deliberately stopped tenant remains stopped across a host or Incus restart.

This is shared-kernel isolation, not VM-grade hardware isolation. It also does
not add backups, replication, mTLS/private daemon ingress, or automated host
evacuation.

## Safe rollout to the current empty host

Do not move an existing instance between projects as part of this rollout. If
the host is not empty, keep it drained and follow a deliberate export/rebuild
plan instead.

1. Drain the host and confirm it has no active jobs or instances.

       cd apps/worker
       npx wrangler d1 execute workbench --remote --command \
         "UPDATE hosts SET status = 'draining' WHERE id = 'HOST_ID'"
       npx wrangler d1 execute workbench --remote --command \
         "SELECT j.id, j.op, j.status FROM jobs j
          JOIN containers c ON c.id = j.container_id
          WHERE c.host_id = 'HOST_ID' AND j.status IN ('queued','running')"
       ssh root@HOST 'incus list --all-projects'

2. Apply the expand-only D1 migration before deploying the new Worker.

       (cd apps/worker && npm run db:migrate:remote)

3. Copy the repository to the host, apply the tenant policy, and point the
   daemon at the new project.

       rsync -a --exclude node_modules --exclude .git ./ root@HOST:/opt/workbench/
       ssh root@HOST '
         cd /opt/workbench
         bash infra/configure-multitenant.sh
         umask 077
         jq ".project = \"workbench\"" /etc/workbench/daemon.json \
           > /etc/workbench/daemon.json.new
         chown root:root /etc/workbench/daemon.json.new
         chmod 0600 /etc/workbench/daemon.json.new
         mv /etc/workbench/daemon.json.new /etc/workbench/daemon.json
         npm ci --omit=dev --workspaces --include-workspace-root
         systemctl restart workbench-daemon
         bash infra/audit-multitenant.sh
       '

4. Deploy the Worker, then activate the host. The first Cron pass refreshes
   `last_seen_at` before admitting the waitlist.

       cd /path/to/cloudcontainer
       npm run deploy -- --yes
       cd apps/worker
       npx wrangler d1 execute workbench --remote --command \
         "UPDATE hosts SET status = 'active' WHERE id = 'HOST_ID'"

5. After one Cron interval, verify health and zeroed accounting.

       npx wrangler d1 execute workbench --remote --command \
         "SELECT id, status, vcpu_capacity, vcpu_allocated,
                 ram_total_mb - ram_reserve_mb AS ram_capacity_mb,
                 ram_allocated_mb, disk_total_gb, disk_allocated_gb,
                 last_seen_at, consecutive_failures
          FROM hosts WHERE id = 'HOST_ID'"

Keep the host drained if the audit or heartbeat does not pass.

## Capacity test

For the current 1 vCPU/2 GiB/5 GiB tier, usable slots are:

    min(
      vcpu_capacity,
      floor((ram_total_mb - ram_reserve_mb) / 2048),
      floor(disk_total_gb / 10)
    )

Create `slots + 1` disposable accounts. Provision the first `slots` accounts
concurrently, then the extra account. Confirm:

- exactly `slots` containers are placed and the extra account is waitlisted;
- `vcpu_allocated = slots`;
- `ram_allocated_mb = slots * 2048`;
- `disk_allocated_gb = slots * 10`;
- every placed container has a unique SSH port; and
- repeating concurrent requests does not change those totals.

Destroy one environment and confirm the quarantined SSH port, all three
resource counters decrement once, and the FIFO account is admitted on the next
Cron pass.

## Isolation tests

Run the host audit before and after the test:

    sudo PROJECT_NAME=workbench bash infra/audit-multitenant.sh

With at least two running tenants, obtain the second tenant's private IPv4 and
verify the first cannot reach it directly:

    PROJECT=workbench
    A=FIRST_INCUS_NAME
    B=SECOND_INCUS_NAME
    B_IP=$(incus --project "$PROJECT" query "/1.0/instances/$B/state" |
      jq -r '.metadata.network.eth0.addresses[] | select(.family == "inet").address' |
      head -1)
    if incus --project "$PROJECT" exec "$A" -- ping -c 1 -W 2 "$B_IP"; then
      echo "east-west isolation failed" >&2
      exit 1
    fi

Then verify each tenant can resolve DNS and reach an allowed HTTPS endpoint,
but cannot open outbound TCP/25. Do not weaken the bridge policy to make a
test pass.

For disk enforcement, fill disposable files on both `/home/dev` and `/` past
their advertised 5 GiB caps. The write must fail inside that tenant without
pool exhaustion or errors in another tenant. Remove the files afterward.

Create a file owned by `dev` in `/home/dev`, run an application rebuild, and
confirm the file survives and is still owned and writable by `dev`. This checks
Incus's custom-volume idmap transition when an isolated rootfs is replaced.

For memory enforcement, run a disposable `stress-ng` workload that requests
more than 2 GiB. It may be killed inside the tenant; the host and neighboring
SSH sessions must remain responsive, with no host OOM event. Run CPU stress in
all tenants together and confirm each remains bounded to its configured CPU
allowance.

## Reboot and failed-daemon tests

1. Stop one tenant through the application and leave another running.
2. Reboot the host.
3. Confirm the running tenant returns and the stopped tenant stays stopped.
4. Confirm D1 converges to the same states without changing the stopped tenant
   to running.
5. Stop `workbench-daemon` for one Cron interval. A new signup must waitlist
   after the first failed heartbeat.
6. After three failed intervals, confirm the host is `unhealthy`.
7. Start the daemon. After a valid stats response, confirm the host returns to
   `active`, failure count resets, and FIFO admission resumes.

## Soak test and stop conditions

Run all available slots for at least 30 minutes with concurrent CPU, filesystem,
Git clone, package-install, and SSH activity. Capture `vmstat`, `zpool iostat`,
`incus top`, daemon logs, D1 job latency, and dashboard latency.

Stop admission immediately for any host OOM, ZFS I/O error, cross-tenant packet,
quota bypass, duplicate port, negative/over-limit D1 counter, daemon identity
mismatch, or tenant state changing across reboot contrary to the control plane.

## Practical staging hardware

| Purpose | CPU | RAM | Storage | Approximate 2 GiB slots |
|---|---:|---:|---:|---:|
| Minimum isolation test | 4 physical cores | 16 GiB | 2 × 250 GB NVMe mirror | 4 |
| Small pilot | 8 physical cores | 64 GiB ECC | 2 × 1 TB enterprise NVMe mirror | 19 |
| Denser pilot | 16 physical cores | 128 GiB ECC | 2 × 1.92 TB enterprise NVMe mirror | 38 |

These estimates use the bootstrap's conservative 60% physical-RAM allocation,
3:1 vCPU-to-physical-core ceiling, 70% pool registration, and 10 GiB reserved
disk per tenant. RAM is not oversubscribed; CPU is. Prefer high sustained
single-core performance, ECC RAM, mirrored power-loss-protected NVMe, separate
boot media, redundant networking/power, and out-of-band management.

Before a public beta, add and rehearse encrypted ZFS backups/restores, daemon
ingress restriction or mTLS, alerting on host and per-tenant Incus metrics,
kernel/image patch cadence, and an abuse-response process.
