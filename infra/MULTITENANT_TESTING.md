# Multi-host and multi-tenant staging acceptance

This is the destructive release gate for heterogeneous shared and dedicated
Incus hosts. `budget` and `regular` are retained as rollout labels for shared
hardware. Use disposable staging accounts and data. Complete it for every
hardware shape and tenancy mode before that combination accepts users.

The executable policy is `infra/host-policy.sh`; this document tests that the
daemon, host, D1 scheduler, and fleet controller enforce the same policy. Do
not edit expected values here without changing the contract, policy, migration,
tests, and `SPEC.md` together.

## Test matrix

| Tenancy | Test accounts | Required placement | Advertised / enforced CPU and other limits |
|---|---|---|---|
| shared | at least two Free, two Paid, and one overflow | Free and Paid concurrently on one capable host | Free: 1 / 1 vCPU, 1536 MiB RAM, 1024 MiB swap, 5 GiB home/root; Paid: 2 / 3 vCPU, 4096 MiB RAM, no swap, 8 GiB home/root |
| dedicated | two dedicated-entitled accounts and one shared paid account | only the assigned account; exactly one tenant | Paid limits |

Also include an account-bound dedicated host during shared capacity tests. That
proves shared FIFO work does not block an independent dedicated pool.

Minimum useful hardware is whatever yields at least one Free plus one Paid
reservation after reserves. If a host cannot fit that pair, it can pass
single-host provisioning but cannot supply multi-tenant isolation evidence.
Use a larger staging host; do not weaken policy to manufacture a slot.

## Preconditions

From a clean operator checkout:

    read -rs FLEET_ADMIN_SECRET && export FLEET_ADMIN_SECRET
    echo
    npm run hostctl -- list
    npm run hostctl -- probe HOST_ID
    npm run hostctl -- audit HOST_ID

Record the output, Git commit, host hardware, ZFS layout, Incus version, daemon
release, class, registered resource counters, and calculated tenant ceiling.
The host must be active only after its signed probe and audit pass.

Confirm test accounts have the intended effective entitlement. A browser must
not be able to assert a Price, plan, tier, or placement mode. Paid must come
from a canonical sandbox subscription or explicit manual entitlement;
dedicated remains operator-managed.

## Capacity calculation and admission

For the host under test, independently compute:

    ram_reserve_mb = max(3072, ceil(ram_total_mb * 8 / 100), configured_higher_reserve)
    vcpu_capacity = online_host_vcpus * vcpu_overcommit  # integer 1..4; default 4
    cpu_slots = ceil(vcpu_capacity / provisioned_tenant_cpu)  # 1 free, 3 paid
    ram_slots = ceil((ram_total_mb - ram_reserve_mb) * 1.25 / tenant_ram_mb)
    disk_slots = floor(safe_disk_gb / (2 * tenant_disk_gb))
    swap_slots = floor(host_swap_mb / 1024)  # every shared slot can be Free
    idmap_slots = floor(min(root_subuid_count, root_subgid_count) / 65536) - 1  # explicit ranges only

    expected_slots = min(cpu_slots, ram_slots, disk_slots[, swap_slots, idmap_slots])
    expected_slots = min(expected_slots, registered_max_tenants)

For dedicated, `expected_slots` must equal one. Isolated subordinate UID/GID
ranges must cover all registered slots plus the trusted image-build map.

`npm run hostctl -- audit HOST_ID` must also prove that the locally calculated
slot, CPU, allocatable-RAM, and safe-disk values are each at least the values
advertised by that host's D1 row, and that the configured daemon base image is
available. A capacity shortfall is a release blocker even if existing tenants
still run.

Exercise `npm run hostctl -- capacity HOST_ID` on one disposable host. Confirm
it drains before policy changes, rejects a ceiling below current allocations,
clears stale health telemetry, audits and probes the new registration, and
reactivates only when that host began active.

Register at least two shared hardware shapes and confirm the scheduler scores
each host's post-placement normalized CPU, RAM, and disk headroom plus
`max_tenants`, with deterministic host-ID tie-breaking. Exercise fragmentation:
create a state where Paid fits only one host but Free fits both, and verify the
least-waste choice does not create a single-resource hotspot.

Create a mixed sequence whose summed reservations reaches one resource budget,
then submit one additional request concurrently. Confirm:

- exactly the requests that fit are assigned and the extra account is
  waitlisted;
- every assigned host tenancy mode matches persisted placement mode and the
  daemon reports `mixed-tier-shared-v1`;
- `vcpu_allocated = free_count + 3 * paid_count`;
- `ram_allocated_mb = 1536 * free_count + 4096 * paid_count`;
- `disk_allocated_gb = 10 * free_count + 16 * paid_count`, except for explicit
  grandfathered Free storage, which remains 16;
