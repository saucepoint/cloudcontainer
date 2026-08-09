#!/usr/bin/env bash
# Canonical host-class and tenant resource policy. This file is sourced by
# bootstrap, configure-multitenant, and audit-multitenant; it performs no host
# mutations on its own.

POLICY_ENV_PATH="${WORKBENCH_HOST_POLICY_ENV:-/etc/workbench/host-policy.env}"
REQUESTED_VCPU_OVERCOMMIT_SET=false
REQUESTED_DISK_CAPACITY_PERCENT_SET=false
REQUESTED_HOST_RAM_RESERVE_MB_SET=false
REQUESTED_HOST_TENANT_LIMIT_SET=false
if [[ -v VCPU_OVERCOMMIT ]]; then
  REQUESTED_VCPU_OVERCOMMIT_SET=true
  REQUESTED_VCPU_OVERCOMMIT=$VCPU_OVERCOMMIT
fi
if [[ -v DISK_CAPACITY_PERCENT ]]; then
  REQUESTED_DISK_CAPACITY_PERCENT_SET=true
  REQUESTED_DISK_CAPACITY_PERCENT=$DISK_CAPACITY_PERCENT
fi
if [[ -v HOST_RAM_RESERVE_MB ]]; then
  REQUESTED_HOST_RAM_RESERVE_MB_SET=true
  REQUESTED_HOST_RAM_RESERVE_MB=$HOST_RAM_RESERVE_MB
fi
if [[ -v HOST_TENANT_LIMIT ]]; then
  REQUESTED_HOST_TENANT_LIMIT_SET=true
  REQUESTED_HOST_TENANT_LIMIT=$HOST_TENANT_LIMIT
fi
if [[ -f "$POLICY_ENV_PATH" ]]; then
  POLICY_ENV_OWNER=$(stat -c %u "$POLICY_ENV_PATH")
  POLICY_ENV_MODE=$(stat -c %a "$POLICY_ENV_PATH")
  if [[ "$POLICY_ENV_OWNER" != "0" ]] || (( (8#$POLICY_ENV_MODE & 022) != 0 )); then
    echo "!! $POLICY_ENV_PATH must be root-owned and not group/world-writable" >&2
    return 1 2>/dev/null || exit 1
  fi
  while IFS= read -r policy_line || [[ -n "$policy_line" ]]; do
    case "$policy_line" in
      ""|\#*) continue ;;
    esac
    if [[ "$policy_line" =~ ^(VCPU_OVERCOMMIT|DISK_CAPACITY_PERCENT|HOST_RAM_RESERVE_MB|HOST_TENANT_LIMIT)=([0-9]+)$ ]]; then
      printf -v "${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}"
    else
      echo "!! $POLICY_ENV_PATH contains an unsupported policy entry" >&2
      return 1 2>/dev/null || exit 1
    fi
  done < "$POLICY_ENV_PATH"
fi
if [[ "$REQUESTED_VCPU_OVERCOMMIT_SET" == true ]]; then
  VCPU_OVERCOMMIT=$REQUESTED_VCPU_OVERCOMMIT
fi
if [[ "$REQUESTED_DISK_CAPACITY_PERCENT_SET" == true ]]; then
  DISK_CAPACITY_PERCENT=$REQUESTED_DISK_CAPACITY_PERCENT
fi
if [[ "$REQUESTED_HOST_RAM_RESERVE_MB_SET" == true ]]; then
  HOST_RAM_RESERVE_MB=$REQUESTED_HOST_RAM_RESERVE_MB
fi
if [[ "$REQUESTED_HOST_TENANT_LIMIT_SET" == true ]]; then
  HOST_TENANT_LIMIT=$REQUESTED_HOST_TENANT_LIMIT
fi

HOST_TYPE="${HOST_TYPE:-budget}"
if [[ -z "${TENANCY_MODE:-}" ]]; then
  if [[ "$HOST_TYPE" == "dedicated" ]]; then
    TENANCY_MODE=dedicated
  else
    TENANCY_MODE=shared
  fi
fi
MAX_VCPU_OVERCOMMIT=4
HOST_RAM_OVERCOMMIT_NUMERATOR=5
HOST_RAM_OVERCOMMIT_DENOMINATOR=4
MIN_HOST_RAM_RESERVE_MB=3072
HOST_RAM_RESERVE_PERCENT=8
VCPU_OVERCOMMIT="${VCPU_OVERCOMMIT:-$MAX_VCPU_OVERCOMMIT}"
DISK_CAPACITY_PERCENT="${DISK_CAPACITY_PERCENT:-70}"
TENANT_PROCESS_LIMIT="${TENANT_PROCESS_LIMIT:-1024}"
TENANT_NETWORK_LIMIT="${TENANT_NETWORK_LIMIT:-100Mbit}"
# Zero means use the full resource-derived ceiling. A positive value creates a
# static partition so independent control planes can safely share one host.
HOST_TENANT_LIMIT="${HOST_TENANT_LIMIT:-0}"
WORKBENCH_POLICY_VERSION=6

case "$HOST_TYPE" in
  budget)
    TENANT_TIER=free
    TENANT_ADVERTISED_CPU=1
    TENANT_CPU=1
    TENANT_RAM_MB=1536
    TENANT_SWAP_MB=1024
    TENANT_DISK_GB=5
    ;;
  regular)
    TENANT_TIER=paid
    TENANT_ADVERTISED_CPU=2
    TENANT_CPU=3
    TENANT_RAM_MB=4096
    TENANT_SWAP_MB=0
    TENANT_DISK_GB=8
    ;;
  dedicated)
    TENANT_TIER=paid
    TENANT_ADVERTISED_CPU=2
    TENANT_CPU=3
    TENANT_RAM_MB=4096
    TENANT_SWAP_MB=0
    TENANT_DISK_GB=8
    ;;
  *)
    echo "!! HOST_TYPE must be budget, regular, or dedicated (got: $HOST_TYPE)" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

