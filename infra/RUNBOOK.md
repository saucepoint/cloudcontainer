# Workbench fleet operations runbook

This runbook is the supported procedure for adding, releasing, auditing, and
removing Incus hosts. It applies to heterogeneous machines; no host count or
hardware size is assumed. The destructive isolation gate is
[MULTITENANT_TESTING.md](./MULTITENANT_TESTING.md).

## Sources of truth

Use these sources in this order:

1. `SPEC.md` defines product behavior and release acceptance.
2. `infra/host-policy.sh` defines the executable host-class resource policy.
3. `infra/hostctl.sh` is the only normal host-registration and fleet-mutation
   client.
4. `infra/configure-multitenant.sh` applies policy to a drained host, while
   `infra/report-host-capacity.sh` reports its conservative result and
   `infra/audit-multitenant.sh` checks it without making changes.
5. This runbook defines operator sequencing and recovery.

Do not insert, activate, drain, reassign, or retire hosts with ad hoc D1 SQL.
The fleet API validates transitions and the controller keeps failed hosts out
of placement. Account billing and entitlement administration is separate from
host registration.

## Host classes and capacity

An account is placed only on its exact class. There is no fallback from one
class to another.

| Host class | Account plan | Advertised CPU | Incus/host reservation | RAM | Swap | Home + root disk | Maximum tenants |
|---|---|---:|---:|---:|---:|---:|---:|
| `budget` | `free` | 1 vCPU | 1 vCPU | 1536 MiB | 1024 MiB | 5 + 5 GiB | calculated |
| `regular` | `paid` | 2 vCPU | 3 vCPU | 4096 MiB | disabled | 8 + 8 GiB | calculated |
| `dedicated` | `dedicated` paid account | 2 vCPU | 3 vCPU | 4096 MiB | disabled | 8 + 8 GiB | exactly 1 |

Bootstrap computes a conservative ceiling from the actual host:

    vcpu_capacity = detected_online_vcpus * VCPU_OVERCOMMIT
    ram_reserve = max(3072 MiB, ceil(8% of total system RAM), HOST_RAM_RESERVE_MB)
    safe_disk = floor(storage_pool_bytes * DISK_CAPACITY_PERCENT / 100)

    max_tenants = min(
      floor(vcpu_capacity / class_provisioned_vcpu),
      floor((total_system_ram - ram_reserve) / class_ram),
      floor(safe_disk / (class_home_disk + class_root_disk)),
      floor(host_swap / class_swap) when class_swap is nonzero,
      available isolated 65,536-ID maps after one image-build map
    )

The CPU multiplier defaults to its supported maximum of 4; operators may lower
it to any integer from 1 through 4. The default safe-disk fraction is 70%.
The script also caps capacity to the available isolated subordinate ID ranges.
Dedicated hosts clamp the result to one. A host with no complete slot fails
bootstrap; never override that failure merely to advertise capacity.

`max_tenants` is an additional hard ceiling. Every placement also rechecks
tenant count, vCPU, allocatable RAM, reserved disk, health, exact class, and a
dedicated account assignment in the same D1 reservation transaction.
Capacity belongs to the individual host row, not the class. For example,
budget hosts registered with 4 vCPU/8 GiB and 8 vCPU/16 GiB are supported in
the same pool and yield different ceilings. At the default 4x CPU policy, the
4-vCPU budget host has 16 reservation units (16 CPU slots) but only 5120 MiB
of allocatable RAM (three RAM slots), so RAM binds at three tenants. The
8-vCPU/16-GiB budget host has 32 reservation units (32 CPU slots) and 13312 MiB
of allocatable RAM (eight RAM slots), so RAM binds at eight. An independent
8-vCPU/16-GiB regular host has ten CPU slots but three RAM slots and therefore
binds at three. These examples assume disk, swap, and ID maps do not impose a
lower safety ceiling.

CPU can bind instead: a 4-vCPU/16-GiB budget host configured with
`--vcpu-overcommit 1` has two CPU slots but eight RAM slots. The registered
`max_tenants` is always the minimum, never a promise that every dimension will
be exhausted equally.

