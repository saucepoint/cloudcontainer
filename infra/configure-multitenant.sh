#!/usr/bin/env bash
# Apply the Incus storage, project, tenant-limit, and network-isolation
# policy used by tenant hosts. Safe to run on an empty existing host during a
# drained migration; feature changes intentionally fail if incompatible
# instances already exist.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DAEMON_CONFIG="${WB_DAEMON_CONFIG:-/etc/workbench/daemon.json}"
if [[ -f "$DAEMON_CONFIG" ]]; then
  POOL_NAME="${POOL_NAME:-$(jq -er '.storagePool // "default"' "$DAEMON_CONFIG")}"
  PROJECT_NAME="${PROJECT_NAME:-$(jq -er '.project // "workbench"' "$DAEMON_CONFIG")}"
else
  POOL_NAME="${POOL_NAME:-default}"
  PROJECT_NAME="${PROJECT_NAME:-workbench}"
fi
NETWORK_NAME="${NETWORK_NAME:-incusbr0}"
ZFS_LOOP_GB="${ZFS_LOOP_GB:-0}"
ALLOW_DIR_STORAGE="${ALLOW_DIR_STORAGE:-0}"
SHARED_CAPACITY_PROJECT="${SHARED_CAPACITY_PROJECT:-}"
SHARED_CAPACITY_CONFIG="${SHARED_CAPACITY_CONFIG:-/etc/workbench/daemon.json}"
WORKBENCH_ENVIRONMENT="${WORKBENCH_ENVIRONMENT:-production}"
PROJECT_QUERY=$(jq -rn --arg project "$PROJECT_NAME" '$project | @uri')
if [[ -z "${HOST_TYPE:-}" && -f "$DAEMON_CONFIG" ]]; then
  HOST_TYPE=$(jq -er '.hostType // "budget"' "$DAEMON_CONFIG")
fi
if [[ -z "${TENANCY_MODE:-}" && -f "$DAEMON_CONFIG" ]]; then
  TENANCY_MODE=$(jq -er '.tenancyMode // (if (.hostType // "budget") == "dedicated" then "dedicated" else "shared" end)' "$DAEMON_CONFIG")
fi
: "${HOST_TYPE:?HOST_TYPE is required when daemon.json is unavailable}"
# shellcheck source=infra/host-policy.sh
source "$SCRIPT_DIR/host-policy.sh"

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
incus network show "$NETWORK_NAME" >/dev/null 2>&1 || \
  incus network create "$NETWORK_NAME" </dev/null
incus network set "$NETWORK_NAME" ipv4.firewall=true </dev/null
incus network set "$NETWORK_NAME" ipv6.firewall=true </dev/null
incus profile show default >/dev/null 2>&1 || incus profile create default
DEFAULT_ROOT_POOL=$(incus profile device get default root pool 2>/dev/null || true)
if [[ -z "$DEFAULT_ROOT_POOL" ]]; then
  incus profile device add default root disk path=/ pool="$POOL_NAME" </dev/null
elif [[ "$DEFAULT_ROOT_POOL" != "$POOL_NAME" ]]; then
  echo "!! image-build profile root uses pool $DEFAULT_ROOT_POOL instead of $POOL_NAME"
  exit 1
fi
DEFAULT_NETWORK=$(incus profile device get default eth0 network 2>/dev/null || true)
if [[ -z "$DEFAULT_NETWORK" ]]; then
  incus profile device add default eth0 nic network="$NETWORK_NAME" name=eth0 </dev/null
elif [[ "$DEFAULT_NETWORK" != "$NETWORK_NAME" ]]; then
  echo "!! image-build profile eth0 uses network $DEFAULT_NETWORK instead of $NETWORK_NAME"
  exit 1
fi

calculate_host_capacity "$POOL_NAME"

# Once staging exists, production capacity changes must account for it too.
# This prevents a later production expansion from silently consuming staging's
# static partition.
if [[ -z "$SHARED_CAPACITY_PROJECT" && "$PROJECT_NAME" == workbench ]] && \
  incus project show workbench-staging >/dev/null 2>&1; then
  SHARED_CAPACITY_PROJECT=workbench-staging
  SHARED_CAPACITY_CONFIG=/etc/workbench-staging/daemon.json
fi

