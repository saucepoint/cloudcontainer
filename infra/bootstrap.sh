#!/usr/bin/env bash
# Codestation host bootstrap (SPEC §10 host lifecycle). Run as root on a fresh
# Debian 12/13 machine (Hetzner dedicated or any dev box/VM). Idempotent-ish:
# safe to re-run after fixing a failure.
#
# Usage:  HOST_ID=hetzner-fsn-1 WORKER_RPC_PUBLIC_KEY=<b64> bash infra/bootstrap.sh
#         (WORKER_RPC_PUBLIC_KEY prompted interactively if unset)
#
# What it does:
#   1. Installs Incus, Node.js 22, nftables.
#   2. Creates a ZFS-backed (or dir-backed fallback) Incus storage pool.
#   3. Applies the nftables baseline: outbound port 25 blocked, per-source
#      connection-rate limit.
#   4. Installs the daemon under /opt/codestation + systemd unit.
#   5. Generates the daemon X25519 keypair and TLS cert; prints the SQL to
#      register the host row in D1.
set -euo pipefail

HOST_ID="${HOST_ID:-host-$(hostname -s)}"
DAEMON_PORT="${DAEMON_PORT:-8443}"
POOL_NAME="${POOL_NAME:-default}"
REPO_DIR="${REPO_DIR:-/opt/codestation}"
ZFS_LOOP_GB="${ZFS_LOOP_GB:-0}"   # >0: create a file-backed zpool of this size (dev boxes)

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
if ! incus profile show default >/dev/null 2>&1; then
  incus admin init --minimal
fi
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
    incus storage create "$POOL_NAME" zfs source="$(zpool list -H -o name | head -1)/codestation"
  else
    echo "!! no ZFS available — falling back to dir pool (no quotas!). Set ZFS_LOOP_GB=40 for a file-backed pool."
    incus storage create "$POOL_NAME" dir
  fi
fi
# NOTE (spec §10): production hosts should use ZFS native encryption. Create the
# pool with `zpool create -O encryption=on -O keyformat=passphrase ...` before
# running this script and document key handling in your ops runbook.

# Repair a default profile left empty by an interrupted `incus admin init`
# (seen when stdin was piped into it): ensure root disk + bridge NIC exist.
if ! incus profile show default | grep -q 'type: disk'; then
  incus network show incusbr0 >/dev/null 2>&1 || incus network create incusbr0
  incus profile device add default root disk path=/ pool="$POOL_NAME"
  incus profile device add default eth0 nic network=incusbr0 name=eth0
fi

echo "== [3/6] nftables baseline =="
mkdir -p /etc/nftables.d
cat >/etc/nftables.d/codestation.nft <<'NFT'
table inet codestation {
  chain forward {
    type filter hook forward priority 0; policy accept;
    # No outbound SMTP from tenant containers, ever (spec §10 networking).
    tcp dport 25 drop
    # Blunt scanning/brute-force: cap new outbound connections per source.
    ct state new meter cs-connrate { ip saddr limit rate over 60/second } drop
  }
}
NFT
grep -q 'include "/etc/nftables.d/' /etc/nftables.conf 2>/dev/null || \
  echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
systemctl enable --now nftables
systemctl reload nftables || systemctl restart nftables

echo "== [4/6] daemon install =="
mkdir -p "$REPO_DIR" /etc/codestation
if [[ ! -f "$REPO_DIR/package.json" ]]; then
  echo "!! copy the repo to $REPO_DIR first (rsync -a --exclude node_modules ./ host:$REPO_DIR/) then re-run"
  exit 1
fi
(cd "$REPO_DIR" && npm install --omit=dev --workspaces --include-workspace-root >/dev/null)

echo "== [5/6] keys + config =="
if [[ ! -f /etc/codestation/daemon.json ]]; then
  WORKER_PUB="${WORKER_RPC_PUBLIC_KEY:-}"
  [[ -n "$WORKER_PUB" ]] || read -rp "WORKER_RPC_PUBLIC_KEY (from scripts/genkeys.ts): " WORKER_PUB
  KEYS_JSON=$(cd "$REPO_DIR" && ./node_modules/.bin/tsx apps/daemon/scripts/genhostkey.ts)
  X25519_PRIV=$(echo "$KEYS_JSON" | jq -r .privateKey)
  X25519_PUB=$(echo "$KEYS_JSON" | jq -r .publicKey)

  # Self-signed TLS for the daemon endpoint; the Worker additionally signs every
  # request, and production should front this with mTLS (Workers mTLS binding).
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout /etc/codestation/daemon.key -out /etc/codestation/daemon.crt \
    -days 1825 -subj "/CN=${HOST_ID}" >/dev/null 2>&1

  cat >/etc/codestation/daemon.json <<EOF
{
  "hostId": "${HOST_ID}",
  "listenPort": ${DAEMON_PORT},
  "workerRpcPublicKey": "${WORKER_PUB}",
  "x25519PrivateKey": "${X25519_PRIV}",
  "baseImage": "codestation-base",
  "storagePool": "${POOL_NAME}",
  "tlsCertPath": "/etc/codestation/daemon.crt",
  "tlsKeyPath": "/etc/codestation/daemon.key"
}
EOF
  chmod 600 /etc/codestation/daemon.json /etc/codestation/daemon.key
  echo "$X25519_PUB" > /etc/codestation/daemon.x25519.pub
fi

cp "$REPO_DIR/apps/daemon/systemd/codestation-daemon.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now codestation-daemon

echo "== [6/6] register host =="
IPV4=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
CERT_FP=$(openssl x509 -in /etc/codestation/daemon.crt -noout -fingerprint -sha256 | cut -d= -f2)
X25519_PUB=$(cat /etc/codestation/daemon.x25519.pub)
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
# Reserve 20% for host/incus overhead, then 25% of the remainder for upgrades (§10).
RAM_USABLE=$(( RAM_MB * 80 / 100 ))
RAM_RESERVE=$(( RAM_USABLE * 25 / 100 ))
DISK_GB=$(incus storage info "$POOL_NAME" 2>/dev/null | awk '/total space/ {print int($NF)}' || echo 100)

cat <<EOF

============================================================
Host bootstrapped. Next steps:

1. Build the base image (one-off, ~5 min):
     bash $REPO_DIR/infra/build-image.sh

2. Register this host in D1 (run from your repo checkout):

   npx wrangler d1 execute codestation --remote --command "
   INSERT INTO hosts (id, ipv4, ssh_hostname, daemon_endpoint, daemon_cert_fp,
     daemon_pubkey, ram_total_mb, ram_reserve_mb, disk_total_gb, status, joined_at)
   VALUES ('${HOST_ID}', '${IPV4}', '${IPV4}', 'https://${IPV4}:${DAEMON_PORT}',
     '${CERT_FP}', '${X25519_PUB}', ${RAM_USABLE}, ${RAM_RESERVE}, ${DISK_GB:-100},
     'active', $(date +%s)000);"

   (set ssh_hostname to a DNS name if you have one)

3. IMPORTANT: a deployed Worker cannot fetch https://<ip> (Cloudflare
   error 1003) or a self-signed cert. Before real use, give the daemon a
   hostname + Let's Encrypt cert and update daemon_endpoint — see
   "Daemon endpoint TLS" in infra/RUNBOOK.md.
============================================================
EOF