Higher RAM reserve, lower CPU overcommit, or lower disk fraction may be set with
the onboarding options `--ram-reserve-mb`, `--vcpu-overcommit`, and
`--disk-capacity-percent`. They are persisted as non-secret root-owned host
policy so later audits and deployments use the same values. The file accepts
only those three numeric keys and is not evaluated as shell code. Record every
override in the host inventory. Do not change class or reduce limits on an
active host.

Host class may change only through `hostctl reclass` while the host is drained,
empty, and has no active job. The command updates the daemon and Incus policy,
submits a fresh class-specific capacity report, audits, probes, and then
restores prior active state when eligible. Never rewrite the class in D1 around
existing tenants.

After an intentional CPU, RAM, storage, swap, ID-map, or persisted policy
change, reconcile and re-register the conservative values through the
controller:

    npm run hostctl -- capacity HOST_ID

The command drains first, refuses active jobs, reapplies policy, rejects a
ceiling below existing tenants or reservations, updates the capacity row,
audits, probes, and restores only a host that was active before. A failure
leaves the host draining.

## Host states

| State | Meaning |
|---|---|
| `draining` | No new placement or daemon jobs; existing tenants remain and already-started jobs can finish; probes and releases are allowed. |
| `active` | Eligible for exact-class placement after a recent signed probe reporting the exact class, daemon release, and hardware telemetry. |
| `unhealthy` | Automatically quarantined after repeated daemon failures; a valid reconciler probe recovers it. |
| `dead` | Retired generation; cannot reactivate, but its empty ID may be replaced as a new generation or deregistered. |

One failed heartbeat immediately makes an active host ineligible because
placement requires a zero failure count plus verified release and hardware
telemetry. Three consecutive failures change it to `unhealthy`. A manually
draining host remains draining after both successful and failed probes.
Retirement is accepted only from `draining`, which fences new jobs before the
API checks whether the host is empty. `--force` is not a state-only bypass: it
archives the generation, fails active jobs, quarantines ports, clears capacity
and dedicated assignment, reconciles eligible desired rows to current plans,
and waitlists them for destructive reprovisioning. Isolate or power off the old
machine first so an untracked duplicate cannot remain reachable. Host-local
home data is not copied.

## Operator prerequisites

On the controller workstation:

- Node.js 22, npm, Git, `curl`, `jq`, `rsync`, and OpenSSH;
- a clean committed checkout of the exact release to install;
- network and SSH access to each management endpoint;
- `FLEET_ADMIN_SECRET`, preferably entered at the prompt rather than retained
  in shell history; and
- the public half of the Worker Ed25519 RPC key for onboarding.

On every host:

- a fresh or deliberately drained Debian 12/13 machine;
- root SSH, or an administrative SSH account with non-interactive passwordless
  `sudo` for the controller's host commands and remote `rsync`;
- outbound package access and Incus kernel support;
- a quota-capable ZFS pool; production storage must use native encryption and
  a rehearsed key-unlock procedure;
- enough host swap for every budget slot; and
- DNS plus a publicly trusted daemon certificate usable by the Worker.

Loop-backed ZFS (`--zfs-loop-gb`) and the bootstrap self-signed certificate
are development-only. A Worker probe will reject the self-signed certificate.
Directory storage does not provide the required disk isolation and is not a
production option.

Generate service keys once:

    cd apps/worker
    npx tsx scripts/genkeys.ts

Store `WORKER_RPC_PRIVATE_KEY` only as a Worker secret. Hosts receive only its
public key. Each host generates a separate X25519 keypair; its private key
stays mode 0600 in `/etc/workbench/daemon.json`.

## Control-plane rollout

Before using the controller in an environment, deploy the expand-only fleet
migration and configure its independent administrator secret:

    cd apps/worker
    npx wrangler secret put FLEET_ADMIN_SECRET
    cd ../..
    npm run deploy

The root deploy gate applies migrations before Worker code and does not roll
back D1 automatically. Migration `0014_host_fleet.sql` keeps empty/free-only
legacy hosts budget and classifies an exclusively paid legacy host as regular.
It deliberately aborts if one legacy host mixes free and paid tenants, because
that machine must be drained and separated before one exact policy can apply.
It also changes every legacy host to `draining`: no legacy machine may receive
a new tenant until the class-specific Incus policy and class-reporting daemon
have both been audited. Review the migration preflight before admitting new
accounts.

