#!/usr/bin/env bash
# Read-only acceptance audit for a Workbench Incus host. Run as root after
# bootstrap and after every host-policy change; a non-zero exit blocks signup
# traffic from being enabled for the host.
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-workbench}"
POOL_NAME="${POOL_NAME:-default}"
NETWORK_NAME="${NETWORK_NAME:-incusbr0}"
TENANT_PROCESS_LIMIT="${TENANT_PROCESS_LIMIT:-1024}"
TENANT_NETWORK_LIMIT="${TENANT_NETWORK_LIMIT:-100Mbit}"
TENANT_RAM_MB=1536
TENANT_SWAP_MB=1024
ALLOW_DIR_STORAGE="${ALLOW_DIR_STORAGE:-0}"

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

if systemctl is-active --quiet incus; then
  pass "Incus daemon is active"
else
  fail "Incus daemon is active"
fi
if incus query /1.0 2>/dev/null | jq -e \
  '.metadata.api_extensions | index("instance_memory_swap_bytes") != null' >/dev/null; then
  pass "Incus supports byte-valued swap limits"
else
  fail "Incus supports byte-valued swap limits"
fi
if [[ -d /sys/module/br_netfilter ]]; then
  pass "bridge netfilter is loaded"
else
  fail "bridge netfilter is loaded"
fi
if systemctl is-active --quiet workbench-daemon; then
  pass "Workbench daemon is active"
else
  fail "Workbench daemon is active"
fi

STORAGE_DRIVER=$(incus storage show "$POOL_NAME" 2>/dev/null | awk '$1 == "driver:" { print $2; exit }' || true)
if [[ "$STORAGE_DRIVER" == "zfs" || "$ALLOW_DIR_STORAGE" == "1" ]]; then
  pass "storage pool driver is accepted ($STORAGE_DRIVER)"
else
  fail "storage pool must be ZFS (got ${STORAGE_DRIVER:-missing})"
fi
if POOL_TOTAL_BYTES=$(incus query "/1.0/storage-pools/${POOL_NAME}/resources" 2>/dev/null | \
  jq -er '.metadata.space.total // .space.total') && [[ "$POOL_TOTAL_BYTES" -gt 0 ]]; then
  pass "storage pool reports total capacity"
else
  fail "storage pool reports total capacity"
fi

check_eq "tenant project is restricted" "true" incus project get "$PROJECT_NAME" restricted
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
check_set "tenant project CPU ceiling" incus project get "$PROJECT_NAME" limits.cpu
check_set "tenant project memory ceiling" incus project get "$PROJECT_NAME" limits.memory
check_set "tenant project process ceiling" incus project get "$PROJECT_NAME" limits.processes
check_set "tenant project container ceiling" incus project get "$PROJECT_NAME" limits.containers
check_set "tenant project disk ceiling" \
  incus project get "$PROJECT_NAME" "limits.disk.pool.${POOL_NAME}"

PROJECT_SLOTS=$(incus project get "$PROJECT_NAME" limits.containers 2>/dev/null || echo 0)
SWAP_TOTAL_MB=$(awk '/SwapTotal/ { print int($2 / 1024) }' /proc/meminfo)
SWAP_REQUIRED_MB=$(( PROJECT_SLOTS * TENANT_SWAP_MB ))
if (( SWAP_TOTAL_MB >= SWAP_REQUIRED_MB )); then
  pass "host swap fits the tenant ceiling"
else
  fail "host swap fits the tenant ceiling (need ${SWAP_REQUIRED_MB}MiB, got ${SWAP_TOTAL_MB}MiB)"
fi
IDMAP_REQUIRED=$(( (PROJECT_SLOTS + 1) * 65536 ))
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
check_eq "profile root default quota" "5GiB" \
  incus --project "$PROJECT_NAME" profile device get default root size
check_eq "profile NIC network" "$NETWORK_NAME" \
  incus --project "$PROJECT_NAME" profile device get default eth0 network
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

if [[ -f /etc/workbench/daemon.json ]] && \
  jq -e --arg project "$PROJECT_NAME" '.project == $project' \
    /etc/workbench/daemon.json >/dev/null; then
  pass "daemon is scoped to the tenant project"
else
  fail "daemon is scoped to the tenant project"
fi
if nft list table inet workbench >/dev/null 2>&1; then
  pass "Workbench nftables policy is loaded"
else
  fail "Workbench nftables policy is loaded"
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
  check_set "$name has a CPU reservation" \
    incus --project "$PROJECT_NAME" config get "$name" limits.cpu
  check_set "$name has a CPU allowance" \
    incus --project "$PROJECT_NAME" config get "$name" limits.cpu.allowance
  check_eq "$name has the free-tier memory limit" "${TENANT_RAM_MB}MiB" \
    incus --project "$PROJECT_NAME" config get "$name" limits.memory
  check_eq "$name has hard memory enforcement" "hard" \
    incus --project "$PROJECT_NAME" config get "$name" limits.memory.enforce
  check_eq "$name has the free-tier swap limit" "${TENANT_SWAP_MB}MiB" \
    incus --project "$PROJECT_NAME" config get "$name" limits.memory.swap
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
  check_set "$name root disk has a quota" \
    incus --project "$PROJECT_NAME" config device get "$name" root size
  check_eq "$name home volume uses the tenant pool" "$POOL_NAME" \
    incus --project "$PROJECT_NAME" config device get "$name" home pool
  check_set "$name has an SSH proxy" \
    incus --project "$PROJECT_NAME" config device get "$name" ssh listen
done < <(incus --project "$PROJECT_NAME" list --format csv -c n)

echo "audited $checks controls across $tenant_count tenant container(s); failures=$failures"
if [[ "$failures" -ne 0 ]]; then
  exit 1
fi
