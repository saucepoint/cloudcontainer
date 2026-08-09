#!/usr/bin/env bash
# Central controller for Workbench host registration and daemon fleet releases.
# It talks only to the authenticated control-plane fleet API and to each host's
# recorded management SSH endpoint. No credentials are copied to hosts.
set -Eeuo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-https://usebench.dev}"
AUTH_CONFIG=""
DEFAULT_VCPU_OVERCOMMIT=4
MAX_VCPU_OVERCOMMIT=4

usage() {
  cat <<'EOF'
Usage: npm run hostctl -- <command> [options]

Commands:
  list
      List registered host class, state, release, capacity, and active jobs.

  probe HOST_ID
      Ask the Worker to perform a signed daemon stats probe while keeping the
      host's current placement state.

  state HOST_ID active|draining|dead [--force] [--yes]
      Change placement state. Activation requires a recent successful probe;
      --force atomically evacuates a failed host for destructive reprovisioning.

  history HOST_ID
      Show immutable capacity, release, and hardware telemetry for retired
      generations of a host identity.

  rehome CONTAINER_ID [--yes]
      Destroy the old Incus instance and queue the account on the host class
      selected by its current subscription. Host-local home data is lost.

  reclass HOST_ID budget|regular|dedicated [--dedicated-user ID] [--yes]
      Reconfigure an empty draining host, register tenancy/resource capacity,
      audit, probe, and restore its previous active state when eligible.

  remove HOST_ID [--yes]
      Deregister an empty dead host while retaining its generation history.

  assign HOST_ID USER_ID|none
      Assign or clear the paid account for an empty, draining dedicated host.

  configure HOST_ID [options]
      Drain a host, update its tenant/daemon/management endpoints, perform a
      signed probe when release telemetry already exists, and reactivate it
      only if it was previously active. Legacy unverified hosts stay draining.

  audit HOST_ID
      Run the read-only host policy and registered-capacity audit through
      management SSH.

  capacity HOST_ID [--yes]
      Drain the host, reapply its persisted tenancy/resource policy, register its current
      conservative capacity, audit, probe, and restore only prior active state.

  onboard --id ID --type budget|regular|dedicated
            --management-host HOST --ssh-hostname HOST
            --daemon-endpoint HTTPS_URL [options]
      Copy the current clean release, bootstrap and audit the host, build the
      base image, register it as draining, and perform a signed probe.

  deploy (--all | --host ID | --type TYPE) [options]
      Sequentially drain, back up, update, audit, and probe selected hosts,
      restoring only previously active hosts. Failures remain draining.

Global environment:
  CONTROL_PLANE_URL       Fleet API base URL (default: https://usebench.dev)
  FLEET_ADMIN_SECRET      Required fleet API bearer secret; prompted on a TTY
  WORKER_RPC_PUBLIC_KEY   Required only for onboard; public Ed25519 key

Onboard options:
  --management-user USER  SSH user; non-root requires passwordless sudo
  --management-port PORT  SSH port (default: 22)
  --dedicated-user ID     Account assigned to a dedicated host
  --zfs-loop-gb N         Development-only loop-backed ZFS size
  --pool NAME             Incus storage pool (default: default)
  --ram-reserve-mb N      Higher reserve override (floor: max(3072 MiB, ceil(8%)))
  --vcpu-overcommit N     Reservations per online host vCPU (default/max: 4)
  --disk-capacity-percent N
                          Safe storage fraction (default: 70; max: 90)
  --tls-cert-path PATH    Existing trusted certificate path on the host
  --tls-key-path PATH     Existing trusted certificate key path on the host
  --skip-image            Do not rebuild workbench-base
  --activate              Activate after a successful probe
  --replace-dead          Reuse an evacuated dead host ID as a new generation
  --yes                   Do not ask for confirmation
  --dry-run               Print actions without changing hosts or D1
  --skip-checks           Skip the local typecheck/lint/test gate

Deploy options:
  --yes                   Do not ask for confirmation
  --dry-run               Print selected hosts and actions only
  --skip-checks           Skip the local typecheck/lint/test gate

Configure options:
  --management-host HOST  Controller SSH hostname
  --management-port PORT  Controller SSH port
  --management-user USER  Controller SSH user
  --ssh-hostname HOST     Tenant-facing SSH hostname
  --daemon-endpoint URL   Worker-facing trusted HTTPS daemon URL
  --yes                   Do not ask for confirmation
EOF
}

info() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

format_table() {
  if command -v column >/dev/null 2>&1; then
    column -t -s $'\t'
  else
    cat
  fi
}

require_fleet_secret() {
  if [[ -n "$AUTH_CONFIG" && -f "$AUTH_CONFIG" ]]; then
    return
  fi
  if [[ -z "${FLEET_ADMIN_SECRET:-}" ]]; then
    [[ -t 0 ]] || die "FLEET_ADMIN_SECRET is required."
    read -r -s -p "FLEET_ADMIN_SECRET: " FLEET_ADMIN_SECRET
    printf '\n'
  fi
  [[ -n "$FLEET_ADMIN_SECRET" ]] || die "FLEET_ADMIN_SECRET is empty."
  [[ "$FLEET_ADMIN_SECRET" != *$'\n'* && "$FLEET_ADMIN_SECRET" != *$'\r'* && \
     "$FLEET_ADMIN_SECRET" != *'"'* && "$FLEET_ADMIN_SECRET" != *'\'* ]] || \
    die "FLEET_ADMIN_SECRET contains unsupported characters."
  AUTH_CONFIG=$(mktemp /tmp/workbench-hostctl-auth.XXXXXX)
  chmod 0600 "$AUTH_CONFIG"
  printf 'header = "Authorization: Bearer %s"\n' "$FLEET_ADMIN_SECRET" > "$AUTH_CONFIG"
  unset FLEET_ADMIN_SECRET
}

cleanup() {
  if [[ -n "$AUTH_CONFIG" && -f "$AUTH_CONFIG" ]]; then
    rm -f -- "$AUTH_CONFIG"
  fi
}
trap cleanup EXIT

api() {
  local method=$1
  local path=$2
  local body=${3-}
  require_fleet_secret
  local args=(
    --fail-with-body --silent --show-error
    --connect-timeout 10 --max-time 30
    --config "$AUTH_CONFIG"
    --request "$method"
  )
  if [[ -n "$body" ]]; then
    args+=(--header "Content-Type: application/json" --data-binary "$body")
  fi
  curl "${args[@]}" "${CONTROL_PLANE_URL%/}${path}"
}

validate_id() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || die "Invalid host ID: $1"
}

validate_host_type() {
  case "$1" in
    budget|regular|dedicated) ;;
    *) die "Invalid host type: $1" ;;
  esac
}

