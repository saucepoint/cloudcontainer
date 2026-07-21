#!/usr/bin/env bash
# Workbench host bootstrap (SPEC §10 host lifecycle). Run as root on a fresh
# Debian 12/13 machine (Hetzner dedicated or any dev box/VM). Idempotent-ish:
# safe to re-run after fixing a failure.
#
# Usage:  HOST_ID=hetzner-fsn-1 WORKER_RPC_PUBLIC_KEY=<b64> bash infra/bootstrap.sh
#         (WORKER_RPC_PUBLIC_KEY prompted interactively if unset)
#
# What it does:
#   1. Installs Incus, Node.js 22, nftables.
#   2. Creates a quota-capable storage pool and a restricted tenant project.
#   3. Applies the nftables baseline: outbound port 25 blocked, per-source
#      connection-rate limit for IPv4 and IPv6.
#   4. Installs the daemon under /opt/workbench + systemd unit.
#   5. Generates the daemon X25519 keypair and TLS cert; prints the SQL to
#      register the host row in D1.
set -euo pipefail

HOST_ID="${HOST_ID:-host-$(hostname -s)}"
DAEMON_PORT="${DAEMON_PORT:-8443}"
POOL_NAME="${POOL_NAME:-default}"
PROJECT_NAME="${PROJECT_NAME:-workbench}"
NETWORK_NAME="${NETWORK_NAME:-incusbr0}"
REPO_DIR="${REPO_DIR:-/opt/workbench}"
ZFS_LOOP_GB="${ZFS_LOOP_GB:-0}"   # >0: create a file-backed zpool of this size (dev boxes)
ALLOW_DIR_STORAGE="${ALLOW_DIR_STORAGE:-0}" # dev-only escape hatch; dir cannot enforce quotas
DISK_CAPACITY_PERCENT="${DISK_CAPACITY_PERCENT:-70}"
VCPU_OVERCOMMIT="${VCPU_OVERCOMMIT:-3}"
TENANT_PROCESS_LIMIT="${TENANT_PROCESS_LIMIT:-1024}"
TENANT_NETWORK_LIMIT="${TENANT_NETWORK_LIMIT:-100Mbit}"

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
# shellcheck source=infra/configure-multitenant.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/configure-multitenant.sh"

echo "== [3/6] nftables baseline =="
mkdir -p /etc/nftables.d
cat >/etc/nftables.d/workbench.nft <<'NFT'
table inet workbench {
  chain forward {
    type filter hook forward priority 0; policy accept;
    # No outbound SMTP from tenant containers, ever (spec §10 networking).
    tcp dport 25 drop
    # Blunt scanning/brute-force: cap new outbound connections per source.
    meta nfproto ipv4 ct state new meter wb-v4-connrate { ip saddr limit rate over 60/second } drop
    meta nfproto ipv6 ct state new meter wb-v6-connrate { ip6 saddr limit rate over 60/second } drop
  }
}
NFT
grep -q 'include "/etc/nftables.d/' /etc/nftables.conf 2>/dev/null || \
  echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
systemctl enable --now nftables
systemctl reload nftables || systemctl restart nftables

echo "== [4/6] daemon install =="
mkdir -p "$REPO_DIR" /etc/workbench
if [[ ! -f "$REPO_DIR/package.json" ]]; then
  echo "!! copy the repo to $REPO_DIR first (rsync -a --exclude node_modules ./ host:$REPO_DIR/) then re-run"
  exit 1
fi
(cd "$REPO_DIR" && npm install --omit=dev --workspaces --include-workspace-root >/dev/null)

echo "== [5/6] keys + config =="
if [[ ! -f /etc/workbench/daemon.json ]]; then
  WORKER_PUB="${WORKER_RPC_PUBLIC_KEY:-}"
  [[ -n "$WORKER_PUB" ]] || read -rp "WORKER_RPC_PUBLIC_KEY (from scripts/genkeys.ts): " WORKER_PUB
  KEYS_JSON=$(cd "$REPO_DIR" && ./node_modules/.bin/tsx apps/daemon/scripts/genhostkey.ts)
  X25519_PRIV=$(echo "$KEYS_JSON" | jq -r .privateKey)
  X25519_PUB=$(echo "$KEYS_JSON" | jq -r .publicKey)

  # Self-signed TLS for the daemon endpoint; the Worker additionally signs every
  # request, and production should front this with mTLS (Workers mTLS binding).
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout /etc/workbench/daemon.key -out /etc/workbench/daemon.crt \
    -days 1825 -subj "/CN=${HOST_ID}" >/dev/null 2>&1

  cat >/etc/workbench/daemon.json <<EOF
{
  "hostId": "${HOST_ID}",
  "listenPort": ${DAEMON_PORT},
  "workerRpcPublicKey": "${WORKER_PUB}",
  "x25519PrivateKey": "${X25519_PRIV}",
  "baseImage": "workbench-base",
  "storagePool": "${POOL_NAME}",
  "project": "${PROJECT_NAME}",
  "tlsCertPath": "/etc/workbench/daemon.crt",
  "tlsKeyPath": "/etc/workbench/daemon.key"
}
EOF
  chmod 600 /etc/workbench/daemon.json /etc/workbench/daemon.key
  echo "$X25519_PUB" > /etc/workbench/daemon.x25519.pub
fi

cp "$REPO_DIR/apps/daemon/systemd/workbench-daemon.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now workbench-daemon

echo "== [6/6] register host =="
IPV4=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
CERT_FP=$(openssl x509 -in /etc/workbench/daemon.crt -noout -fingerprint -sha256 | cut -d= -f2)
X25519_PUB=$(cat /etc/workbench/daemon.x25519.pub)
cat <<EOF

============================================================
Host bootstrapped. Next steps:

1. Build the base image (one-off, ~5 min):
     bash $REPO_DIR/infra/build-image.sh

2. Register this host in D1 (run from your repo checkout):

   npx wrangler d1 execute codestation --remote --command "
   INSERT INTO hosts (id, ipv4, ssh_hostname, daemon_endpoint, daemon_cert_fp,
     daemon_pubkey, ram_total_mb, ram_reserve_mb, vcpu_capacity,
     disk_total_gb, status, joined_at, last_seen_at)
   VALUES ('${HOST_ID}', '${IPV4}', '${IPV4}', 'https://${IPV4}:${DAEMON_PORT}',
     '${CERT_FP}', '${X25519_PUB}', ${RAM_USABLE}, ${RAM_RESERVE}, ${VCPU_CAPACITY},
     ${DISK_GB}, 'draining', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
     CAST(strftime('%s', 'now') AS INTEGER) * 1000);"

   (set ssh_hostname to a DNS name if you have one)

3. IMPORTANT: a deployed Worker cannot fetch https://<ip> (Cloudflare
   error 1003) or a self-signed cert. Before real use, give the daemon a
   hostname + Let's Encrypt cert and update daemon_endpoint — see
   "Daemon endpoint TLS" in infra/RUNBOOK.md.

4. After the signed health/stats checks pass, make the host eligible:
     UPDATE hosts SET status = 'active' WHERE id = '${HOST_ID}';

Capacity: ${TENANT_SLOTS} tenant(s), ${VCPU_CAPACITY} vCPU reservations,
${RAM_CAPACITY_MB} MiB allocatable RAM, ${DISK_GB} GiB safe pool capacity.
============================================================
EOF
