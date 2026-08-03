#!/usr/bin/env bash
# Print the canonical, non-secret capacity registration for this host. The
# controller consumes this only while the host is drained.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DAEMON_CONFIG="${WB_DAEMON_CONFIG:-/etc/workbench/daemon.json}"
[[ -f "$DAEMON_CONFIG" ]] || {
  echo "!! daemon config is missing: $DAEMON_CONFIG" >&2
  exit 1
}

HOST_TYPE="${HOST_TYPE:-$(jq -er '.hostType // "budget"' "$DAEMON_CONFIG")}"
POOL_NAME="${POOL_NAME:-$(jq -er '.storagePool // "default"' "$DAEMON_CONFIG")}"
# shellcheck source=infra/host-policy.sh
source "$SCRIPT_DIR/host-policy.sh"
calculate_host_capacity "$POOL_NAME"

jq -cn \
  --argjson ramTotalMb "$RAM_TOTAL_MB" \
  --argjson ramReserveMb "$RAM_RESERVE" \
  --argjson vcpuCapacity "$VCPU_CAPACITY" \
  --argjson diskTotalGb "$DISK_GB" \
  --argjson maxTenants "$TENANT_SLOTS" \
  '{ramTotalMb: $ramTotalMb, ramReserveMb: $ramReserveMb,
    vcpuCapacity: $vcpuCapacity, diskTotalGb: $diskTotalGb,
    maxTenants: $maxTenants}'