# Independent D1 schedulers cannot coordinate reservations. A second daemon on
# the same physical host is allowed only when both Incus project caps form a
# static partition of the resource-derived ceiling and use the same class.
if [[ -n "$SHARED_CAPACITY_PROJECT" ]]; then
  [[ "$SHARED_CAPACITY_PROJECT" != "$PROJECT_NAME" ]] || {
    echo "!! SHARED_CAPACITY_PROJECT must differ from PROJECT_NAME" >&2
    exit 1
  }
  incus project show "$SHARED_CAPACITY_PROJECT" >/dev/null 2>&1 || {
    echo "!! shared capacity project is missing: $SHARED_CAPACITY_PROJECT" >&2
    exit 1
  }
  [[ -f "$SHARED_CAPACITY_CONFIG" ]] || {
    echo "!! shared capacity daemon config is missing: $SHARED_CAPACITY_CONFIG" >&2
    exit 1
  }
  SHARED_HOST_TYPE=$(jq -er '.hostType // "budget"' "$SHARED_CAPACITY_CONFIG")
  [[ "$SHARED_HOST_TYPE" == "$HOST_TYPE" ]] || {
    echo "!! shared control planes must use the same host class" >&2
    exit 1
  }
  SHARED_TENANT_SLOTS=$(incus project get "$SHARED_CAPACITY_PROJECT" limits.containers)
  [[ "$SHARED_TENANT_SLOTS" =~ ^[0-9]+$ ]] || {
    echo "!! shared project has no numeric tenant cap" >&2
    exit 1
  }
  if (( SHARED_TENANT_SLOTS + TENANT_SLOTS > RESOURCE_TENANT_SLOTS )); then
    echo "!! shared project tenant caps exceed physical capacity: $SHARED_TENANT_SLOTS + $TENANT_SLOTS > $RESOURCE_TENANT_SLOTS" >&2
    exit 1
  fi
fi

# Isolated containers need a distinct 65,536-ID range. Reserve one additional
# range for the ordinary default map used by trusted image-build containers.
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
  # The controller invokes bootstrap through `ssh ... bash -s`; prevent Incus
  # from treating the remaining remote script on stdin as a YAML project body.
  incus project create "$PROJECT_NAME" \
    --config features.images=false \
    --config features.networks=false \
    --config features.profiles=true \
    --config features.storage.volumes=true </dev/null
fi

# Refuse unknown, tenancy-incompatible, or over-capacity contents before
# changing aggregate or per-instance limits. Shared hosts accept both resource
# tiers regardless of their legacy host-class label.
EXISTING_TENANTS=0
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  EXISTING_TENANTS=$(( EXISTING_TENANTS + 1 ))
  CURRENT_ID=$(incus --project "$PROJECT_NAME" config get \
    "$name" user.workbench.id 2>/dev/null || true)
  if [[ -z "$CURRENT_ID" ]]; then
    echo "!! $name has no Workbench control-plane identity; refusing to mutate it"
    exit 1
  fi
  CURRENT_TIER=$(incus --project "$PROJECT_NAME" config get \
    "$name" user.workbench.tier 2>/dev/null || true)
  if [[ -z "$CURRENT_TIER" ]]; then
    CURRENT_TIER=$TENANT_TIER
  fi
  if [[ "$CURRENT_TIER" != "free" && "$CURRENT_TIER" != "paid" ]]; then
    echo "!! $name has unsupported tier metadata: $CURRENT_TIER"
    exit 1
  fi
  if [[ "$TENANCY_MODE" == "dedicated" && "$CURRENT_TIER" != "paid" ]]; then
    echo "!! dedicated host contains a non-paid tenant: $name"
    exit 1
  fi
done < <(incus --project "$PROJECT_NAME" list --format csv -c n)
if (( EXISTING_TENANTS > TENANT_SLOTS )); then
  echo "!! project has $EXISTING_TENANTS tenants but this host now supports only $TENANT_SLOTS"
  exit 1
fi

# Restricted-project defaults block raw LXC config, nesting, privileged
# containers, host devices, and unmanaged storage/network access. The daemon
# alone needs proxy devices for public SSH forwarding and the low-level
# exception below for its bounded per-tenant swap limit; tenant users have no
# Incus API access.
incus project set "$PROJECT_NAME" user.workbench.environment="$WORKBENCH_ENVIRONMENT"
incus project set "$PROJECT_NAME" user.workbench.host_type="$HOST_TYPE"
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
if [[ "$TENANCY_MODE" == "shared" ]]; then
  # CPU/RAM are placement targets, not hard project ceilings. Keeping these
  # aggregate Incus limits would reject an in-place tier upgrade once the sum
  # of instance limits crosses the target. Per-instance limits remain hard.
  incus project unset "$PROJECT_NAME" limits.cpu
  incus project unset "$PROJECT_NAME" limits.memory
else
  incus project set "$PROJECT_NAME" limits.cpu="$CPU_LIMIT"
  incus project set "$PROJECT_NAME" limits.memory="${RAM_LIMIT_MB}MiB"
fi
incus project set "$PROJECT_NAME" limits.processes="$(( TENANT_SLOTS * TENANT_PROCESS_LIMIT ))"
incus project set "$PROJECT_NAME" "limits.disk.pool.${POOL_NAME}=${DISK_GB}GiB"

incus --project "$PROJECT_NAME" profile show default >/dev/null 2>&1 || \
  incus --project "$PROJECT_NAME" profile create default </dev/null
TENANT_ROOT_POOL=$(incus --project "$PROJECT_NAME" profile device get default root pool 2>/dev/null || true)
if [[ -z "$TENANT_ROOT_POOL" ]]; then
  incus --project "$PROJECT_NAME" profile device add default root disk path=/ pool="$POOL_NAME" </dev/null