validate_release_id() {
  [[ "$1" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "Invalid daemon release ID: $1"
}

release_id() {
  git -C "$ROOT_DIR" rev-parse --short=12 HEAD
}

require_clean_release() {
  [[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] || \
    die "Host releases require a clean checkout. Commit or stash changes first."
}

confirm() {
  local prompt=$1
  local assume_yes=$2
  if [[ "$assume_yes" == true ]]; then
    return
  fi
  [[ -t 0 ]] || die "Refusing a non-interactive host change without --yes."
  local answer
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || die "Cancelled."
}

fleet_json() {
  api GET /api/admin/hosts
}

host_json() {
  local host_id=$1
  fleet_json | jq -ec --arg id "$host_id" '.hosts[] | select(.id == $id)' || \
    die "Unknown host: $host_id"
}

management_fields() {
  local host=$1
  jq -er '
    select(.managementHostname != null)
    | [.managementHostname, (.managementPort | tostring), .managementUser, .hostType]
    | @tsv
  ' <<<"$host" || die "Host has no management SSH endpoint."
}

ssh_run() {
  local hostname=$1
  local port=$2
  local user=$3
  shift 3
  ssh -o BatchMode=yes -o ConnectTimeout=15 -p "$port" "$user@$hostname" "$@"
}

ssh_root_run() {
  local hostname=$1
  local port=$2
  local user=$3
  shift 3
  if [[ "$user" == root ]]; then
    ssh_run "$hostname" "$port" "$user" "$@"
  else
    ssh_run "$hostname" "$port" "$user" sudo -n "$@"
  fi
}

rsync_release() {
  local hostname=$1
  local port=$2
  local user=$3
  local remote_hostname=$hostname
  if [[ "$remote_hostname" == *:* ]]; then
    remote_hostname="[$remote_hostname]"
  fi
  local remote_rsync=()
  if [[ "$user" != root ]]; then
    remote_rsync+=(--rsync-path="sudo -n rsync")
  fi
  RSYNC_RSH="ssh -o BatchMode=yes -o ConnectTimeout=15 -p $port" \
    rsync -a --delete "${remote_rsync[@]}" \
      --exclude node_modules \
      --exclude .git \
      --exclude .worktrees \
      --exclude .wrangler \
      --exclude '.dev.vars*' \
      --exclude '.env*' \
      "$ROOT_DIR/" "$user@$remote_hostname:/opt/workbench/"
}

list_hosts() {
  fleet_json | jq -r '
    ["ID", "TYPE", "STATUS", "TENANTS", "CPU", "RAM_MIB", "DISK_GIB", "RELEASE", "JOBS"],
    (.hosts[] | [
      .id,
      .hostType,
      .status,
      ((.tenantCount | tostring) + "/" + (.maxTenants | tostring)),
      ((.vcpuAllocated | tostring) + "/" + (.vcpuCapacity | tostring)),
      ((.ramAllocatedMb | tostring) + "/" + ((.ramTotalMb - .ramReserveMb) | tostring)),
      ((.diskAllocatedGb | tostring) + "/" + (.diskTotalGb | tostring)),
      (.daemonVersion // "unknown"),
      (.activeJobCount | tostring)
    ]) | @tsv
  ' | format_table
}

probe_host() {
  local host_id=$1
  validate_id "$host_id"
  api POST "/api/admin/hosts/$host_id/probe" | jq .
}

set_host_state() {
  local host_id=$1
  local state=$2
  local force=${3:-false}
  validate_id "$host_id"
  case "$state" in active|draining|dead) ;; *) die "Invalid host state: $state" ;; esac
  api PATCH "/api/admin/hosts/$host_id" "$(jq -cn \
    --arg status "$state" --argjson force "$force" \
    '{status: $status} + (if $force then {force: true} else {} end)')" | jq .
}

show_host_history() {
  local host_id=$1
  validate_id "$host_id"
  api GET "/api/admin/hosts/$host_id/history" | jq .
}

rehome_container() {
  local container_id=${1:-}
  [[ -n "$container_id" ]] || die "rehome requires CONTAINER_ID"
  shift
  local assume_yes=false
  while (($#)); do
    case "$1" in
      --yes|-y) assume_yes=true ;;
      *) die "Unknown rehome option: $1" ;;
    esac
    shift
  done
  [[ "$container_id" =~ ^[A-Za-z0-9-]{1,128}$ ]] || die "Invalid container ID"
  confirm "Destroy $container_id and re-provision it on its current plan? Host-local home data will be lost." \
    "$assume_yes"
  api POST "/api/admin/containers/$container_id/rehome" '{"confirmDataLoss":true}' | jq .
}

remove_host() {
  local host_id=${1:-}
  [[ -n "$host_id" ]] || die "remove requires HOST_ID"
  shift
  local assume_yes=false
  while (($#)); do
    case "$1" in
      --yes|-y) assume_yes=true ;;
      *) die "Unknown remove option: $1" ;;
    esac
    shift
  done
  validate_id "$host_id"
  local host
  host=$(host_json "$host_id")
  [[ "$(jq -er .status <<<"$host")" == dead ]] || die "Drain and retire the host before removal"
  [[ "$(jq -er .tenantCount <<<"$host")" == 0 ]] || die "Dead host still owns tenants; repeat state --force"
  confirm "Deregister $host_id? Its immutable generation history will remain." "$assume_yes"
  api DELETE "/api/admin/hosts/$host_id" >/dev/null
  info "$host_id deregistered"
}

assign_dedicated_host() {
  local host_id=$1
  local user_id=$2
  validate_id "$host_id"
  local body
  if [[ "$user_id" == none ]]; then
    body='{"dedicatedUserId":null}'
  else
    [[ -n "$user_id" && "$user_id" != *$'\n'* ]] || die "Invalid user ID"
    body=$(jq -cn --arg user_id "$user_id" '{dedicatedUserId: $user_id}')
  fi
  api PATCH "/api/admin/hosts/$host_id" "$body" | jq .
}

configure_host() {
  local host_id=${1:-}
  [[ -n "$host_id" ]] || die "configure requires HOST_ID"
  shift
  validate_id "$host_id"
  local management_host=""
  local management_port=""
  local management_user=""
  local ssh_hostname=""
  local daemon_endpoint=""
  local assume_yes=false
  while (($#)); do
    case "$1" in
      --management-host) management_host=${2:-}; shift ;;
      --management-port) management_port=${2:-}; shift ;;
      --management-user) management_user=${2:-}; shift ;;
      --ssh-hostname) ssh_hostname=${2:-}; shift ;;
      --daemon-endpoint) daemon_endpoint=${2:-}; shift ;;
      --yes|-y) assume_yes=true ;;
      *) die "Unknown configure option: $1" ;;
    esac
    shift
  done
  [[ -n "$management_host" || -n "$management_port" || -n "$management_user" || \
     -n "$ssh_hostname" || -n "$daemon_endpoint" ]] || \
    die "configure requires at least one endpoint option"
  if [[ -n "$management_host" ]]; then
    [[ "$management_host" =~ ^[A-Za-z0-9._:-]+$ ]] || die "Invalid management hostname"
  fi
  if [[ -n "$management_port" ]]; then
    [[ "$management_port" =~ ^[0-9]+$ ]] && \
      (( management_port >= 1 && management_port <= 65535 )) || die "Invalid management port"
  fi
  if [[ -n "$management_user" ]]; then
    [[ "$management_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid management user"
  fi
  if [[ -n "$ssh_hostname" ]]; then
    [[ "$ssh_hostname" =~ ^[A-Za-z0-9._:-]+$ ]] || die "Invalid tenant SSH hostname"
  fi
  if [[ -n "$daemon_endpoint" ]]; then
    [[ "$daemon_endpoint" =~ ^https://[^/?#]+$ ]] || \
      die "Daemon endpoint must be an HTTPS origin without a trailing slash"
  fi

  local host previous_status previous_version body fields current_management_host
  local current_management_port current_management_user host_type
  host=$(host_json "$host_id")
  previous_status=$(jq -er .status <<<"$host")
  previous_version=$(jq -r '.daemonVersion // empty' <<<"$host")
  [[ "$previous_status" != dead ]] || die "Dead hosts cannot be reconfigured"
  confirm "Drain and update endpoints for $host_id?" "$assume_yes"
  if [[ "$previous_status" != draining ]]; then
    api PATCH "/api/admin/hosts/$host_id" '{"status":"draining"}' >/dev/null
  fi
  host=$(host_json "$host_id")
  if [[ "$(jq -er .activeJobCount <<<"$host")" != "0" ]]; then
    die "$host_id remains draining because it has active jobs"
  fi
  fields=$(management_fields "$host")
  IFS=$'\t' read -r current_management_host current_management_port \
    current_management_user host_type <<<"$fields"
  require_command ssh
  info "Verifying the replacement management target for $host_id"
  remote_preflight \
    "${management_host:-$current_management_host}" \
    "${management_port:-$current_management_port}" \
    "${management_user:-$current_management_user}" \
    "$host_id" "$host_type"
  body=$(jq -cn \
    --arg managementHostname "$management_host" \
    --arg managementPort "$management_port" \
    --arg managementUser "$management_user" \
    --arg sshHostname "$ssh_hostname" \
    --arg daemonEndpoint "$daemon_endpoint" \
    '{}
      + (if $managementHostname == "" then {} else {managementHostname: $managementHostname} end)
      + (if $managementPort == "" then {} else {managementPort: ($managementPort | tonumber)} end)
      + (if $managementUser == "" then {} else {managementUser: $managementUser} end)
      + (if $sshHostname == "" then {} else {sshHostname: $sshHostname} end)
      + (if $daemonEndpoint == "" then {} else {daemonEndpoint: $daemonEndpoint} end)')
  api PATCH "/api/admin/hosts/$host_id" "$body" >/dev/null
  if [[ -z "$previous_version" ]]; then
    info "$host_id remains draining; its endpoint will be verified by the first fleet deploy"
    return
  fi
  info "Probing $host_id after endpoint update"
  probe_host "$host_id" >/dev/null
  if [[ "$previous_status" == active ]]; then
    set_host_state "$host_id" active >/dev/null
    info "$host_id is active"
  else
    info "$host_id remains draining"
  fi
}

audit_host() {
  local host_id=$1
  validate_id "$host_id"
  local host fields hostname port user host_type
  local max_tenants vcpu_capacity ram_total_mb ram_reserve_mb disk_total_gb
  host=$(host_json "$host_id")
  fields=$(management_fields "$host")
  IFS=$'\t' read -r hostname port user host_type <<<"$fields"
  max_tenants=$(jq -er .maxTenants <<<"$host")
  vcpu_capacity=$(jq -er .vcpuCapacity <<<"$host")
  ram_total_mb=$(jq -er .ramTotalMb <<<"$host")
  ram_reserve_mb=$(jq -er .ramReserveMb <<<"$host")
  disk_total_gb=$(jq -er .diskTotalGb <<<"$host")
  require_command ssh
  info "Auditing $host_id ($host_type) on $user@$hostname:$port"
  ssh_root_run "$hostname" "$port" "$user" env \
    EXPECTED_HOST_ID="$host_id" HOST_TYPE="$host_type" \
    EXPECTED_MAX_TENANTS="$max_tenants" \
    EXPECTED_VCPU_CAPACITY="$vcpu_capacity" \
    EXPECTED_RAM_TOTAL_MB="$ram_total_mb" \
    EXPECTED_RAM_RESERVE_MB="$ram_reserve_mb" \
    EXPECTED_DISK_TOTAL_GB="$disk_total_gb" \
    bash /opt/workbench/infra/audit-multitenant.sh
}

refresh_host_capacity() {
  local host_id=${1:-}
  [[ -n "$host_id" ]] || die "capacity requires HOST_ID"
  shift
  validate_id "$host_id"
  local assume_yes=false
  while (($#)); do
    case "$1" in
      --yes|-y) assume_yes=true ;;
      *) die "Unknown capacity option: $1" ;;
    esac
    shift
  done

  local host original_status fields hostname port user host_type capacity body
  host=$(host_json "$host_id")
  original_status=$(jq -er .status <<<"$host")
  [[ "$original_status" != dead ]] || die "Dead hosts cannot change capacity"
  fields=$(management_fields "$host")
  IFS=$'\t' read -r hostname port user host_type <<<"$fields"
  require_command ssh
  confirm "Drain, reconcile, and re-register capacity for $host_id?" "$assume_yes"
  if [[ "$original_status" != draining ]]; then
    api PATCH "/api/admin/hosts/$host_id" '{"status":"draining"}' >/dev/null
  fi
  host=$(host_json "$host_id")
  if [[ "$(jq -er .activeJobCount <<<"$host")" != "0" ]]; then
    die "$host_id remains draining because it has active jobs"
  fi

  info "Verifying management identity and reconciling $host_id policy"
  remote_preflight "$hostname" "$port" "$user" "$host_id" "$host_type"
  ssh_root_run "$hostname" "$port" "$user" env HOST_TYPE="$host_type" \
    bash /opt/workbench/infra/configure-multitenant.sh
  capacity=$(ssh_root_run "$hostname" "$port" "$user" env HOST_TYPE="$host_type" \
    bash /opt/workbench/infra/report-host-capacity.sh)
  jq -e '
    type == "object" and
    ([.ramTotalMb, .ramReserveMb, .vcpuCapacity, .diskTotalGb, .maxTenants]
      | all(type == "number" and floor == .))
  ' <<<"$capacity" >/dev/null || die "Host returned an invalid capacity report"
  body=$(jq -cn --argjson capacity "$capacity" '{capacity: $capacity}')
  api PATCH "/api/admin/hosts/$host_id" "$body" >/dev/null

  info "Auditing and probing the new capacity for $host_id"
  audit_host "$host_id"
  probe_host "$host_id" >/dev/null
  if [[ "$original_status" == active ]]; then
    set_host_state "$host_id" active >/dev/null
    info "$host_id is active with its refreshed capacity"
  else
    info "$host_id remains draining (previous state: $original_status)"
  fi
}

reclass_host() {
  local host_id=${1:-}
  local target_type=${2:-}
  [[ -n "$host_id" && -n "$target_type" ]] || \
    die "reclass requires HOST_ID and budget|regular|dedicated"
  shift 2
  validate_id "$host_id"
  validate_host_type "$target_type"
  local dedicated_user=""
  local assume_yes=false
  while (($#)); do
    case "$1" in
      --dedicated-user) dedicated_user=${2:-}; shift ;;
      --yes|-y) assume_yes=true ;;
      *) die "Unknown reclass option: $1" ;;
    esac
    shift
  done
  if [[ "$target_type" != dedicated && -n "$dedicated_user" ]]; then
    die "--dedicated-user is valid only for dedicated hosts"
  fi

  local host original_status fields hostname port user current_type capacity body
  host=$(host_json "$host_id")
  original_status=$(jq -er .status <<<"$host")
  [[ "$original_status" != dead ]] || die "Replace a dead host generation instead of reclassifying it"
  fields=$(management_fields "$host")
  IFS=$'\t' read -r hostname port user current_type <<<"$fields"
  confirm "Drain and reclassify $host_id from $current_type to $target_type?" "$assume_yes"
  if [[ "$original_status" != draining ]]; then
    api PATCH "/api/admin/hosts/$host_id" '{"status":"draining"}' >/dev/null
  fi
  host=$(host_json "$host_id")
  [[ "$(jq -er .activeJobCount <<<"$host")" == 0 ]] || \
    die "$host_id remains draining because it has active jobs"
  [[ "$(jq -er .tenantCount <<<"$host")" == 0 ]] || \
    die "$host_id remains draining; re-home or destroy every tenant before reclassification"

  require_command ssh
  info "Reconfiguring $host_id for the $target_type class"
  ssh_root_run "$hostname" "$port" "$user" bash -s -- \
    "$host_id" "$current_type" "$target_type" <<'REMOTE'
set -Eeuo pipefail
host_id=$1
current_type=$2
target_type=$3
target_tenancy=shared
[[ "$target_type" != dedicated ]] || target_tenancy=dedicated
config=/etc/workbench/daemon.json
jq -e --arg host_id "$host_id" --arg current "$current_type" --arg target "$target_type" '
  .hostId == $host_id and (.hostType == null or .hostType == $current or .hostType == $target)
' "$config" >/dev/null
next_config=$(mktemp /etc/workbench/daemon.json.XXXXXX)
jq --arg host_type "$target_type" \
  --arg tenancy_mode "$target_tenancy" \
  '.hostType = $host_type | .tenancyMode = $tenancy_mode' "$config" > "$next_config"
install -o root -g root -m 0600 "$next_config" "$config"
rm -f -- "$next_config"
cd /opt/workbench
HOST_TYPE="$target_type" bash infra/configure-multitenant.sh
systemctl restart workbench-daemon
systemctl is-active --quiet workbench-daemon
REMOTE
  capacity=$(ssh_root_run "$hostname" "$port" "$user" env HOST_TYPE="$target_type" \
    bash /opt/workbench/infra/report-host-capacity.sh)
  jq -e '
    type == "object" and
    ([.ramTotalMb, .ramReserveMb, .vcpuCapacity, .diskTotalGb, .maxTenants]
      | all(type == "number" and floor == .))
  ' <<<"$capacity" >/dev/null || die "Host returned an invalid capacity report"
  body=$(jq -cn --arg hostType "$target_type" --argjson capacity "$capacity" \
    '{hostType: $hostType, capacity: $capacity}')
  api PATCH "/api/admin/hosts/$host_id" "$body" >/dev/null
  if [[ -n "$dedicated_user" ]]; then
    assign_dedicated_host "$host_id" "$dedicated_user" >/dev/null
  fi

  info "Auditing and probing the reclassified host"
  audit_host "$host_id"
  probe_host "$host_id" >/dev/null
  host=$(host_json "$host_id")
  if [[ "$original_status" == active ]]; then
    if [[ "$target_type" != dedicated || \
          "$(jq -r '.dedicatedUserId // empty' <<<"$host")" != "" ]]; then
      set_host_state "$host_id" active >/dev/null
      info "$host_id is active as $target_type"
      return
    fi
  fi
  info "$host_id remains draining as $target_type"
}

remote_preflight() {
  local hostname=$1
  local port=$2
  local user=$3
  local expected_host_id=$4
  local expected_host_type=$5
  ssh_root_run "$hostname" "$port" "$user" bash -s -- \
    "$expected_host_id" "$expected_host_type" <<'REMOTE'
set -Eeuo pipefail
expected_host_id=$1
expected_host_type=$2
config=/etc/workbench/daemon.json
[[ -f "$config" ]]
jq -e --arg host_id "$expected_host_id" --arg host_type "$expected_host_type" '
  .hostId == $host_id and (.hostType == null or .hostType == $host_type)
' "$config" >/dev/null
REMOTE
}

remote_backup() {
  local hostname=$1
  local port=$2
  local user=$3
  ssh_root_run "$hostname" "$port" "$user" bash -s <<'REMOTE'
set -Eeuo pipefail
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
paths=(opt/workbench etc/workbench)
if [[ -f /etc/systemd/system/workbench-daemon.service ]]; then
  paths+=(etc/systemd/system/workbench-daemon.service)
fi
tar --exclude=opt/workbench/node_modules \
  --exclude='opt/workbench/.dev.vars*' \
  --exclude='opt/workbench/.env*' \
  -C / -czf "/root/workbench-$stamp.tgz" "${paths[@]}"
printf 'backup_stamp=%s\n' "$stamp"
REMOTE
}

remote_install() {
  local hostname=$1
  local port=$2
  local user=$3
  local release=$4
  local host_type=$5
  local host_id=$6
  local max_tenants=$7
  local vcpu_capacity=$8
  local ram_total_mb=$9
  local ram_reserve_mb=${10}
  local disk_total_gb=${11}
  ssh_root_run "$hostname" "$port" "$user" bash -s -- \
    "$release" "$host_type" "$host_id" "$max_tenants" "$vcpu_capacity" \
    "$ram_total_mb" "$ram_reserve_mb" "$disk_total_gb" <<'REMOTE'
set -Eeuo pipefail
release_id=$1
host_type=$2
host_id=$3
max_tenants=$4
vcpu_capacity=$5
ram_total_mb=$6
ram_reserve_mb=$7
disk_total_gb=$8
[[ "$release_id" =~ ^[A-Za-z0-9._-]{1,128}$ ]]
[[ "$host_type" =~ ^(budget|regular|dedicated)$ ]]
[[ "$host_id" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]
for capacity in "$max_tenants" "$vcpu_capacity" "$ram_total_mb" "$ram_reserve_mb" "$disk_total_gb"; do
  [[ "$capacity" =~ ^[0-9]+$ ]]
done
cd /opt/workbench
npm ci --omit=dev --workspaces --include-workspace-root

# Add fleet identity fields to a legacy config only after verifying that this
# management endpoint belongs to the expected host. Never silently strand an
# existing tenant in a legacy Incus project.
config=/etc/workbench/daemon.json
configured_project=$(jq -r '.project // "default"' "$config")
if [[ "$configured_project" != workbench ]]; then
  legacy_tenants=$(incus --project "$configured_project" list --format json | \
    jq '[.[] | select(.config["user.workbench.id"] != null)] | length')
  if (( legacy_tenants > 0 )); then
    echo "legacy project $configured_project still owns $legacy_tenants tenant(s); refusing automatic migration" >&2
    exit 1
  fi
fi
umask 077
config_new=$(mktemp /etc/workbench/daemon.json.XXXXXX)
cleanup_config() {
  if [[ -n "${config_new:-}" && -f "$config_new" ]]; then
    rm -f -- "$config_new"
  fi
}
trap cleanup_config EXIT
tenancy_mode=shared
[[ "$host_type" != dedicated ]] || tenancy_mode=dedicated
jq --arg host_id "$host_id" --arg host_type "$host_type" \
  --arg tenancy_mode "$tenancy_mode" '
  if .hostId != $host_id then error("host identity mismatch")
  elif .hostType != null and .hostType != $host_type then error("host class mismatch")
  else .hostType = $host_type | .tenancyMode = $tenancy_mode | .project = "workbench"
  end
' "$config" > "$config_new"
chown root:root "$config_new"
chmod 0600 "$config_new"
mv "$config_new" "$config"
config_new=""

HOST_TYPE="$host_type" bash infra/configure-multitenant.sh
install -m 0644 apps/daemon/systemd/workbench-daemon.service \
  /etc/systemd/system/workbench-daemon.service
install -m 0644 /dev/null /etc/workbench/release.env
printf 'WB_DAEMON_VERSION=%s\n' "$release_id" > /etc/workbench/release.env
systemctl daemon-reload
systemctl restart workbench-daemon
systemctl is-active --quiet workbench-daemon
EXPECTED_HOST_ID="$host_id" HOST_TYPE="$host_type" \
EXPECTED_MAX_TENANTS="$max_tenants" EXPECTED_VCPU_CAPACITY="$vcpu_capacity" \
EXPECTED_RAM_TOTAL_MB="$ram_total_mb" EXPECTED_RAM_RESERVE_MB="$ram_reserve_mb" \
EXPECTED_DISK_TOTAL_GB="$disk_total_gb" bash infra/audit-multitenant.sh
REMOTE
}

deploy_one() {
  local host=$1
  local release=$2
  local host_id host_type original_status fields hostname port user
  local max_tenants vcpu_capacity ram_total_mb ram_reserve_mb disk_total_gb
  host_id=$(jq -er .id <<<"$host")
  host_type=$(jq -er .hostType <<<"$host")
  original_status=$(jq -er .status <<<"$host")
  max_tenants=$(jq -er .maxTenants <<<"$host")
  vcpu_capacity=$(jq -er .vcpuCapacity <<<"$host")
  ram_total_mb=$(jq -er .ramTotalMb <<<"$host")
  ram_reserve_mb=$(jq -er .ramReserveMb <<<"$host")
  disk_total_gb=$(jq -er .diskTotalGb <<<"$host")
  fields=$(management_fields "$host")
  IFS=$'\t' read -r hostname port user _ <<<"$fields"

  info "Draining $host_id ($host_type)"
  api PATCH "/api/admin/hosts/$host_id" '{"status":"draining"}' >/dev/null
  host=$(host_json "$host_id")
  if [[ "$(jq -er .activeJobCount <<<"$host")" != "0" ]]; then
    printf 'Host %s remains draining: active jobs did not reach zero.\n' "$host_id" >&2
    return 1
  fi

  info "Verifying management identity for $host_id"
  remote_preflight "$hostname" "$port" "$user" "$host_id" "$host_type"
  info "Backing up release currently on $host_id"
  remote_backup "$hostname" "$port" "$user"
  info "Copying release $release to $host_id"
  rsync_release "$hostname" "$port" "$user"
  remote_install "$hostname" "$port" "$user" "$release" "$host_type" "$host_id" \
    "$max_tenants" "$vcpu_capacity" "$ram_total_mb" "$ram_reserve_mb" "$disk_total_gb"

  info "Probing release $release on $host_id"
  local probe observed
  probe=$(api POST "/api/admin/hosts/$host_id/probe")
  observed=$(jq -er '.host.daemonVersion // empty' <<<"$probe")
  if [[ "$observed" != "$release" ]]; then
    printf 'Host %s remains draining: expected release %s, observed %s.\n' \
      "$host_id" "$release" "${observed:-unknown}" >&2
    return 1
  fi
  if [[ "$original_status" == active ]]; then
    api PATCH "/api/admin/hosts/$host_id" '{"status":"active"}' >/dev/null
    info "$host_id is active on release $release"
  else
    info "$host_id remains draining on release $release (previous state: $original_status)"
  fi
}

deploy_fleet() {
  local selection=""
  local selection_count=0
  local selected_host=""
  local selected_type=""
  local assume_yes=false
  local dry_run=false
  local skip_checks=false
  while (($#)); do
    case "$1" in
      --all) selection=all; selection_count=$(( selection_count + 1 )) ;;
      --host)
        (($# >= 2)) || die "--host requires an ID"
        selection=host
        selection_count=$(( selection_count + 1 ))
        selected_host=$2
        shift
        ;;
      --type)
        (($# >= 2)) || die "--type requires a host type"
        selection=type
        selection_count=$(( selection_count + 1 ))
        selected_type=$2
        shift
        ;;
      --yes|-y) assume_yes=true ;;
      --dry-run) dry_run=true ;;
      --skip-checks) skip_checks=true ;;
      *) die "Unknown deploy option: $1" ;;
    esac
    shift
  done
  (( selection_count == 1 )) || die "deploy requires exactly one of --all, --host, or --type"
  if [[ "$selection" == host ]]; then validate_id "$selected_host"; fi
  if [[ "$selection" == type ]]; then validate_host_type "$selected_type"; fi

  require_command git
  require_command jq
  require_command curl
  require_command ssh
  require_command rsync
  require_clean_release
  local release fleet selected
  release=$(release_id)
  validate_release_id "$release"
  fleet=$(fleet_json)
  case "$selection" in
    all) selected=$(jq -c '.hosts[] | select(.status != "dead")' <<<"$fleet") ;;
    host) selected=$(jq -c --arg id "$selected_host" '.hosts[] | select(.id == $id and .status != "dead")' <<<"$fleet") ;;
    type) selected=$(jq -c --arg type "$selected_type" '.hosts[] | select(.hostType == $type and .status != "dead")' <<<"$fleet") ;;
  esac
  [[ -n "$selected" ]] || die "No hosts matched the deployment selection."

  info "Selected daemon release $release"
  jq -r '[.id, .hostType, .status, (.daemonVersion // "unknown")] | @tsv' <<<"$selected" | \
    format_table
  if [[ "$dry_run" == true ]]; then
    printf '\nDry run: hosts would be drained, backed up, copied, restarted, audited, and probed; only previously active hosts would be reactivated.\n'
    return
  fi
  confirm "Deploy daemon release $release to the selected host(s)?" "$assume_yes"

  if [[ "$skip_checks" == false ]]; then
    info "Running local release gate"
    (cd "$ROOT_DIR" && npm run typecheck && npm run lint && npm test)
  fi

  local failures=0 host deployment_status
  while IFS= read -r host; do
    # A function or subshell used directly as an `if !` condition inherits
    # Bash's conditional errexit exemption. Capture the isolated deployment's
    # status with errexit disabled only in this outer controller instead, so a
    # failed remote install cannot fall through to probing or activation.
    set +e
    (set -Eeuo pipefail; deploy_one "$host" "$release")
    deployment_status=$?
    set -e
    if (( deployment_status != 0 )); then
      failures=$(( failures + 1 ))
    fi
  done <<<"$selected"
  (( failures == 0 )) || die "$failures host deployment(s) failed and remain draining."
}