if [[ "$TENANCY_MODE" != "shared" && "$TENANCY_MODE" != "dedicated" ]]; then
  echo "!! TENANCY_MODE must be shared or dedicated (got: $TENANCY_MODE)" >&2
  return 1 2>/dev/null || exit 1
fi
if [[ "$HOST_TYPE" == "dedicated" && "$TENANCY_MODE" != "dedicated" ]] || \
  [[ "$HOST_TYPE" != "dedicated" && "$TENANCY_MODE" != "shared" ]]; then
  echo "!! HOST_TYPE $HOST_TYPE conflicts with tenancy mode $TENANCY_MODE" >&2
  return 1 2>/dev/null || exit 1
fi

# Every shared host can receive Free, whose advertised contract includes 1 GiB
# of bounded swap. Reserve that worst-case per tenant even when the legacy
# rollout class is regular/Paid.
SLOT_SWAP_MB=$TENANT_SWAP_MB
if [[ "$TENANCY_MODE" == "shared" ]]; then
  SLOT_SWAP_MB=1024
fi

TENANT_DISK_RESERVATION_GB=$(( TENANT_DISK_GB * 2 ))

if ! [[ "$DISK_CAPACITY_PERCENT" =~ ^[0-9]+$ ]] || \
  (( DISK_CAPACITY_PERCENT < 1 || DISK_CAPACITY_PERCENT > 90 )); then
  echo "!! DISK_CAPACITY_PERCENT must be an integer from 1 through 90" >&2
  return 1 2>/dev/null || exit 1
fi
if ! [[ "$VCPU_OVERCOMMIT" =~ ^[0-9]+$ ]] || \
  (( VCPU_OVERCOMMIT < 1 || VCPU_OVERCOMMIT > MAX_VCPU_OVERCOMMIT )); then
  echo "!! VCPU_OVERCOMMIT must be an integer from 1 through $MAX_VCPU_OVERCOMMIT" >&2
  return 1 2>/dev/null || exit 1
