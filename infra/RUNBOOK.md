# Host bootstrap runbook

Adding a host to Codestation is **this runbook plus one `hosts` row** — no
dashboard or daemon code changes (SPEC acceptance criterion 12).

## Prerequisites

- Debian 12/13 machine (Hetzner dedicated for prod; any VM/VPS for dev — Incus
  system containers run fine inside a VM, no nested KVM needed).
- Root SSH access.
- The control plane deployed (`apps/worker`), and the `WORKER_RPC_PUBLIC_KEY`
  printed by `npx tsx apps/worker/scripts/genkeys.ts` at hand.
- For production: a ZFS pool created with native encryption
  (`zpool create -O encryption=on -O keyformat=passphrase tank /dev/nvme...`),
  and your passphrase-at-boot procedure documented.

## Steps

```bash
# 1. Copy the repo to the host
rsync -a --exclude node_modules --exclude .git ./ root@HOST:/opt/codestation/

# 2. Run the bootstrap (installs incus, node, nftables baseline, daemon)
ssh root@HOST 'HOST_ID=hetzner-fsn-1 WORKER_RPC_PUBLIC_KEY=<b64> bash /opt/codestation/infra/bootstrap.sh'
#    dev boxes without ZFS: add ZFS_LOOP_GB=40 for a file-backed pool.
#    Cloud kernels ship without the zfs module; if bootstrap says so, run
#    `apt-get install linux-image-cloud-amd64 linux-headers-cloud-amd64 zfs-dkms`
#    and reboot first.

# 3. Build the base image on the host (~5 minutes)
ssh root@HOST 'bash /opt/codestation/infra/build-image.sh'

# 4. Register the host row in D1 — the bootstrap prints the exact
#    `wrangler d1 execute` command with the generated keys/fingerprints.

# 5. Verify from the control plane side: provision a test signup end-to-end.
```

## Reboot behavior

Containers carry `boot.autostart=true`; incus restores them and their proxy
(SSH port-forward) devices. The daemon restarts via systemd, and the Worker
cron reconciler re-syncs D1 state from daemon `stats` within 5 minutes.

## Decommissioning / dead host

MVP has no backups or live migration (SPEC: v1.1). Mark the host row
`status='dead'`; affected containers are lost. Communicate per ToS.

## Daemon endpoint TLS (required for a deployed Worker)

A deployed Worker **cannot** call `https://<ip>:8443` — Cloudflare blocks
direct-IP fetches (error 1003) and rejects self-signed certs, so the
bootstrap's self-signed cert only works for local `wrangler dev` with
relaxed TLS. Every production host needs:

1. A DNS hostname. With no domain, `<ip>.sslip.io` works (third-party
   wildcard DNS; Let's Encrypt rate limits are shared across all sslip.io
   users).
2. A publicly-trusted cert:
   `certbot certonly --standalone -d <hostname>` (port 80 must be free),
   point `tlsCertPath`/`tlsKeyPath` in `/etc/codestation/daemon.json` at
   `/etc/letsencrypt/live/<hostname>/fullchain.pem|privkey.pem`, add a
   deploy hook restarting `codestation-daemon`, restart the daemon.
3. `hosts.daemon_endpoint = https://<hostname>:8443` in D1.

## Security notes

- The daemon listens on `:8443` (TLS; SHA-256 cert fingerprint recorded in
  the `hosts` row, informational). Every request must additionally
  carry a valid Ed25519 signature from the Worker with a fresh nonce and
  timestamp. For defense-in-depth, front it with a Workers mTLS binding or
  firewall the port to Cloudflare egress ranges.
- `/etc/codestation/daemon.json` (mode 600) holds the host's X25519 private
  key. Credential payloads from the control plane are sealed to its public
  half; nothing else can open them.
- Outbound port 25 is dropped in nftables for all forwarded (container)
  traffic; new-connection rate is capped per container IP.