- tenant count never exceeds `max_tenants`;
- every assigned container has a unique SSH port on that host; and
- repeated and concurrent provision requests do not change those totals.

Destroy one disposable environment. Confirm all three counters decrement once,
the SSH port enters quarantine, and the shared FIFO is reconsidered on the next
reconciler pass.

## Tenancy isolation and bounded FIFO backfill

Exercise all negative routes:

- Free and Paid both land on a capable shared host regardless of its legacy
  `budget`/`regular` label;
- a legacy shared daemon without the capability accepts only its exact old
  class during the rolling interval;
- shared accounts never land on dedicated hosts;
- dedicated-entitled account A cannot land on a host assigned to account B;
- a dedicated host cannot activate without an eligible assignment;
- changing a dedicated assignment fails unless the host is draining and has
  no tenant or active job; and
- an unknown subscription status fails provisioning instead of falling back to
  a cheaper class.

Make the oldest shared request too large for current fragmented capacity while
a later smaller request fits. Confirm the scheduler scans no more than eight
later rows, admits at most one backfill per pass, preserves the oldest timestamp,
and increments its skip count. After three successful bypasses, the oldest row
must not be bypassed again. A request beyond the scan window must not jump the
queue merely because its plan differs. Repeat with two independently assigned
dedicated accounts to prove their account-bound progress remains independent.

## Host policy and tenant isolation

Run the audit before and after stress:

    ssh root@MANAGEMENT_HOST \
      'cd /opt/workbench && bash infra/audit-multitenant.sh'

With two tenants on the same shared host, obtain the second tenant's private
IPv4 and prove the first cannot reach it:

    PROJECT=workbench
    A=FIRST_INCUS_NAME
    B=SECOND_INCUS_NAME
    PROJECT_QUERY=$(jq -rn --arg project "$PROJECT" '$project | @uri')
    B_IP=$(incus query "/1.0/instances/$B/state?project=$PROJECT_QUERY" |
      jq -r '(.metadata.network // .network).eth0.addresses[] | select(.family == "inet").address' |
      head -1)
    if incus --project "$PROJECT" exec "$A" -- ping -c 1 -W 2 "$B_IP"; then
      echo "east-west isolation failed" >&2
      exit 1
    fi

Confirm each tenant can resolve DNS and reach an allowed HTTPS endpoint, but
cannot open outbound TCP/25. Check anti-spoofing, the 100 Mbit/s NIC ceiling,
the 1024-process limit, `security.idmap.isolated=true`, nesting disabled, and
an SSH proxy bound to the assigned port.

For disk enforcement, fill disposable data on both `/home/dev` and `/` beyond
each container's actual tier quota. Each write must fail locally without
exhausting the pool or affecting another tenant. Remove the files afterward.

Create a file owned by `dev` in `/home/dev`, run an application rebuild, and
confirm the file remains owned and writable by `dev`. This exercises the custom
volume's isolated-idmap transition while the root filesystem is replaced.

For memory enforcement, exceed each tier's RAM limit. A Free tenant may use at
most 1024 MiB configured swap; Paid and dedicated tenants must report no
configured swap even when they share the same host. The workload may be killed
inside the tenant, but the host and neighboring SSH sessions must stay
responsive with no host OOM event.

Run CPU stress in every tenant simultaneously. Each must remain bounded to its
exact enforced allowance (1 free, 3 paid/dedicated), while the UI advertises
1/2 vCPU and the host has an explicit aggregate vCPU overcommit ceiling.

## Health, drain, and controller release tests

1. Stop one tenant through the application and leave another running.
2. Drain the host with `hostctl state`; a new shared account must wait while
   existing tenants keep running.
3. Reboot the host. The running tenant must return and the stopped tenant must
   remain stopped.
4. Probe and reactivate through `hostctl`; D1 must converge without changing
   the deliberately stopped state.
5. Stop `workbench-daemon`. After one failed heartbeat, new placement must
   pause. After three failures, an active host must be `unhealthy`.
6. Start the daemon. A valid signed stats response must clear failures and
   recover an unhealthy host; a draining host must stay draining.
7. Make the daemon report a wrong host ID, class, or tenancy mode. The signed
   fleet probe must fail and activation must be rejected. Repeat with class,
   tenancy mode, capability, release, or CPU hardware telemetry omitted:
   rolling reconciliation may read it, but the administrator probe must reject
   it and clear stale activation evidence.

Exercise the release controller from a new clean commit:

    npm run hostctl -- deploy --host HOST_ID --dry-run
    npm run hostctl -- deploy --host HOST_ID