Migration `0015_host_lifecycle.sql` adds host generations/history and pending
re-home targets, then repairs `vcpu_allocated` from the historical 2/3-vCPU tier
reservations while leaving each container's advertised 1/2-vCPU value intact.
It is expand-only; Worker rollback does not remove these fields.

Confirm the API and inventory without exposing the secret on a command line:

    read -rs FLEET_ADMIN_SECRET && export FLEET_ADMIN_SECRET
    echo
    npm run hostctl -- list

For a legacy row whose backfilled management address is not the real SSH
address, update it through the controller. The command drains first, verifies
the replacement management identity, and resets health after the endpoint
change. A legacy row without verified release telemetry remains draining; its
endpoint is strictly probed by the first fleet deployment:

    npm run hostctl -- configure LEGACY_HOST_ID \
      --management-host management.example.com \
      --management-user root \
      --yes

The first daemon fleet deployment applies the canonical class policy to each
drained host before auditing and restarting it:

    npm run hostctl -- deploy --all

Because the migration intentionally made those hosts draining, this first
deployment does not reactivate them automatically. For each host, review the
audit and placement evidence, then run `hostctl probe` followed by `hostctl
state HOST_ID active`. Existing tenants remain assigned while the host is
draining. If an approximate legacy capacity backfill does not match the
canonical host calculation, run `hostctl capacity HOST_ID` before activation.

## New host onboarding

### 1. Prepare storage and TLS

Create encrypted production storage before onboarding. The vdev layout and key
mechanism are site-specific; this abbreviated example is not a complete
storage design:

    zpool create \
      -O encryption=on \
      -O keyformat=passphrase \
      -O keylocation=prompt \
      tank /dev/DEVICE

Test key loading and a reboot before accepting user data. For a disposable
development machine, pass `--zfs-loop-gb 40` to onboarding instead.

Provision a trusted certificate on the host before onboarding. For example,
with port 80 free and DNS already pointing at the host:

    certbot certonly --standalone -d daemon-fsn-1.example.com

Keep certificate paths under a path without spaces so they can be passed
safely to the remote bootstrap.

### 2. Run the controller

From a clean repository root:

    export WORKER_RPC_PUBLIC_KEY='BASE64_PUBLIC_KEY_FROM_genkeys'
    read -rs FLEET_ADMIN_SECRET && export FLEET_ADMIN_SECRET
    echo
    npm run hostctl -- onboard \
      --id budget-fsn-1 \
      --type budget \
      --management-host management-fsn-1.example.com \
      --ssh-hostname ssh-fsn-1.example.com \
      --daemon-endpoint https://daemon-fsn-1.example.com:8443 \
      --tls-cert-path /etc/letsencrypt/live/daemon-fsn-1.example.com/fullchain.pem \
      --tls-key-path /etc/letsencrypt/live/daemon-fsn-1.example.com/privkey.pem \
      --activate

Use `--type regular` for shared paid capacity. A dedicated account must
already have the `dedicated` operator entitlement; then onboard with both:

    npm run hostctl -- onboard \
      --id dedicated-fsn-2 \
      --type dedicated \
      --dedicated-user USER_ID \
      --management-host management-fsn-2.example.com \
      --ssh-hostname ssh-fsn-2.example.com \
      --daemon-endpoint https://daemon-fsn-2.example.com:8443 \
      --tls-cert-path /etc/letsencrypt/live/daemon-fsn-2.example.com/fullchain.pem \
      --tls-key-path /etc/letsencrypt/live/daemon-fsn-2.example.com/privkey.pem \
      --activate

Onboarding performs all of the following:

1. verifies a clean checkout and a new host ID (or an evacuated dead ID with
   explicit `--replace-dead`), then runs typecheck, lint, and all tests;
2. copies source without Git metadata, dependencies, or local secrets;
3. installs locked production dependencies and host services;
4. applies the class policy and calculates this machine's capacity;
5. builds `workbench-base`, unless `--skip-image` is explicit;
6. runs the read-only host audit;
7. registers only public metadata as `draining`;
8. asks the Worker to perform a signed daemon stats probe; and
9. activates only when `--activate` was explicit and every prior step passed.