fi
if ! [[ "$TENANT_PROCESS_LIMIT" =~ ^[0-9]+$ ]] || (( TENANT_PROCESS_LIMIT < 64 )); then
  echo "!! TENANT_PROCESS_LIMIT must be an integer of at least 64" >&2
  return 1 2>/dev/null || exit 1
fi
if ! [[ "$HOST_TENANT_LIMIT" =~ ^[0-9]+$ ]]; then
  echo "!! HOST_TENANT_LIMIT must be a non-negative integer" >&2
  return 1 2>/dev/null || exit 1
fi

minimum_host_ram_reserve_mb() {
  local ram_total_mb=$1
  local percentage_reserve=$((
    (ram_total_mb * HOST_RAM_RESERVE_PERCENT + 99) / 100
  ))
  if (( percentage_reserve > MIN_HOST_RAM_RESERVE_MB )); then
    printf '%d\n' "$percentage_reserve"
  else
    printf '%d\n' "$MIN_HOST_RAM_RESERVE_MB"
  fi
}

# Calculate the conservative capacity advertised to D1 and enforced on the
# restricted Incus project. Callers supply the already-validated storage pool.
# The function performs host introspection but no mutations.
calculate_host_capacity() {
  local pool_name=${1:-${POOL_NAME:-default}}
  local configured_ram_reserve=${HOST_RAM_RESERVE_MB:-0}
  if ! [[ "$configured_ram_reserve" =~ ^[0-9]+$ ]]; then
    echo "!! HOST_RAM_RESERVE_MB must be a non-negative integer" >&2
    return 1
  fi

  RAM_TOTAL_MB=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
  if ! [[ "$RAM_TOTAL_MB" =~ ^[0-9]+$ ]] || (( RAM_TOTAL_MB < 1 )); then
    echo "!! could not detect total system RAM" >&2
    return 1
  fi
  DEFAULT_RAM_RESERVE=$(minimum_host_ram_reserve_mb "$RAM_TOTAL_MB")
  RAM_RESERVE=$DEFAULT_RAM_RESERVE
  if (( configured_ram_reserve > RAM_RESERVE )); then
    RAM_RESERVE=$configured_ram_reserve
  fi
  if (( RAM_RESERVE >= RAM_TOTAL_MB )); then
    echo "!! host RAM reserve must be smaller than total RAM" >&2
    return 1
  fi
  RAM_CAPACITY_MB=$(( RAM_TOTAL_MB - RAM_RESERVE ))

  HOST_VCPU_COUNT=$(nproc)
  if ! [[ "$HOST_VCPU_COUNT" =~ ^[0-9]+$ ]] || (( HOST_VCPU_COUNT < 1 )); then
    echo "!! could not detect online host vCPUs" >&2
    return 1
  fi
  VCPU_CAPACITY=$(( HOST_VCPU_COUNT * VCPU_OVERCOMMIT ))

  if ! POOL_TOTAL_BYTES=$(incus query "/1.0/storage-pools/${pool_name}/resources" | \
    jq -er '.metadata.space.total // .space.total'); then
    echo "!! storage pool $pool_name did not report total capacity" >&2
    return 1
  fi
  DISK_GB=$(( POOL_TOTAL_BYTES * DISK_CAPACITY_PERCENT / 100 / 1073741824 ))

  RAM_SLOTS=$((
    (RAM_CAPACITY_MB * HOST_RAM_OVERCOMMIT_NUMERATOR \
      + HOST_RAM_OVERCOMMIT_DENOMINATOR * TENANT_RAM_MB - 1) \
    / (HOST_RAM_OVERCOMMIT_DENOMINATOR * TENANT_RAM_MB)
  ))
  CPU_SLOTS=$(( (VCPU_CAPACITY + TENANT_CPU - 1) / TENANT_CPU ))
  DISK_SLOTS=$(( DISK_GB / TENANT_DISK_RESERVATION_GB ))
  TENANT_SLOTS=$RAM_SLOTS
  if (( CPU_SLOTS < TENANT_SLOTS )); then TENANT_SLOTS=$CPU_SLOTS; fi
  if (( DISK_SLOTS < TENANT_SLOTS )); then TENANT_SLOTS=$DISK_SLOTS; fi
  SWAP_TOTAL_MB=$(awk '/SwapTotal/ { print int($2 / 1024) }' /proc/meminfo)
  SWAP_SLOTS=0
  if (( SLOT_SWAP_MB > 0 )); then
    SWAP_SLOTS=$(( SWAP_TOTAL_MB / SLOT_SWAP_MB ))
    if (( SWAP_SLOTS < TENANT_SLOTS )); then TENANT_SLOTS=$SWAP_SLOTS; fi
  fi
  if [[ "$HOST_TYPE" == "dedicated" && "$TENANT_SLOTS" -gt 1 ]]; then
    TENANT_SLOTS=1
  fi

  # When explicit subordinate ranges exist, reserve one 65,536-ID map for the
  # trusted image-build project and treat the remainder as another capacity
  # dimension instead of advertising slots the kernel cannot isolate.
  IDMAP_SLOTS=$TENANT_SLOTS
  if [[ -s /etc/subuid || -s /etc/subgid ]]; then
    SUBUID_TOTAL=$(awk -F: '$1 == "root" { total += int($3 / 65536) * 65536 } END { print total + 0 }' \
      /etc/subuid 2>/dev/null || true)
    SUBGID_TOTAL=$(awk -F: '$1 == "root" { total += int($3 / 65536) * 65536 } END { print total + 0 }' \
      /etc/subgid 2>/dev/null || true)
    SUBUID_TOTAL=${SUBUID_TOTAL:-0}
    SUBGID_TOTAL=${SUBGID_TOTAL:-0}
    IDMAP_SLOTS=$(( SUBUID_TOTAL / 65536 - 1 ))
    SUBGID_SLOTS=$(( SUBGID_TOTAL / 65536 - 1 ))
    if (( SUBGID_SLOTS < IDMAP_SLOTS )); then IDMAP_SLOTS=$SUBGID_SLOTS; fi
    if (( IDMAP_SLOTS < TENANT_SLOTS )); then TENANT_SLOTS=$IDMAP_SLOTS; fi
  fi

  # Preserve the physical resource ceiling before applying an operator-owned
  # partition. Shared control planes must keep the sum of their project caps at
  # or below this value.
  RESOURCE_TENANT_SLOTS=$TENANT_SLOTS
  if (( HOST_TENANT_LIMIT > 0 && HOST_TENANT_LIMIT < TENANT_SLOTS )); then
    TENANT_SLOTS=$HOST_TENANT_LIMIT
  fi
  if (( TENANT_SLOTS < 1 )); then
    echo "!! $HOST_TYPE host has no complete $TENANT_TIER slot after reserves" >&2
    echo "   cpu=$CPU_SLOTS ram=$RAM_SLOTS disk=$DISK_SLOTS swap=$SWAP_SLOTS idmap=$IDMAP_SLOTS" >&2
    return 1
  fi

  # Shared project limits match D1's additive resource budgets; individual
  # instances still receive their exact tier limits. Dedicated remains bounded
  # by its single paid tenant shape.
  if [[ "$TENANCY_MODE" == "shared" ]]; then
    CPU_LIMIT=$VCPU_CAPACITY
    RAM_LIMIT_MB=$(( RAM_CAPACITY_MB * HOST_RAM_OVERCOMMIT_NUMERATOR / HOST_RAM_OVERCOMMIT_DENOMINATOR ))
  else
    CPU_LIMIT=$TENANT_CPU
    RAM_LIMIT_MB=$TENANT_RAM_MB
  fi

  # One distinct 65,536-ID range per tenant plus the trusted image-build map.
  IDMAP_REQUIRED=$(( (TENANT_SLOTS + 1) * 65536 ))
}
