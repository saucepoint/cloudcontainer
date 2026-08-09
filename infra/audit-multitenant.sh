#!/usr/bin/env bash
# Read-only acceptance audit for a Workbench Incus host. Run as root after
# bootstrap and after every host-policy change; a non-zero exit blocks signup
# traffic from being enabled for the host.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DAEMON_CONFIG="${WB_DAEMON_CONFIG:-/etc/workbench/daemon.json}"
if [[ -f "$DAEMON_CONFIG" ]]; then
  PROJECT_NAME="${PROJECT_NAME:-$(jq -er '.project // "workbench"' "$DAEMON_CONFIG")}"
  POOL_NAME="${POOL_NAME:-$(jq -er '.storagePool // "default"' "$DAEMON_CONFIG")}"
else
  PROJECT_NAME="${PROJECT_NAME:-workbench}"
  POOL_NAME="${POOL_NAME:-default}"
fi
NETWORK_NAME="${NETWORK_NAME:-incusbr0}"
ALLOW_DIR_STORAGE="${ALLOW_DIR_STORAGE:-0}"
DAEMON_SERVICE="${DAEMON_SERVICE:-workbench-daemon}"
WORKBENCH_ENVIRONMENT="${WORKBENCH_ENVIRONMENT:-production}"
SHARED_CAPACITY_PROJECT="${SHARED_CAPACITY_PROJECT:-}"
PROJECT_QUERY=$(jq -rn --arg project "$PROJECT_NAME" '$project | @uri')
EXPECTED_HOST_ID="${EXPECTED_HOST_ID:-}"
EXPECTED_MAX_TENANTS="${EXPECTED_MAX_TENANTS:-}"
EXPECTED_VCPU_CAPACITY="${EXPECTED_VCPU_CAPACITY:-}"
EXPECTED_RAM_TOTAL_MB="${EXPECTED_RAM_TOTAL_MB:-}"
EXPECTED_RAM_RESERVE_MB="${EXPECTED_RAM_RESERVE_MB:-}"
EXPECTED_DISK_TOTAL_GB="${EXPECTED_DISK_TOTAL_GB:-}"
if [[ -z "${HOST_TYPE:-}" && -f "$DAEMON_CONFIG" ]]; then
  HOST_TYPE=$(jq -r '.hostType // "budget"' "$DAEMON_CONFIG")
fi
# shellcheck source=infra/host-policy.sh
source "$SCRIPT_DIR/host-policy.sh"

failures=0
checks=0

pass() {
  checks=$(( checks + 1 ))
  echo "ok - $1"
}

fail() {
  checks=$(( checks + 1 ))
  failures=$(( failures + 1 ))
  echo "not ok - $1" >&2
}