`--skip-checks` is available only when the same commit already has recorded
release-gate evidence; it does not skip bootstrap, audit, probe, or activation
checks.

A failure after registration leaves the host draining. Inspect and fix the
cause, then use `hostctl probe` and `hostctl state`; do not bypass the checks.
Legacy reduced stats remain readable by the rolling reconciler, but an
administrator probe rejects a daemon that omits class or release identity and
cannot use it to activate a host.
Bootstrap metadata is retained at `/etc/workbench/registration.json` for
inspection, but the normal controller submits it.

To install replacement hardware under an evacuated dead identity, repeat the
normal onboarding command with the same `--id` plus `--replace-dead`. The API
starts a new draining generation, resets allocation/health telemetry, preserves
the old port quarantine, and retains the retired generation for audit:

    npm run hostctl -- onboard --replace-dead --id HOST_ID --type HOST_TYPE ...
    npm run hostctl -- history HOST_ID

### 3. Record acceptance evidence

    npm run hostctl -- list
    npm run hostctl -- probe budget-fsn-1
    npm run hostctl -- audit budget-fsn-1

Run the class-specific gates in `MULTITENANT_TESTING.md`. Do not accept a host
whose signed hardware report is lower than its registered conservative RAM or
supported vCPU capacity, whose local CPU/RAM/disk/tenant ceiling falls below
the D1 registration, whose daemon reports another ID/class, whose base image is
missing, or whose Incus audit fails.

## Routine fleet operations

List current class, state, tenant/resource allocation, daemon release, and
active job count:

    npm run hostctl -- list

Probe or audit one host:

    npm run hostctl -- probe HOST_ID
    npm run hostctl -- audit HOST_ID

Reconcile capacity after a deliberate hardware or policy change:

    npm run hostctl -- capacity HOST_ID

Reclassify reusable hardware only after every tenant is destroyed or re-homed:

    npm run hostctl -- reclass HOST_ID regular --yes
    npm run hostctl -- reclass HOST_ID dedicated --dedicated-user USER_ID --yes

The host stays draining on any remote-policy, API, audit, or probe failure.

Drain or reactivate:

    npm run hostctl -- state HOST_ID draining
    npm run hostctl -- probe HOST_ID
    npm run hostctl -- state HOST_ID active

Activation requires a fresh successful probe. `draining` does not stop or move
existing tenants, but new lifecycle/key/credential daemon jobs pause so the
controller's zero-job release fence cannot race a user action. Desired key and
credential changes remain in D1 and are applied by the next start. There is no
automatic evacuation or live migration.

For an empty draining dedicated host, change its account assignment with:

    npm run hostctl -- assign HOST_ID USER_ID
    npm run hostctl -- assign HOST_ID none

The API accepts only an active account with the dedicated paid entitlement.
It rejects assignment changes while the host has a tenant or active job.

When an entitlement changes, the existing environment remains deliberately on
its persisted tier/class so ordinary lifecycle jobs do not diverge from the
daemon. Apply the new plan explicitly; this destroys the old Incus container
and its host-local home volume before returning the row to the matching FIFO:

    npm run hostctl -- rehome CONTAINER_ID --yes

Unsupported subscription values are rejected without changing the container.
When a dedicated account re-homes to a shared plan, its emptied source host is
drained and its unique assignment is cleared automatically.
For an unreachable source host, use the force-retirement procedure below
instead of orderly re-home.

When DNS, daemon TLS termination, tenant SSH DNS, or management SSH changes:

    npm run hostctl -- configure HOST_ID \
      --management-host new-management.example.com \
      --ssh-hostname new-ssh.example.com \
      --daemon-endpoint https://new-daemon.example.com:8443

The command drains, verifies the replacement management address still belongs
to the registered host ID/class, clears old endpoint telemetry, and probes. If
either endpoint cannot be verified, the host remains draining. Changing
certificate files on the host is a separate SSH/TLS operation; update the
endpoint only after the certificate is trusted and installed.

## Daemon fleet releases

