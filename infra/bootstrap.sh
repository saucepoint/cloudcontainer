#!/usr/bin/env bash
# Workbench host bootstrap (SPEC §10 host lifecycle). Run as root on a fresh
# Debian 12/13 machine (Hetzner dedicated or any dev box/VM). Idempotent-ish:
# safe to re-run after fixing a failure.
#
# Usage:  HOST_ID=budget-fsn-1 HOST_TYPE=budget \
#         WORKER_RPC_PUBLIC_KEY=<b64> bash infra/bootstrap.sh
#         (WORKER_RPC_PUBLIC_KEY prompted interactively if unset)
#
# What it does:
#   1. Installs Incus, Node.js 22, nftables.
#   2. Creates a quota-capable storage pool and a restricted tenant project.
#   3. Applies the nftables baseline: outbound port 25 blocked, per-source
#      connection-rate limit for IPv4 and IPv6.
#   4. Installs the daemon under /opt/workbench + systemd unit.
#   5. Generates the daemon X25519 keypair and TLS cert, then writes public
#      registration metadata for the fleet controller.
set -euo pipefail

: "${HOST_TYPE:?HOST_TYPE must be budget, regular, or dedicated}"
HOST_ID="${HOST_ID:-host-$(hostname -s)}"
DAEMON_PORT="${DAEMON_PORT:-8443}"
POOL_NAME="${POOL_NAME:-}"
PROJECT_NAME="${PROJECT_NAME:-}"
NETWORK_NAME="${NETWORK_NAME:-incusbr0}"
REPO_DIR="${REPO_DIR:-/opt/workbench}"
ZFS_LOOP_GB="${ZFS_LOOP_GB:-0}"   # >0: create a file-backed zpool of this size (dev boxes)
ALLOW_DIR_STORAGE="${ALLOW_DIR_STORAGE:-0}" # dev-only escape hatch; dir cannot enforce quotas
DAEMON_VERSION="${DAEMON_VERSION:-bootstrap}"
# shellcheck source=infra/host-policy.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/host-policy.sh"

echo "== [1/6] packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates nftables jq rsync openssl dnsmasq-base

if ! command -v incus >/dev/null; then
  apt-get install -y -qq incus
fi