elif [[ "$TENANT_ROOT_POOL" != "$POOL_NAME" ]]; then
  echo "!! tenant profile root uses pool $TENANT_ROOT_POOL instead of $POOL_NAME"
  exit 1
fi
incus --project "$PROJECT_NAME" profile device set default root size="${TENANT_DISK_GB}GiB"
TENANT_NETWORK=$(incus --project "$PROJECT_NAME" profile device get default eth0 network 2>/dev/null || true)
if [[ -z "$TENANT_NETWORK" ]]; then
  incus --project "$PROJECT_NAME" profile device add default eth0 nic \
    network="$NETWORK_NAME" name=eth0 </dev/null
elif [[ "$TENANT_NETWORK" != "$NETWORK_NAME" ]]; then
  echo "!! tenant profile eth0 uses network $TENANT_NETWORK instead of $NETWORK_NAME"
  exit 1
fi
incus --project "$PROJECT_NAME" profile device set default eth0 security.mac_filtering=true
incus --project "$PROJECT_NAME" profile device set default eth0 security.ipv4_filtering=true
incus --project "$PROJECT_NAME" profile device set default eth0 security.ipv6_filtering=true
incus --project "$PROJECT_NAME" profile device set default eth0 security.port_isolation=true
incus --project "$PROJECT_NAME" profile device set default eth0 limits.max="$TENANT_NETWORK_LIMIT"

# Reconcile existing instances while the host is drained. Tier metadata is the
# source of truth on shared hosts. Disk quotas are intentionally left alone:
# plan transitions own growth, and Paid-to-Free storage is grandfathered.
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  INSTANCE_TIER=$(incus --project "$PROJECT_NAME" config get \
    "$name" user.workbench.tier 2>/dev/null || true)
  [[ -n "$INSTANCE_TIER" ]] || INSTANCE_TIER=$TENANT_TIER
  case "$INSTANCE_TIER" in
    free)
      INSTANCE_CPU=1
      INSTANCE_RAM_MB=1536
      INSTANCE_SWAP_MB=1024
      ;;
    paid)
      INSTANCE_CPU=2
      INSTANCE_RAM_MB=4096
      INSTANCE_SWAP_MB=1536
      ;;
    *)
      echo "!! $name has unsupported tier metadata: $INSTANCE_TIER"
      exit 1
      ;;
  esac
  if [[ "$TENANCY_MODE" == "dedicated" && "$INSTANCE_TIER" != "paid" ]]; then
    echo "!! dedicated host contains a non-paid tenant: $name"
    exit 1
  fi
  incus --project "$PROJECT_NAME" config set "$name" limits.cpu="$INSTANCE_CPU"
  incus --project "$PROJECT_NAME" config set "$name" limits.cpu.allowance="$(( INSTANCE_CPU * 100 ))%"
  # Add swap before a RAM downgrade; raise RAM before removing swap.
  if (( INSTANCE_SWAP_MB > 0 )); then
    incus --project "$PROJECT_NAME" config set "$name" limits.memory.swap="${INSTANCE_SWAP_MB}MiB"
  fi
  incus --project "$PROJECT_NAME" config set "$name" limits.memory="${INSTANCE_RAM_MB}MiB"
  incus --project "$PROJECT_NAME" config set "$name" limits.memory.enforce=hard
  if (( INSTANCE_SWAP_MB == 0 )); then
    incus --project "$PROJECT_NAME" config set "$name" limits.memory.swap=false
  fi
  incus --project "$PROJECT_NAME" config set "$name" limits.processes="$TENANT_PROCESS_LIMIT"
  incus --project "$PROJECT_NAME" config set "$name" boot.autostart=last-state
  incus --project "$PROJECT_NAME" config set "$name" boot.autorestart=false
  incus --project "$PROJECT_NAME" config set "$name" security.privileged=false
  incus --project "$PROJECT_NAME" config set "$name" security.idmap.isolated=true
  incus --project "$PROJECT_NAME" config set "$name" security.nesting=false
  incus --project "$PROJECT_NAME" config set "$name" user.workbench.tier="$INSTANCE_TIER"

  HOME_POOL=$(incus --project "$PROJECT_NAME" config device get "$name" home pool 2>/dev/null || true)
  HOME_SOURCE=$(incus --project "$PROJECT_NAME" config device get "$name" home source 2>/dev/null || true)
  if [[ "$HOME_POOL" != "$POOL_NAME" || -z "$HOME_SOURCE" ]]; then
    echo "!! $name has no managed home volume in pool $POOL_NAME"
    exit 1
  fi
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

echo "Incus tenant policy: type=$HOST_TYPE tenancy=$TENANCY_MODE project=$PROJECT_NAME slots=$TENANT_SLOTS vcpu_target=$CPU_LIMIT ram_target=${RAM_LIMIT_MB}MiB reserve=${RAM_RESERVE}MiB swap=${SWAP_TOTAL_MB}MiB disk=${DISK_GB}GiB idmap=$IDMAP_REQUIRED policy=$WORKBENCH_POLICY_VERSION"