The release identity is the clean checkout's Git commit. Preview selection and
sequencing without host changes:

    npm run hostctl -- deploy --all --dry-run
    npm run hostctl -- deploy --type budget --dry-run
    npm run hostctl -- deploy --host HOST_ID --dry-run

Then deploy sequentially:

    npm run hostctl -- deploy --all

For each non-dead selected host, the controller:

1. changes it to draining, which atomically fences new daemon-job inserts;
2. refuses to continue unless D1 reports zero queued/running host jobs;
3. verifies that the management endpoint's daemon config has the registered
   host ID and no conflicting host class;
4. writes a mode-0600 backup of the release and `/etc/workbench` under `/root`
   before copying;
5. copies the clean checkout without credentials or local configuration;
6. runs the locked production install and safely fills missing legacy fleet
   identity fields when no old-project tenant would be stranded;
7. reapplies the registered class policy;
8. installs and restarts the systemd service with the Git release identity;
9. audits the Incus policy, base image, exact host identity, and verifies the
   locally calculated capacity still covers every D1-advertised ceiling;
10. performs a signed Worker-to-daemon probe and checks the reported release;
11. reactivates only after every check succeeds and only if the host was
    `active` before the release.

Hosts are processed one at a time. A failed host remains draining, as does a
host that entered the release draining or unhealthy. The controller continues
with later hosts, then exits nonzero if any failed. Existing running containers
are not stopped by a daemon restart, but daemon jobs and replay nonces are in
memory, which is why the active-job gate is mandatory.

`--skip-checks` omits the local typecheck/lint/test gate and should be used only
when equivalent evidence is already recorded. It never skips drain, backup,
audit, probe, or release verification.

### Roll back one failed daemon release

Keep the host draining. Use the `backup_stamp` printed by the failed deployment
and the previous release shown by the pre-deployment `hostctl list` output:

    ssh root@MANAGEMENT_HOST '
      set -eu
      stamp=BACKUP_STAMP
      previous_release=PREVIOUS_GIT_RELEASE
      systemctl stop workbench-daemon
      mv /opt/workbench "/opt/workbench.failed-$(date -u +%Y%m%dT%H%M%SZ)"
      mv /etc/workbench "/etc/workbench.failed-$(date -u +%Y%m%dT%H%M%SZ)"
      tar -C / -xzf "/root/workbench-$stamp.tgz"
      cd /opt/workbench
      npm ci --omit=dev --workspaces --include-workspace-root
      install -m 0644 apps/daemon/systemd/workbench-daemon.service \
        /etc/systemd/system/workbench-daemon.service
      printf "WB_DAEMON_VERSION=%s\n" "$previous_release" \
        > /etc/workbench/release.env
      systemctl daemon-reload
      systemctl start workbench-daemon
      systemctl is-active --quiet workbench-daemon
      bash infra/audit-multitenant.sh
    '

Then verify through the control plane before activation:

    npm run hostctl -- audit HOST_ID
    npm run hostctl -- probe HOST_ID
    npm run hostctl -- state HOST_ID active

Preserve the failed tree, backup, and logs until the incident is understood.
Rollback cannot restore an in-flight daemon job lost during restart.

## Base-image releases

Rebuild `workbench-base` when `infra/build-image.sh`, Debian security state,
the toolchain, an agent, SSH hardening, or dev-user setup changes. A normal
daemon deployment does not rebuild the image or alter existing containers.

Drain the target, confirm zero active jobs in `hostctl list`, record the old
image fingerprint, build, and audit:

    npm run hostctl -- state HOST_ID draining
    ssh root@MANAGEMENT_HOST 'incus image info workbench-base | sed -n "1,12p"'
    ssh root@MANAGEMENT_HOST 'cd /opt/workbench && bash infra/build-image.sh'
    npm run hostctl -- audit HOST_ID
    npm run hostctl -- probe HOST_ID

Run a disposable provision-to-SSH test before activation. Existing containers
continue using their current root filesystems. If validation fails, repoint the
alias to the recorded full fingerprint:

    ssh root@MANAGEMENT_HOST '
      incus image alias delete workbench-base
      incus image alias create workbench-base PRIOR_FULL_FINGERPRINT
    '

## Coordinated schema, Worker, and daemon changes