if ! command -v node >/dev/null || [[ "$(node --version | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if [[ -f /etc/workbench/daemon.json ]]; then
  POOL_NAME="${POOL_NAME:-$(jq -er '.storagePool // "default"' /etc/workbench/daemon.json)}"
  PROJECT_NAME="${PROJECT_NAME:-$(jq -er '.project // "workbench"' /etc/workbench/daemon.json)}"
fi
POOL_NAME="${POOL_NAME:-default}"
PROJECT_NAME="${PROJECT_NAME:-workbench}"
[[ "$HOST_ID" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || {
  echo "!! HOST_ID must contain only lowercase letters, digits, and hyphens" >&2
  exit 1
}
[[ "$DAEMON_PORT" =~ ^[0-9]+$ ]] && (( DAEMON_PORT >= 1 && DAEMON_PORT <= 65535 )) || {
  echo "!! DAEMON_PORT must be an integer from 1 through 65535" >&2
  exit 1
}
[[ "$POOL_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "!! invalid POOL_NAME" >&2
  exit 1
}
[[ "$PROJECT_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "!! invalid PROJECT_NAME" >&2
  exit 1
}
[[ "$NETWORK_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "!! invalid NETWORK_NAME" >&2
  exit 1
}
[[ "$ZFS_LOOP_GB" =~ ^[0-9]+$ ]] || {
  echo "!! ZFS_LOOP_GB must be a non-negative integer" >&2
  exit 1
}
[[ "$DAEMON_VERSION" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || {
  echo "!! DAEMON_VERSION contains unsupported characters" >&2
  exit 1
}

echo "== [2/6] incus init + storage =="
if ! incus storage show "$POOL_NAME" >/dev/null 2>&1; then
  if [[ "$ZFS_LOOP_GB" -gt 0 ]]; then
    apt-get install -y -qq zfsutils-linux || true
    if ! modprobe zfs 2>/dev/null; then
      echo "!! zfs kernel module missing (cloud kernels ship without it)."
      echo "   Fix: apt-get install linux-image-cloud-amd64 linux-headers-cloud-amd64 zfs-dkms && reboot, then re-run."
      exit 1
    fi
    incus storage create "$POOL_NAME" zfs size="${ZFS_LOOP_GB}GiB"
  elif command -v zpool >/dev/null && zpool list -H -o name 2>/dev/null | grep -q .; then
    incus storage create "$POOL_NAME" zfs source="$(zpool list -H -o name | head -1)/workbench"
  elif [[ "$ALLOW_DIR_STORAGE" == "1" ]]; then
    echo "!! creating a development-only dir pool; tenant disk quotas are not enforceable"
    incus storage create "$POOL_NAME" dir
  else
    echo "!! refusing to create a dir pool because it cannot enforce tenant disk quotas."
    echo "   Provide a ZFS pool, set ZFS_LOOP_GB for a development loop pool, or explicitly set ALLOW_DIR_STORAGE=1."
    exit 1
  fi
fi
# NOTE (spec §10): production hosts should use ZFS native encryption. Create the
# pool with `zpool create -O encryption=on -O keyformat=passphrase ...` before
# running this script and document key handling in your ops runbook.

# Source the same policy entry point used to upgrade an existing drained host.
# It leaves the calculated capacity variables available for D1 registration.
# Persist non-secret per-host overrides so every later deploy and audit derives
# the same ceilings instead of silently reverting to controller defaults.
install -d -m 0755 /etc/workbench
install -m 0644 /dev/null /etc/workbench/host-policy.env
cat >/etc/workbench/host-policy.env <<EOF
VCPU_OVERCOMMIT=${VCPU_OVERCOMMIT}
DISK_CAPACITY_PERCENT=${DISK_CAPACITY_PERCENT}
HOST_RAM_RESERVE_MB=${HOST_RAM_RESERVE_MB:-0}
EOF
# shellcheck source=infra/configure-multitenant.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/configure-multitenant.sh"

echo "== [3/6] nftables baseline =="
mkdir -p /etc/nftables.d
cat >/etc/nftables.d/workbench.nft <<'NFT'
table inet workbench {
  set wb-v4-connrate {
    type ipv4_addr
    size 65535
    flags dynamic,timeout
    timeout 60s
  }
  set wb-v6-connrate {
    type ipv6_addr
    size 65535
    flags dynamic,timeout
    timeout 60s
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
    # No outbound SMTP from tenant containers, ever (spec §10 networking).
    tcp dport 25 drop
    # Blunt scanning/brute-force: cap new outbound connections per source.
    meta nfproto ipv4 ct state new update @wb-v4-connrate { ip saddr limit rate 60/second burst 5 packets } accept
    meta nfproto ipv6 ct state new update @wb-v6-connrate { ip6 saddr limit rate 60/second burst 5 packets } accept
    ct state new drop
  }
}
NFT
grep -q 'include "/etc/nftables.d/' /etc/nftables.conf 2>/dev/null || \
  echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
systemctl enable --now nftables
systemctl reload nftables || systemctl restart nftables

# Debian's nftables unit reloads the full ruleset, which removes Incus's
# dynamically managed NAT/firewall table. Start Incus after nftables so its
# bridge rules are restored and remain correct across reboots.
install -d -m 0755 /etc/systemd/system/incus.service.d
cat >/etc/systemd/system/incus.service.d/workbench-nftables.conf <<'UNIT'
[Unit]
Wants=nftables.service
After=nftables.service
UNIT
systemctl daemon-reload
systemctl restart incus

echo "== [4/6] daemon install =="
mkdir -p "$REPO_DIR" /etc/workbench
if [[ ! -f "$REPO_DIR/package.json" ]]; then
  echo "!! copy the repo to $REPO_DIR first (rsync -a --exclude node_modules ./ host:$REPO_DIR/) then re-run"
  exit 1
fi
(cd "$REPO_DIR" && npm ci --omit=dev --workspaces --include-workspace-root >/dev/null)

echo "== [5/6] keys + config =="
if [[ -f /etc/workbench/daemon.json ]]; then
  if ! jq -e --arg host_id "$HOST_ID" --arg host_type "$HOST_TYPE" \
    '.hostId == $host_id and (.hostType // "budget") == $host_type' \
    /etc/workbench/daemon.json >/dev/null; then
    echo "!! existing daemon config belongs to another host ID or host type"
    exit 1
  fi
else
  WORKER_PUB="${WORKER_RPC_PUBLIC_KEY:-}"
  [[ -n "$WORKER_PUB" ]] || read -rp "WORKER_RPC_PUBLIC_KEY (from scripts/genkeys.ts): " WORKER_PUB
  [[ "$WORKER_PUB" =~ ^[A-Za-z0-9+/]{43}=$ ]] || {
    echo "!! WORKER_RPC_PUBLIC_KEY must be a 32-byte base64 key" >&2
    exit 1
  }
  KEYS_JSON=$(cd "$REPO_DIR" && ./node_modules/.bin/tsx apps/daemon/scripts/genhostkey.ts)
  X25519_PRIV=$(echo "$KEYS_JSON" | jq -r .privateKey)
  X25519_PUB=$(echo "$KEYS_JSON" | jq -r .publicKey)

  TLS_CERT_PATH="${TLS_CERT_PATH:-/etc/workbench/daemon.crt}"
  TLS_KEY_PATH="${TLS_KEY_PATH:-/etc/workbench/daemon.key}"
  if [[ -n "${TLS_CERT_PATH:-}" && -n "${TLS_KEY_PATH:-}" && \
    -f "$TLS_CERT_PATH" && -f "$TLS_KEY_PATH" ]]; then
    : # Use operator-provisioned trusted TLS material.
  elif [[ "$TLS_CERT_PATH" == "/etc/workbench/daemon.crt" && \
    "$TLS_KEY_PATH" == "/etc/workbench/daemon.key" ]]; then
    # Development-only bootstrap certificate. A Worker probe will fail until
    # the operator replaces it with a publicly trusted certificate.
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -keyout "$TLS_KEY_PATH" -out "$TLS_CERT_PATH" \
      -days 30 -subj "/CN=${HOST_ID}" >/dev/null 2>&1
  else
    echo "!! TLS_CERT_PATH and TLS_KEY_PATH must both name existing host files"
    exit 1
  fi

  jq -n \
    --arg hostId "$HOST_ID" \
    --arg hostType "$HOST_TYPE" \
    --argjson listenPort "$DAEMON_PORT" \
    --arg workerRpcPublicKey "$WORKER_PUB" \
    --arg x25519PrivateKey "$X25519_PRIV" \
    --arg storagePool "$POOL_NAME" \
    --arg project "$PROJECT_NAME" \
    --arg tlsCertPath "$TLS_CERT_PATH" \
    --arg tlsKeyPath "$TLS_KEY_PATH" \
    '{hostId: $hostId, hostType: $hostType, listenPort: $listenPort,
      workerRpcPublicKey: $workerRpcPublicKey,
      x25519PrivateKey: $x25519PrivateKey, baseImage: "workbench-base",
      storagePool: $storagePool, project: $project,
      tlsCertPath: $tlsCertPath, tlsKeyPath: $tlsKeyPath}' \
    > /etc/workbench/daemon.json
  chmod 600 /etc/workbench/daemon.json "$TLS_KEY_PATH"
  echo "$X25519_PUB" > /etc/workbench/daemon.x25519.pub
fi

install -m 0644 /dev/null /etc/workbench/release.env
printf 'WB_DAEMON_VERSION=%s\n' "$DAEMON_VERSION" > /etc/workbench/release.env

cp "$REPO_DIR/apps/daemon/systemd/workbench-daemon.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now workbench-daemon
systemctl restart workbench-daemon

echo "== [6/6] register host =="
IPV4=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '
  { for (field = 1; field <= NF; field += 1) if ($field == "src") { print $(field + 1); exit } }
')
[[ -n "$IPV4" ]] || {
  echo "!! could not detect the host's routed IPv4 address" >&2
  exit 1
}
TLS_CERT_PATH=$(jq -r .tlsCertPath /etc/workbench/daemon.json)
CERT_FP=$(openssl x509 -in "$TLS_CERT_PATH" -noout -fingerprint -sha256 | cut -d= -f2)
X25519_PUB=$(cat /etc/workbench/daemon.x25519.pub)
REGISTRATION_PATH=/etc/workbench/registration.json
jq -n \
  --arg id "$HOST_ID" \
  --arg hostType "$HOST_TYPE" \
  --arg ipv4 "$IPV4" \
  --arg daemonCertFingerprint "$CERT_FP" \
  --arg daemonPublicKey "$X25519_PUB" \
  --argjson ramTotalMb "$RAM_TOTAL_MB" \
  --argjson ramReserveMb "$RAM_RESERVE" \
  --argjson vcpuCapacity "$VCPU_CAPACITY" \
  --argjson diskTotalGb "$DISK_GB" \
  --argjson maxTenants "$TENANT_SLOTS" \
  '{id: $id, hostType: $hostType, ipv4: $ipv4,
    daemonCertFingerprint: $daemonCertFingerprint,
    daemonPublicKey: $daemonPublicKey, ramTotalMb: $ramTotalMb,
    ramReserveMb: $ramReserveMb, vcpuCapacity: $vcpuCapacity,
    diskTotalGb: $diskTotalGb, maxTenants: $maxTenants}' \
  > "$REGISTRATION_PATH"
chmod 0644 "$REGISTRATION_PATH"
cat <<EOF

============================================================
Host bootstrapped. Next steps:

1. Build the base image (one-off, ~5 min):
     bash $REPO_DIR/infra/build-image.sh

2. Register this host through the fleet controller. Bootstrap metadata is at:
     $REGISTRATION_PATH

   The normal path is \`npm run hostctl -- onboard ...\`, which copies this
   metadata to the control plane, probes the signed daemon endpoint, and only
   activates the host after every check succeeds.

3. IMPORTANT: a deployed Worker cannot fetch https://<ip> (Cloudflare
   error 1003) or a self-signed cert. Before real use, give the daemon a
   hostname + Let's Encrypt cert and update daemon_endpoint — see
   "Daemon endpoint TLS" in infra/RUNBOOK.md.

4. Do not activate the host with raw SQL. Use the controller probe and state
   transition so an unverified host cannot receive a tenant.

Class: ${HOST_TYPE}; tier: ${TENANT_TIER}; policy: ${WORKBENCH_POLICY_VERSION}.
Capacity: ${TENANT_SLOTS} tenant(s), ${VCPU_CAPACITY} vCPU reservations,
${RAM_CAPACITY_MB} MiB allocatable RAM, ${DISK_GB} GiB safe pool capacity.
============================================================
EOF