onboard_host() {
  local host_id=""
  local host_type=""
  local management_host=""
  local management_user=root
  local management_port=22
  local ssh_hostname=""
  local daemon_endpoint=""
  local dedicated_user=""
  local zfs_loop_gb=0
  local pool_name=default
  local ram_reserve_mb=0
  local vcpu_overcommit=$DEFAULT_VCPU_OVERCOMMIT
  local disk_capacity_percent=70
  local tls_cert_path="-"
  local tls_key_path="-"
  local skip_image=false
  local activate=false
  local replace_dead=false
  local assume_yes=false
  local dry_run=false
  local skip_checks=false
  while (($#)); do
    case "$1" in
      --id) host_id=${2:-}; shift ;;
      --type) host_type=${2:-}; shift ;;
      --management-host) management_host=${2:-}; shift ;;
      --management-user) management_user=${2:-}; shift ;;
      --management-port) management_port=${2:-}; shift ;;
      --ssh-hostname) ssh_hostname=${2:-}; shift ;;
      --daemon-endpoint) daemon_endpoint=${2:-}; shift ;;
      --dedicated-user) dedicated_user=${2:-}; shift ;;
      --zfs-loop-gb) zfs_loop_gb=${2:-}; shift ;;
      --pool) pool_name=${2:-}; shift ;;
      --ram-reserve-mb) ram_reserve_mb=${2:-}; shift ;;
      --vcpu-overcommit) vcpu_overcommit=${2:-}; shift ;;
      --disk-capacity-percent) disk_capacity_percent=${2:-}; shift ;;
      --tls-cert-path) tls_cert_path=${2:-}; shift ;;
      --tls-key-path) tls_key_path=${2:-}; shift ;;
      --skip-image) skip_image=true ;;
      --activate) activate=true ;;
      --replace-dead) replace_dead=true ;;
      --yes|-y) assume_yes=true ;;
      --dry-run) dry_run=true ;;
      --skip-checks) skip_checks=true ;;
      *) die "Unknown onboard option: $1" ;;
    esac
    shift
  done

  [[ -n "$host_id" && -n "$host_type" && -n "$management_host" && \
     -n "$ssh_hostname" && -n "$daemon_endpoint" ]] || \
    die "onboard requires --id, --type, --management-host, --ssh-hostname, and --daemon-endpoint"
  validate_id "$host_id"
  validate_host_type "$host_type"
  [[ "$management_host" =~ ^[A-Za-z0-9._:-]+$ ]] || die "Invalid management hostname"
  [[ "$management_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid management user"
  [[ "$management_port" =~ ^[0-9]+$ ]] && (( management_port >= 1 && management_port <= 65535 )) || \
    die "Invalid management port"
  [[ "$ssh_hostname" =~ ^[A-Za-z0-9._:-]+$ ]] || die "Invalid tenant SSH hostname"
  [[ "$daemon_endpoint" =~ ^https://[^/?#]+$ ]] || \
    die "Daemon endpoint must be an HTTPS origin without a trailing slash"
  [[ "$zfs_loop_gb" =~ ^[0-9]+$ ]] || die "Invalid --zfs-loop-gb"
  [[ "$pool_name" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid pool name"
  [[ "$ram_reserve_mb" =~ ^[0-9]+$ ]] || die "Invalid --ram-reserve-mb"
  [[ "$vcpu_overcommit" =~ ^[0-9]+$ ]] && \
    (( vcpu_overcommit >= 1 && vcpu_overcommit <= MAX_VCPU_OVERCOMMIT )) || \
    die "Invalid --vcpu-overcommit (expected 1-$MAX_VCPU_OVERCOMMIT)"
  [[ "$disk_capacity_percent" =~ ^[0-9]+$ ]] && \
    (( disk_capacity_percent >= 1 && disk_capacity_percent <= 90 )) || \
    die "Invalid --disk-capacity-percent"
  if [[ "$host_type" != dedicated && -n "$dedicated_user" ]]; then
    die "--dedicated-user is valid only for dedicated hosts"
  fi
  if [[ "$host_type" == dedicated && "$activate" == true && -z "$dedicated_user" ]]; then
    die "--activate on a dedicated host requires --dedicated-user"
  fi
  if { [[ "$tls_cert_path" == "-" ]] && [[ "$tls_key_path" != "-" ]]; } || \
     { [[ "$tls_cert_path" != "-" ]] && [[ "$tls_key_path" == "-" ]]; }; then
    die "--tls-cert-path and --tls-key-path must be supplied together"
  fi
  if [[ "$tls_cert_path" != "-" ]]; then
    [[ "$tls_cert_path" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "Invalid TLS certificate path"
    [[ "$tls_key_path" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "Invalid TLS key path"
  fi

  require_command git
  require_command jq
  require_command curl
  require_command ssh
  require_command rsync
  require_clean_release
  if [[ -z "${WORKER_RPC_PUBLIC_KEY:-}" ]]; then
    [[ -t 0 ]] || die "WORKER_RPC_PUBLIC_KEY is required for onboard."
    read -r -p "WORKER_RPC_PUBLIC_KEY: " WORKER_RPC_PUBLIC_KEY
  fi
  [[ "$WORKER_RPC_PUBLIC_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]] || \
    die "Worker RPC public key must be a 32-byte base64 key"
  local existing_host
  existing_host=$(fleet_json | jq -c --arg id "$host_id" '.hosts[] | select(.id == $id)' || true)
  if [[ -n "$existing_host" ]]; then
    [[ "$replace_dead" == true ]] || die "Host ID is already registered: $host_id"
    [[ "$(jq -er .status <<<"$existing_host")" == dead && \
       "$(jq -er .tenantCount <<<"$existing_host")" == 0 ]] || \
      die "--replace-dead requires an evacuated, empty dead host ID"
  elif [[ "$replace_dead" == true ]]; then
    die "--replace-dead requires an existing dead host ID"
  fi

  local release
  release=$(release_id)
  validate_release_id "$release"
  info "Onboarding $host_id as $host_type on release $release"
  if [[ "$dry_run" == true ]]; then
    printf 'Would copy, bootstrap, %sbuild image, audit, register draining, probe, and %sactivate.\n' \
      "$([[ "$skip_image" == true ]] && printf 'not ' || true)" \
      "$([[ "$activate" == true ]] && printf '' || printf 'not ')"
    return
  fi
  confirm "Bootstrap and register $host_id?" "$assume_yes"

  if [[ "$skip_checks" == false ]]; then
    info "Running local release gate"
    (cd "$ROOT_DIR" && npm run typecheck && npm run lint && npm test)
  fi

  info "Preparing remote release transport"
  ssh_root_run "$management_host" "$management_port" "$management_user" bash -s <<'REMOTE'
set -Eeuo pipefail
if ! command -v rsync >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq rsync
fi
REMOTE
  rsync_release "$management_host" "$management_port" "$management_user"
  ssh_root_run "$management_host" "$management_port" "$management_user" bash -s -- \
    "$host_id" "$host_type" "$WORKER_RPC_PUBLIC_KEY" "$zfs_loop_gb" "$pool_name" \
    "$tls_cert_path" "$tls_key_path" "$release" "$skip_image" "$ram_reserve_mb" \
    "$vcpu_overcommit" "$disk_capacity_percent" <<'REMOTE'
set -Eeuo pipefail
host_id=$1
host_type=$2
worker_public_key=$3
zfs_loop_gb=$4
pool_name=$5
tls_cert_path=$6
tls_key_path=$7
release_id=$8
skip_image=$9
ram_reserve_mb=${10}
vcpu_overcommit=${11}
disk_capacity_percent=${12}
export HOST_ID="$host_id" HOST_TYPE="$host_type" WORKER_RPC_PUBLIC_KEY="$worker_public_key"
export ZFS_LOOP_GB="$zfs_loop_gb" POOL_NAME="$pool_name" DAEMON_VERSION="$release_id"
export HOST_RAM_RESERVE_MB="$ram_reserve_mb" VCPU_OVERCOMMIT="$vcpu_overcommit"
export DISK_CAPACITY_PERCENT="$disk_capacity_percent"
if [[ "$tls_cert_path" != "-" ]]; then
  export TLS_CERT_PATH="$tls_cert_path" TLS_KEY_PATH="$tls_key_path"
fi
cd /opt/workbench
bash infra/bootstrap.sh
if [[ "$skip_image" != true ]]; then
  bash infra/build-image.sh
fi
bash infra/audit-multitenant.sh
REMOTE

  local public_registration registration
  public_registration=$(ssh_root_run "$management_host" "$management_port" "$management_user" \
    "jq -c . /etc/workbench/registration.json")
  registration=$(printf '%s\n' "$public_registration" | jq -c \
    --arg sshHostname "$ssh_hostname" \
    --arg daemonEndpoint "$daemon_endpoint" \
    --arg managementHostname "$management_host" \
    --arg managementUser "$management_user" \
    --argjson managementPort "$management_port" \
    --arg dedicatedUserId "$dedicated_user" \
    '. + {
      sshHostname: $sshHostname,
      daemonEndpoint: $daemonEndpoint,
      managementHostname: $managementHostname,
      managementPort: $managementPort,
      managementUser: $managementUser
    } + (if $dedicatedUserId == "" then {} else {dedicatedUserId: $dedicatedUserId} end)'
    <<<"$public_registration")
  if [[ "$replace_dead" == true ]]; then
    api PUT "/api/admin/hosts/$host_id" "$registration" >/dev/null
  else
    api POST /api/admin/hosts "$registration" >/dev/null
  fi
  info "Registered $host_id as draining; performing signed probe"
  probe_host "$host_id" >/dev/null
  if [[ "$activate" == true ]]; then
    set_host_state "$host_id" active >/dev/null
    info "$host_id is active"
  else
    info "$host_id remains draining; run: npm run hostctl -- state $host_id active"
  fi
}

main() {
  local command=${1:-}
  [[ -n "$command" ]] || { usage; exit 1; }
  shift || true
  if [[ "$command" == --help || "$command" == -h || "$command" == help ]]; then
    usage
    return
  fi
  require_command curl
  require_command jq
  case "$command" in
    list) (($# == 0)) || die "list takes no arguments"; list_hosts ;;
    probe) (($# == 1)) || die "probe requires HOST_ID"; probe_host "$1" ;;
    state)
      (($# >= 2)) || die "state requires HOST_ID and active|draining|dead"
      local state_host=$1
      local requested_state=$2
      shift 2
      local force=false
      local assume_yes=false
      while (($#)); do
        case "$1" in
          --force) force=true ;;
          --yes|-y) assume_yes=true ;;
          *) die "Unknown state option: $1" ;;
        esac
        shift
      done
      if [[ "$force" == true ]]; then
        [[ "$requested_state" == dead ]] || die "--force is valid only with state dead"
        confirm "Force-retire $state_host? All recoverable tenants will be destructively re-provisioned and host-local home data will be lost." \
          "$assume_yes"
      fi
      set_host_state "$state_host" "$requested_state" "$force"
      ;;
    history) (($# == 1)) || die "history requires HOST_ID"; show_host_history "$1" ;;
    rehome) rehome_container "$@" ;;
    reclass) reclass_host "$@" ;;
    remove) remove_host "$@" ;;
    assign) (($# == 2)) || die "assign requires HOST_ID and USER_ID|none"; assign_dedicated_host "$1" "$2" ;;
    configure) configure_host "$@" ;;
    audit) (($# == 1)) || die "audit requires HOST_ID"; audit_host "$1" ;;
    capacity) refresh_host_capacity "$@" ;;
    onboard) onboard_host "$@" ;;
    deploy) deploy_fleet "$@" ;;
    *) die "Unknown command: $command (run npm run hostctl -- --help)" ;;
  esac
}

main "$@"