Keep shared changes expand-first and compatible across a rolling interval:

1. add nullable/defaulted D1 fields and keep both Worker and daemon schemas
   tolerant of the old and new messages;
2. deploy the migration and compatible Worker, draining legacy capacity in the
   migration when its old host policy cannot safely serve the new behavior;
3. roll the compatible daemon fleet sequentially with `hostctl`;
4. validate a real job in every affected class and one reconciler interval;
5. enforce new requirements only after all active hosts report the intended
   release; and
6. remove old fields or behavior only in a later release.

Worker rollback does not reverse D1 migrations. Daemon rollback does not
reverse Worker code or capacity reservations.

## Reboot and certificate maintenance

Drain before a planned reboot, daemon restart, or certificate deploy hook and
confirm zero active jobs. Running Incus tenants use `boot.autostart=last-state`;
running tenants return after reboot and deliberately stopped tenants remain
stopped.

After the host returns:

    ssh root@MANAGEMENT_HOST '
      set -eu
      systemctl is-active workbench-daemon
      systemctl is-active nftables
      incus --project workbench list
      nft list table inet workbench
      zpool status
      zfs get encryption,keyformat,keylocation
    '
    npm run hostctl -- audit HOST_ID
    npm run hostctl -- probe HOST_ID
    npm run hostctl -- state HOST_ID active

For encrypted storage, complete the documented key-unlock procedure first.
Prefer TLS termination that can reload certificates without restarting the
daemon. If Certbot restarts it, coordinate the hook with the same drain and
active-job checks.

Useful diagnostics:

    systemctl status workbench-daemon --no-pager
    journalctl -u workbench-daemon -n 100 --no-pager
    incus --project workbench list
    incus storage info default
    zpool status

Unsigned public requests should be rejected with 401 and may appear as
`rpc_rejected`. Logs must never contain credential values or sealed payloads.

## Decommissioning and host loss

For a planned retirement:

1. `npm run hostctl -- state HOST_ID draining`;
2. wait for active jobs to finish;
3. have every user remove or export their data;
4. reconcile every container and capacity counter;
5. `npm run hostctl -- state HOST_ID dead`; and
6. optionally `npm run hostctl -- remove HOST_ID --yes` after confirming its
   immutable history is visible.

Marking a non-empty host dead requires `--force` and is deliberately noisy:

    npm run hostctl -- state HOST_ID draining
    # isolate or power off the failed machine first
    npm run hostctl -- state HOST_ID dead --force --yes

Forced retirement performs control-plane evacuation, not storage recovery: it
fails active jobs, detaches eligible desired rows, clears the old dedicated
assignment, and queues destructive reprovisioning on healthy exact-class
capacity. There is still no backup restore, replication, automatic failover,
or live migration. Never force-retire a host that owns the only copy of user
data unless that loss is explicitly accepted.

After evacuation, either onboard replacement hardware with the same ID and
`--replace-dead` (which increments its generation), or deregister it with
`hostctl remove`. A dedicated account can immediately be assigned to another
dedicated host because retirement cleared the unique old assignment. Use
`hostctl history HOST_ID` for the retained telemetry instead of raw D1 SQL.

## Security invariants

- `FLEET_ADMIN_SECRET` and the Worker RPC private key stay in Cloudflare
  Secrets and on the operator workstation only; they are never copied to a
  host.
- The controller puts its bearer token in a temporary mode-0600 curl config,
  not process arguments, and removes it on exit.
- `/etc/workbench/daemon.json` and TLS private keys are root-readable only.
- Host X25519 private keys never leave their source host.
- Every daemon request requires an Ed25519 signature, timestamp, and nonce;
  credential payloads are additionally sealed to the selected host.
- Tenant containers remain in the restricted `workbench` project with exact
  class CPU, RAM, swap, process, disk, idmap, network, and SSH-forward limits.
- Outbound TCP/25 is blocked and new connections are rate-limited per source.
- Production storage is real encrypted ZFS with documented key handling;
  loop-backed or directory storage is never represented as production-safe.
- Coding-agent packages remain unpinned at image-build time. Preserve build
  logs and `npm list -g --depth=0` until pins and an SBOM are automated.
