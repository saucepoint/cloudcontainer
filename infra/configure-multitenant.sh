#!/usr/bin/env bash
# Apply the Incus storage, project, aggregate-capacity, and network-isolation
# policy used by tenant hosts. Safe to run on an empty existing host during a
# drained migration; feature changes intentionally fail if incompatible
# instances already exist.
set -euo pipefail

POOL_NAME="${POOL_NAME:-default}"
PROJECT_NAME="${PROJECT_NAME:-workbench}"
NETWORK_NAME="${NETWORK_NAME:-incusbr0}"
ZFS_LOOP_GB="${ZFS_LOOP_GB:-0}"
ALLOW_DIR_STORAGE="${ALLOW_DIR_STORAGE:-0}"
DISK_CAPACITY_PERCENT="${DISK_CAPACITY_PERCENT:-70}"
VCPU_OVERCOMMIT="${VCPU_OVERCOMMIT:-3}"
TENANT_PROCESS_LIMIT="${TENANT_PROCESS_LIMIT:-1024}"
TENANT_NETWORK_LIMIT="${TENANT_NETWORK_LIMIT:-100Mbit}"
HOST_RAM_RESERVE_MB=2048
TENANT_RAM_MB=1536
TENANT_SWAP_MB=1024

if ! [[ "$DISK_CAPACITY_PERCENT" =~ ^[0-9]+$ ]] || \
  (( DISK_CAPACITY_PERCENT < 1 || DISK_CAPACITY_PERCENT > 90 )); then
  echo "!! DISK_CAPACITY_PERCENT must be an integer from 1 through 90"
  exit 1
fi
if ! [[ "$VCPU_OVERCOMMIT" =~ ^[0-9]+$ ]] || \
  (( VCPU_OVERCOMMIT < 1 || VCPU_OVERCOMMIT > 8 )); then
  echo "!! VCPU_OVERCOMMIT must be an integer from 1 through 8"
  exit 1
fi
if ! [[ "$TENANT_PROCESS_LIMIT" =~ ^[0-9]+$ ]] || (( TENANT_PROCESS_LIMIT < 64 )); then
  echo "!! TENANT_PROCESS_LIMIT must be an integer of at least 64"
  exit 1
fi
if ! incus query /1.0 | jq -e \
  '(.metadata.api_extensions // .api_extensions) | index("instance_memory_swap_bytes") != null' >/dev/null; then
  echo "!! Incus must support byte-valued limits.memory.swap (instance_memory_swap_bytes)"
  exit 1
fi

STORAGE_DRIVER=$(incus storage show "$POOL_NAME" | awk '$1 == "driver:" { print $2; exit }')
if [[ "$STORAGE_DRIVER" != "zfs" && "$ALLOW_DIR_STORAGE" != "1" ]]; then
  echo "!! storage pool $POOL_NAME uses $STORAGE_DRIVER; a quota-capable ZFS pool is required"
  exit 1
fi
if [[ "$ZFS_LOOP_GB" -gt 0 ]]; then
  echo "!! file-backed ZFS is suitable only for development and destructive multi-tenant testing"
fi

if ! modprobe br_netfilter; then
  echo "!! br_netfilter is required for Incus bridge anti-spoofing"
  exit 1
fi
install -d -m 0755 /etc/modules-load.d
printf '%s\n' br_netfilter > /etc/modules-load.d/workbench.conf

# Keep the default project usable for image builds, but tenant instances are
# created only in the restricted project below.
incus network show "$NETWORK_NAME" >/dev/null 2>&1 || incus network create "$NETWORK_NAME"
incus network set "$NETWORK_NAME" ipv4.firewall=true
incus network set "$NETWORK_NAME" ipv6.firewall=true
incus profile show default >/dev/null 2>&1 || incus profile create default
if ! incus profile device get default root path >/dev/null 2>&1; then
  incus profile device add default root disk path=/ pool="$POOL_NAME"
fi
if ! incus profile device get default eth0 network >/dev/null 2>&1; then
  incus profile device add default eth0 nic network="$NETWORK_NAME" name=eth0
fi

RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
# Register all detected physical RAM and retain a fixed 2 GiB host reserve.
# The scheduler allocates ram_total_mb - ram_reserve_mb.
RAM_TOTAL_MB=$RAM_MB
RAM_RESERVE=$HOST_RAM_RESERVE_MB
RAM_CAPACITY_MB=$(( RAM_TOTAL_MB - RAM_RESERVE ))
PHYSICAL_CORES=0
if command -v lscpu >/dev/null; then
  PHYSICAL_CORES=$(lscpu -p=CORE,SOCKET 2>/dev/null | awk -F, '
    !/^#/ { seen[$1 "," $2] = 1 }
    END { print length(seen) }
  ' || true)
fi
if [[ -z "$PHYSICAL_CORES" || "$PHYSICAL_CORES" -lt 1 ]]; then
  PHYSICAL_CORES=$(nproc)
fi
VCPU_CAPACITY=$(( PHYSICAL_CORES * VCPU_OVERCOMMIT ))
POOL_TOTAL_BYTES=$(incus query "/1.0/storage-pools/${POOL_NAME}/resources" | \
  jq -er '.metadata.space.total // .space.total')
DISK_GB=$(( POOL_TOTAL_BYTES * DISK_CAPACITY_PERCENT / 100 / 1073741824 ))

# The current service tier is 1 vCPU, 1.5 GiB RAM, 1 GiB swap, and 5 GiB each
# for root/home. Swap is capped per tenant by the daemon and must also exist on
# the host in sufficient aggregate capacity.
RAM_SLOTS=$(( RAM_CAPACITY_MB / TENANT_RAM_MB ))
CPU_SLOTS=$VCPU_CAPACITY
DISK_SLOTS=$(( DISK_GB / 10 ))
TENANT_SLOTS=$RAM_SLOTS
(( CPU_SLOTS < TENANT_SLOTS )) && TENANT_SLOTS=$CPU_SLOTS
(( DISK_SLOTS < TENANT_SLOTS )) && TENANT_SLOTS=$DISK_SLOTS
if [[ "$TENANT_SLOTS" -lt 1 ]]; then
  echo "!! host has no complete tenant slot after reserves (cpu=$CPU_SLOTS ram=$RAM_SLOTS disk=$DISK_SLOTS)"
  exit 1
fi
SWAP_TOTAL_MB=$(awk '/SwapTotal/ { print int($2 / 1024) }' /proc/meminfo)
SWAP_REQUIRED_MB=$(( TENANT_SLOTS * TENANT_SWAP_MB ))
if (( SWAP_TOTAL_MB < SWAP_REQUIRED_MB )); then
  echo "!! host swap is too small for $TENANT_SLOTS tenant slots"
  echo "   need at least ${SWAP_REQUIRED_MB}MiB; found ${SWAP_TOTAL_MB}MiB"
  exit 1
fi

# Isolated containers need a distinct 65,536-ID range. Reserve one additional
# range for the ordinary default map used by trusted image-build containers.
IDMAP_REQUIRED=$(( (TENANT_SLOTS + 1) * 65536 ))
if [[ -s /etc/subuid || -s /etc/subgid ]]; then
  SUBUID_TOTAL=$(awk -F: '$1 == "root" { total += int($3 / 65536) * 65536 } END { print total + 0 }' /etc/subuid 2>/dev/null || true)
  SUBGID_TOTAL=$(awk -F: '$1 == "root" { total += int($3 / 65536) * 65536 } END { print total + 0 }' /etc/subgid 2>/dev/null || true)
  SUBUID_TOTAL=${SUBUID_TOTAL:-0}
  SUBGID_TOTAL=${SUBGID_TOTAL:-0}
  if (( SUBUID_TOTAL < IDMAP_REQUIRED || SUBGID_TOTAL < IDMAP_REQUIRED )); then
    echo "!! root subordinate UID/GID ranges are too small for $TENANT_SLOTS isolated tenants"
    echo "   need at least $IDMAP_REQUIRED IDs; found uid=$SUBUID_TOTAL gid=$SUBGID_TOTAL"
    exit 1
  fi
fi

if ! incus project show "$PROJECT_NAME" >/dev/null 2>&1; then
  incus project create "$PROJECT_NAME" \
    --config features.images=false \
    --config features.networks=false \
    --config features.profiles=true \
    --config features.storage.volumes=true
fi

# Restricted-project defaults block raw LXC config, nesting, privileged
# containers, host devices, and unmanaged storage/network access. The daemon
# alone needs proxy devices for public SSH forwarding and the low-level
# exception below for its bounded per-tenant swap limit; tenant users have no
# Incus API access.
incus project set "$PROJECT_NAME" features.images=false
incus project set "$PROJECT_NAME" features.networks=false
incus project set "$PROJECT_NAME" features.profiles=true
incus project set "$PROJECT_NAME" features.storage.volumes=true
incus project set "$PROJECT_NAME" restricted=true
incus project set "$PROJECT_NAME" restricted.containers.lowlevel=allow
incus project set "$PROJECT_NAME" restricted.containers.nesting=block
incus project set "$PROJECT_NAME" restricted.containers.privilege=isolated
incus project set "$PROJECT_NAME" restricted.devices.disk=managed
incus project set "$PROJECT_NAME" restricted.devices.nic=managed
incus project set "$PROJECT_NAME" restricted.devices.proxy=allow
incus project set "$PROJECT_NAME" restricted.backups=block
incus project set "$PROJECT_NAME" restricted.snapshots=block
incus project set "$PROJECT_NAME" restricted.networks.access="$NETWORK_NAME"
incus project set "$PROJECT_NAME" restricted.storage-pools.access="$POOL_NAME"
incus project set "$PROJECT_NAME" limits.containers="$TENANT_SLOTS"
incus project set "$PROJECT_NAME" limits.cpu="$VCPU_CAPACITY"
incus project set "$PROJECT_NAME" limits.memory="${RAM_CAPACITY_MB}MiB"
incus project set "$PROJECT_NAME" limits.processes="$(( TENANT_SLOTS * TENANT_PROCESS_LIMIT ))"
incus project set "$PROJECT_NAME" "limits.disk.pool.${POOL_NAME}=${DISK_GB}GiB"

incus --project "$PROJECT_NAME" profile show default >/dev/null 2>&1 || \
  incus --project "$PROJECT_NAME" profile create default
TENANT_ROOT_POOL=$(incus --project "$PROJECT_NAME" profile device get default root pool 2>/dev/null || true)
if [[ -z "$TENANT_ROOT_POOL" ]]; then
  incus --project "$PROJECT_NAME" profile device add default root disk path=/ pool="$POOL_NAME"
elif [[ "$TENANT_ROOT_POOL" != "$POOL_NAME" ]]; then
  echo "!! tenant profile root uses pool $TENANT_ROOT_POOL instead of $POOL_NAME"
  exit 1
fi
incus --project "$PROJECT_NAME" profile device set default root size=5GiB
TENANT_NETWORK=$(incus --project "$PROJECT_NAME" profile device get default eth0 network 2>/dev/null || true)
if [[ -z "$TENANT_NETWORK" ]]; then
  incus --project "$PROJECT_NAME" profile device add default eth0 nic \
    network="$NETWORK_NAME" name=eth0
elif [[ "$TENANT_NETWORK" != "$NETWORK_NAME" ]]; then
  echo "!! tenant profile eth0 uses network $TENANT_NETWORK instead of $NETWORK_NAME"
  exit 1
fi
incus --project "$PROJECT_NAME" profile device set default eth0 security.mac_filtering=true
incus --project "$PROJECT_NAME" profile device set default eth0 security.ipv4_filtering=true
incus --project "$PROJECT_NAME" profile device set default eth0 security.ipv6_filtering=true
incus --project "$PROJECT_NAME" profile device set default eth0 security.port_isolation=true
incus --project "$PROJECT_NAME" profile device set default eth0 limits.max="$TENANT_NETWORK_LIMIT"

# This release has only free tenants. Reconcile existing instances as part of
# the drained host-policy rollout so D1 accounting and live cgroup limits do
# not diverge until a later rebuild.
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  # Add swap before lowering RAM so a live tenant never passes through a
  # transient 1.5 GiB memory-only ceiling.
  incus --project "$PROJECT_NAME" config set "$name" limits.memory.swap="${TENANT_SWAP_MB}MiB"
  incus --project "$PROJECT_NAME" config set "$name" limits.memory="${TENANT_RAM_MB}MiB"
done < <(incus --project "$PROJECT_NAME" list --format csv -c n)

# Prevent unprivileged tenants from enumerating host scheduler/cgroup names or
# slab internals. tmpfiles reapplies these virtual-filesystem modes on boot.
install -d -m 0755 /etc/tmpfiles.d
cat >/etc/tmpfiles.d/workbench.conf <<'EOF'
z /proc/sched_debug 0400 root root -
z /sys/kernel/slab 0700 root root -
EOF
[[ ! -e /proc/sched_debug ]] || chmod 0400 /proc/sched_debug
[[ ! -e /sys/kernel/slab ]] || chmod 0700 /sys/kernel/slab

echo "Incus tenant policy: project=$PROJECT_NAME slots=$TENANT_SLOTS vcpu=$VCPU_CAPACITY ram=${RAM_CAPACITY_MB}MiB reserve=${RAM_RESERVE}MiB swap=${SWAP_TOTAL_MB}MiB disk=${DISK_GB}GiB idmap=$IDMAP_REQUIRED"