check_eq() {
  local label=$1
  local expected=$2
  shift 2
  local actual
  if ! actual=$("$@" 2>/dev/null); then
    fail "$label (command failed)"
  elif [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (expected $expected, got ${actual:-<empty>})"
  fi
}

check_set() {
  local label=$1
  shift
  local actual
  if actual=$("$@" 2>/dev/null) && [[ -n "$actual" ]]; then
    pass "$label"
  else
    fail "$label (missing)"
  fi
}

expanded_device_value() {
  local name=$1
  local device=$2
  local key=$3
  incus query "/1.0/instances/${name}?project=${PROJECT_QUERY}&recursion=1" | \
    jq -er --arg device "$device" --arg key "$key" \
      '.metadata.expanded_devices[$device][$key] // .expanded_devices[$device][$key] // empty'
}

home_volume_size() {
  local name=$1
  local source
  source=$(incus --project "$PROJECT_NAME" config device get "$name" home source)
  incus --project "$PROJECT_NAME" storage volume get "$POOL_NAME" "$source" size
}

if systemctl is-active --quiet incus; then
  pass "Incus daemon is active"
else
  fail "Incus daemon is active"
fi
if incus query /1.0 2>/dev/null | jq -e \
  '(.metadata.api_extensions // .api_extensions) | index("instance_memory_swap_bytes") != null' >/dev/null; then
  pass "Incus supports byte-valued swap limits"
else
  fail "Incus supports byte-valued swap limits"
fi
if [[ -d /sys/module/br_netfilter ]]; then
  pass "bridge netfilter is loaded"
else
  fail "bridge netfilter is loaded"
fi
if systemctl is-active --quiet "$DAEMON_SERVICE"; then
  pass "Workbench daemon is active ($DAEMON_SERVICE)"
else
  fail "Workbench daemon is active ($DAEMON_SERVICE)"
fi

STORAGE_DRIVER=$(incus storage show "$POOL_NAME" 2>/dev/null | awk '$1 == "driver:" { print $2; exit }' || true)
if [[ "$STORAGE_DRIVER" == "zfs" || "$ALLOW_DIR_STORAGE" == "1" ]]; then
  pass "storage pool driver is accepted ($STORAGE_DRIVER)"
else
  fail "storage pool must be ZFS (got ${STORAGE_DRIVER:-missing})"
fi
calculate_host_capacity "$POOL_NAME"
pass "host capacity is calculable ($TENANT_SLOTS complete $HOST_TYPE slot(s))"
if [[ -z "$SHARED_CAPACITY_PROJECT" && "$PROJECT_NAME" == workbench ]] && \
  incus project show workbench-staging >/dev/null 2>&1; then
  SHARED_CAPACITY_PROJECT=workbench-staging
fi
if [[ -n "$SHARED_CAPACITY_PROJECT" ]]; then
  SHARED_TENANT_SLOTS=$(incus project get "$SHARED_CAPACITY_PROJECT" limits.containers 2>/dev/null || true)
  if [[ "$SHARED_TENANT_SLOTS" =~ ^[0-9]+$ ]] && \
    (( SHARED_TENANT_SLOTS + TENANT_SLOTS <= RESOURCE_TENANT_SLOTS )); then
    pass "shared project tenant caps fit physical capacity"
  else
    fail "shared project tenant caps fit physical capacity"
  fi
fi

if [[ -n "$EXPECTED_MAX_TENANTS" ]]; then
  for expected in \
    "$EXPECTED_MAX_TENANTS" "$EXPECTED_VCPU_CAPACITY" "$EXPECTED_RAM_TOTAL_MB" \
    "$EXPECTED_RAM_RESERVE_MB" "$EXPECTED_DISK_TOTAL_GB"; do
    if ! [[ "$expected" =~ ^[0-9]+$ ]]; then
      echo "!! registered capacity expectations must be non-negative integers" >&2
      exit 1
    fi
  done
  EXPECTED_RAM_CAPACITY_MB=$(( EXPECTED_RAM_TOTAL_MB - EXPECTED_RAM_RESERVE_MB ))
  if (( TENANT_SLOTS >= EXPECTED_MAX_TENANTS )); then
    pass "calculated tenant ceiling covers the D1 registration"
  else
    fail "calculated tenant ceiling covers the D1 registration ($TENANT_SLOTS < $EXPECTED_MAX_TENANTS)"
  fi
  if (( VCPU_CAPACITY >= EXPECTED_VCPU_CAPACITY )); then
    pass "calculated vCPU capacity covers the D1 registration"
  else
    fail "calculated vCPU capacity covers the D1 registration ($VCPU_CAPACITY < $EXPECTED_VCPU_CAPACITY)"
  fi
  if (( RAM_TOTAL_MB + 16 >= EXPECTED_RAM_TOTAL_MB && RAM_CAPACITY_MB >= EXPECTED_RAM_CAPACITY_MB )); then
    pass "detected RAM capacity covers the D1 registration"
  else
    fail "detected RAM capacity covers the D1 registration"
  fi
  if (( DISK_GB >= EXPECTED_DISK_TOTAL_GB )); then
    pass "safe disk capacity covers the D1 registration"
  else
    fail "safe disk capacity covers the D1 registration ($DISK_GB < $EXPECTED_DISK_TOTAL_GB)"
  fi
fi

check_eq "tenant project environment identity" "$WORKBENCH_ENVIRONMENT" \
  incus project get "$PROJECT_NAME" user.workbench.environment
check_eq "tenant project host class identity" "$HOST_TYPE" \
  incus project get "$PROJECT_NAME" user.workbench.host_type
check_eq "tenant project is restricted" "true" incus project get "$PROJECT_NAME" restricted
check_eq "tenant project allows low-level config for managed swap" "allow" \
  incus project get "$PROJECT_NAME" restricted.containers.lowlevel
check_eq "tenant project requires isolated idmaps" "isolated" \
  incus project get "$PROJECT_NAME" restricted.containers.privilege
check_eq "tenant project blocks nesting" "block" \
  incus project get "$PROJECT_NAME" restricted.containers.nesting
check_eq "tenant project allows only managed disks" "managed" \
  incus project get "$PROJECT_NAME" restricted.devices.disk
check_eq "tenant project allows only managed NICs" "managed" \
  incus project get "$PROJECT_NAME" restricted.devices.nic
check_eq "tenant project allows only the service-managed proxy exception" "allow" \
  incus project get "$PROJECT_NAME" restricted.devices.proxy
check_eq "tenant project network allow-list" "$NETWORK_NAME" \
  incus project get "$PROJECT_NAME" restricted.networks.access
check_eq "tenant project storage allow-list" "$POOL_NAME" \
  incus project get "$PROJECT_NAME" restricted.storage-pools.access
check_eq "tenant project shares only the base-image namespace" "false" \
  incus project get "$PROJECT_NAME" features.images
check_eq "tenant project cannot create networks" "false" \
  incus project get "$PROJECT_NAME" features.networks
check_eq "tenant project has isolated profiles" "true" \
  incus project get "$PROJECT_NAME" features.profiles
check_eq "tenant project has isolated custom volumes" "true" \
  incus project get "$PROJECT_NAME" features.storage.volumes
check_eq "tenant project CPU ceiling" "$CPU_LIMIT" \
  incus project get "$PROJECT_NAME" limits.cpu
check_eq "tenant project memory ceiling" "${RAM_LIMIT_MB}MiB" \
  incus project get "$PROJECT_NAME" limits.memory
check_eq "tenant project process ceiling" "$(( TENANT_SLOTS * TENANT_PROCESS_LIMIT ))" \
  incus project get "$PROJECT_NAME" limits.processes
check_eq "tenant project container ceiling" "$TENANT_SLOTS" \
  incus project get "$PROJECT_NAME" limits.containers
check_eq "tenant project disk ceiling" "${DISK_GB}GiB" \
  incus project get "$PROJECT_NAME" "limits.disk.pool.${POOL_NAME}"

SWAP_REQUIRED_MB=$(( TENANT_SLOTS * TENANT_SWAP_MB ))
if (( SWAP_TOTAL_MB >= SWAP_REQUIRED_MB )); then
  pass "host swap fits the tenant ceiling"
else
  fail "host swap fits the tenant ceiling (need ${SWAP_REQUIRED_MB}MiB, got ${SWAP_TOTAL_MB}MiB)"
fi
if [[ -s /etc/subuid || -s /etc/subgid ]]; then
  SUBUID_TOTAL=$(awk -F: '$1 == "root" { total += int($3 / 65536) * 65536 } END { print total + 0 }' /etc/subuid 2>/dev/null || true)
  SUBGID_TOTAL=$(awk -F: '$1 == "root" { total += int($3 / 65536) * 65536 } END { print total + 0 }' /etc/subgid 2>/dev/null || true)
  SUBUID_TOTAL=${SUBUID_TOTAL:-0}
  SUBGID_TOTAL=${SUBGID_TOTAL:-0}
  if (( SUBUID_TOTAL >= IDMAP_REQUIRED && SUBGID_TOTAL >= IDMAP_REQUIRED )); then
    pass "subordinate UID/GID ranges fit the tenant ceiling"
  else
    fail "subordinate UID/GID ranges fit the tenant ceiling"
  fi
else
  pass "Incus default billion-ID range is available"
fi

check_eq "profile root pool" "$POOL_NAME" \
  incus --project "$PROJECT_NAME" profile device get default root pool
check_eq "image-build profile root pool" "$POOL_NAME" \
  incus profile device get default root pool
check_eq "profile root default quota" "${TENANT_DISK_GB}GiB" \
  incus --project "$PROJECT_NAME" profile device get default root size
check_eq "profile NIC network" "$NETWORK_NAME" \
  incus --project "$PROJECT_NAME" profile device get default eth0 network
check_eq "image-build profile NIC network" "$NETWORK_NAME" \
  incus profile device get default eth0 network
check_eq "Incus IPv4 firewall/NAT management" "true" \
  incus network get "$NETWORK_NAME" ipv4.firewall
check_eq "Incus IPv6 firewall/NAT management" "true" \
  incus network get "$NETWORK_NAME" ipv6.firewall
check_eq "profile MAC anti-spoofing" "true" \
  incus --project "$PROJECT_NAME" profile device get default eth0 security.mac_filtering
check_eq "profile IPv4 anti-spoofing" "true" \
  incus --project "$PROJECT_NAME" profile device get default eth0 security.ipv4_filtering
check_eq "profile IPv6 anti-spoofing" "true" \
  incus --project "$PROJECT_NAME" profile device get default eth0 security.ipv6_filtering
check_eq "profile east-west isolation" "true" \
  incus --project "$PROJECT_NAME" profile device get default eth0 security.port_isolation
check_eq "profile network bandwidth cap" "$TENANT_NETWORK_LIMIT" \
  incus --project "$PROJECT_NAME" profile device get default eth0 limits.max

if [[ -f "$DAEMON_CONFIG" ]] && \
  jq -e --arg project "$PROJECT_NAME" --arg host_type "$HOST_TYPE" \
    --arg host_id "$EXPECTED_HOST_ID" \
    '.project == $project and (.hostType // "budget") == $host_type and
      ($host_id == "" or .hostId == $host_id)' \
    "$DAEMON_CONFIG" >/dev/null; then
  pass "daemon identity is scoped to the tenant project and host class"
else
  fail "daemon identity is scoped to the tenant project and host class"
fi
BASE_IMAGE=$(jq -r '.baseImage // "workbench-base"' "$DAEMON_CONFIG" 2>/dev/null || true)
if [[ -n "$BASE_IMAGE" ]] && \
  incus --project "$PROJECT_NAME" image info "$BASE_IMAGE" >/dev/null 2>&1; then
  pass "daemon base image is available ($BASE_IMAGE)"
else
  fail "daemon base image is available (${BASE_IMAGE:-missing})"
fi
if nft list table inet workbench >/dev/null 2>&1; then
  pass "Workbench nftables policy is loaded"
else
  fail "Workbench nftables policy is loaded"
fi
if nft list table inet incus >/dev/null 2>&1; then
  pass "Incus nftables NAT/firewall policy is loaded"
else
  fail "Incus nftables NAT/firewall policy is loaded"
fi
if [[ ! -e /proc/sched_debug || "$(stat -c %a /proc/sched_debug)" == "400" ]]; then
  pass "scheduler debug data is root-only"
else
  fail "scheduler debug data is root-only"
fi
if [[ ! -e /sys/kernel/slab || "$(stat -c %a /sys/kernel/slab)" == "700" ]]; then
  pass "kernel slab data is root-only"
else
  fail "kernel slab data is root-only"
fi

tenant_count=0
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  tenant_count=$(( tenant_count + 1 ))
  check_set "$name has a control-plane identity" \
    incus --project "$PROJECT_NAME" config get "$name" user.workbench.id
  check_eq "$name has the class CPU reservation" "$TENANT_CPU" \
    incus --project "$PROJECT_NAME" config get "$name" limits.cpu
  check_eq "$name has the class CPU allowance" "$(( TENANT_CPU * 100 ))%" \
    incus --project "$PROJECT_NAME" config get "$name" limits.cpu.allowance
  check_eq "$name has the class tier metadata" "$TENANT_TIER" \
    incus --project "$PROJECT_NAME" config get "$name" user.workbench.tier
  check_eq "$name has the class memory limit" "${TENANT_RAM_MB}MiB" \
    incus --project "$PROJECT_NAME" config get "$name" limits.memory
  check_eq "$name has hard memory enforcement" "hard" \
    incus --project "$PROJECT_NAME" config get "$name" limits.memory.enforce
  if (( TENANT_SWAP_MB > 0 )); then
    check_eq "$name has the class swap limit" "${TENANT_SWAP_MB}MiB" \
      incus --project "$PROJECT_NAME" config get "$name" limits.memory.swap
  else
    check_eq "$name has swap disabled" "false" \
      incus --project "$PROJECT_NAME" config get "$name" limits.memory.swap
  fi
  check_eq "$name process ceiling" "$TENANT_PROCESS_LIMIT" \
    incus --project "$PROJECT_NAME" config get "$name" limits.processes
  check_eq "$name is unprivileged" "false" \
    incus --project "$PROJECT_NAME" config get "$name" security.privileged
  check_eq "$name has an isolated idmap" "true" \
    incus --project "$PROJECT_NAME" config get "$name" security.idmap.isolated
  IDMAP_SIZE=$(incus --project "$PROJECT_NAME" config get "$name" security.idmap.size 2>/dev/null || true)
  if [[ -z "$IDMAP_SIZE" ]]; then
    IDMAP_SIZE=$(incus --project "$PROJECT_NAME" config get "$name" volatile.idmap.current 2>/dev/null | \
      jq -er '.[0].Maprange' 2>/dev/null || true)
  fi
  [[ -n "$IDMAP_SIZE" ]] || IDMAP_SIZE=65536
  if [[ "$IDMAP_SIZE" == "65536" ]]; then
    pass "$name isolated idmap size"
  else
    fail "$name isolated idmap size (expected 65536, got $IDMAP_SIZE)"
  fi
  check_eq "$name cannot nest containers" "false" \
    incus --project "$PROJECT_NAME" config get "$name" security.nesting
  check_eq "$name preserves stopped state across host reboot" "last-state" \
    incus --project "$PROJECT_NAME" config get "$name" boot.autostart
  check_eq "$name root disk has the class quota" "${TENANT_DISK_GB}GiB" \
    expanded_device_value "$name" root size
  check_eq "$name home volume uses the tenant pool" "$POOL_NAME" \
    incus --project "$PROJECT_NAME" config device get "$name" home pool
  check_eq "$name home volume has the class quota" "${TENANT_DISK_GB}GiB" \
    home_volume_size "$name"
  check_set "$name has an SSH proxy" \
    incus --project "$PROJECT_NAME" config device get "$name" ssh listen
done < <(incus --project "$PROJECT_NAME" list --format csv -c n)

if (( tenant_count <= TENANT_SLOTS )); then
  pass "tenant count is within the calculated host ceiling"
else
  fail "tenant count exceeds the calculated host ceiling ($tenant_count > $TENANT_SLOTS)"
fi

echo "audited $checks controls across $tenant_count tenant container(s); failures=$failures"
if [[ "$failures" -ne 0 ]]; then
  exit 1
fi