Verify the order is drain, zero-job check, backup, copy, locked install, policy
reconciliation, restart, audit, signed probe, exact Git-release comparison,
then activation. Introduce a controlled audit or version mismatch and confirm
the host remains draining. Restore from the pre-release archive using
`RUNBOOK.md`, probe the old version, and activate it.

Race a lifecycle request against the transition to draining. Either the job
commits first and appears in the active-job gate, or its atomic insert is
rejected as maintenance; it must never dispatch invisibly after a zero-job
observation. Confirm key/credential edits during draining persist but create no
daemon job.

## Endpoint and dedicated-assignment tests

While the host is active, direct API endpoint changes must fail. Use:

    npm run hostctl -- configure HOST_ID \
      --daemon-endpoint https://replacement-daemon.example.com:8443

The controller must drain first, reset old health evidence, and reactivate only
after a signed probe reaches the new trusted endpoint. An invalid certificate,
wrong host identity, wrong class, or unreachable URL must leave it draining.

For a dedicated host, assign account A, activate, and provision A. Attempts by
account B or a shared paid account must remain unplaced even when the host has
free CPU/RAM/disk counters. After A destroys its environment, drain the host,
assign B, probe, activate, and confirm only B can use it.

## Plan transition, re-home, retirement, and identity lifecycle tests

On disposable data, grant Paid to a running Free owner. Confirm only the
positive 2-vCPU, 2560-MiB RAM, and 6-GiB doubled-disk delta is claimed before a
resize job, the actual container row remains Free until daemon success, and the
same host/container identity returns to running with Paid limits. Repeat from
stopped and confirm it returns to stopped. Deliver the grant twice and confirm
one transition/job. Force a resize failure, then confirm retry does not claim
the delta twice.

Fill the current host so the delta cannot fit. The upgrade must remain
`waiting_capacity`; the Free container, SSH, and home data remain usable, and
no destructive re-home job exists. Release capacity and confirm reconciliation
converges. Then expire Paid on a permanently Free-eligible owner: the container
must downgrade in place, release CPU/RAM, retain 8-GiB home/root quotas, and set
the grandfathered-storage marker.

Separately exercise the explicit destructive administrative re-home path on
disposable data:

    npm run hostctl -- rehome CONTAINER_ID --yes

The old daemon must report successful destroy before D1 releases its actual
CPU/RAM/disk reservation. The row must then be hostless and waitlisted on the
requested tenancy. An unsupported subscription value must reject re-home
without mutation. A manually corrupted tenancy/class mismatch must fail a
spec-bearing job with the actionable re-home error before daemon dispatch,
while destroy remains usable.

Exercise `hostctl reclass` on an empty disposable host. Confirm a class/tenancy
change without a fresh capacity report is rejected, the daemon reports both new
values and capability, old health evidence is cleared, and the host cannot
activate until audit and probe succeed.

Finally simulate an irrecoverable dedicated host with an active job and one
tenant. Drain and isolate the machine, then force-retire it. Confirm atomically:

- active jobs fail with the host-retirement reason;
- the port is quarantined and every eligible desired row becomes hostless and
  waitlisted on its current subscription plan;
- all old allocation counters and `dedicated_user_id` clear;
- another dedicated host can immediately take the account assignment; and
- `hostctl history` contains the retired generation.

Replace the dead ID through onboarding with `--replace-dead`; it must return as
draining with generation incremented and no stale telemetry. Retire it empty,
run `hostctl remove`, and confirm current inventory disappears while history
remains. None of these paths may require ad hoc D1 SQL.

## Soak and stop conditions

Run every available slot for at least 30 minutes with concurrent CPU,
filesystem, Git clone, package install, and SSH activity. Capture `vmstat`,
`zpool iostat`, `incus top`, daemon logs, D1 job latency, and dashboard latency.

Stop admission immediately for any:

- host OOM, ZFS I/O error, or unexpected swap exhaustion;
- cross-tenant packet, quota bypass, idmap overlap, or host-device access;
- duplicate SSH port or counter below zero/above a registered limit;
- tenant count beyond `max_tenants`;
- placement in the wrong tenancy mode or dedicated assignment;
- daemon identity/class/tenancy/capability/release mismatch accepted by the Worker; or
- tenant lifecycle state changing across reboot contrary to the control plane.

This remains shared-kernel isolation, not hardware-isolated virtualization.
Before public production use, separately rehearse encrypted ZFS key recovery,
backups and restores, alerting, certificate maintenance, abuse response, and
host-loss communication. The current release does not provide backups,
automatic evacuation, replication, live migration, or failover.
