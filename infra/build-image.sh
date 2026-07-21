#!/usr/bin/env bash
# Build the `workbench-base` Incus image (SPEC §10 container): Debian 13 with
# the full toolchain, sshd hardened to pubkey-only, non-root `dev` user with
# passwordless sudo, and system-wide Node 22 so agent installs survive home-
# volume swaps. Re-run monthly to rebake agent/toolchain versions.
set -euo pipefail

NAME=cs-image-build
ALIAS="${ALIAS:-workbench-base}"
BASE="${BASE:-images:debian/13}"
PROJECT="${PROJECT:-default}"

incus --project "$PROJECT" delete -f "$NAME" 2>/dev/null || true
incus --project "$PROJECT" launch "$BASE" "$NAME"

echo "waiting for network…"
for i in $(seq 1 60); do
  incus --project "$PROJECT" exec "$NAME" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1' && break
  sleep 2
done

incus --project "$PROJECT" exec "$NAME" -- sh -eu <<'SETUP'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  openssh-server sudo git gh build-essential cmake libssl-dev libsqlite3-dev \
  python3 python3-venv curl zsh tmux ripgrep fd-find bat jq unzip zip sqlite3 \
  rsync nano tree less man-db manpages ca-certificates gnupg unattended-upgrades locales

# uv (python package manager)
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Node 22 system-wide (agents live in /usr/lib/node_modules, not $HOME,
# so they survive home-volume swaps and rebuilds)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

# Coding agents are part of the image, so a normal provision only personalizes
# keys and credentials. Rebuilding this image is the deliberate update cadence;
# the daemon retains a missing-binary fallback for older/custom images.
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai

# Debian names these commands fdfind and batcat.
ln -sf "$(command -v fdfind)" /usr/local/bin/fd
ln -sf "$(command -v batcat)" /usr/local/bin/bat

# dev user: passwordless sudo, no password auth anywhere
useradd -m -s /bin/zsh dev || true
usermod -aG sudo dev
echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev
chmod 440 /etc/sudoers.d/dev
passwd -l dev

# sshd: pubkey-only (spec §12), no root login
cat > /etc/ssh/sshd_config.d/workbench.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers dev
PrintMotd yes
SSHD
systemctl enable ssh

# Per-container SSH host keys: strip the baked ones so every container
# generates its own on first boot. A dedicated oneshot ordered before
# ssh.service (a drop-in ExecStartPre would run after Debian's `sshd -t`
# check, which fails while keys are missing).
cat > /etc/systemd/system/ssh-host-keys.service <<'UNIT'
[Unit]
Description=Generate SSH host keys if missing
Before=ssh.service
ConditionPathExists=!/etc/ssh/ssh_host_ed25519_key

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A

[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /etc/systemd/system/ssh.service.d
cat > /etc/systemd/system/ssh.service.d/host-keys.conf <<'UNIT'
[Unit]
Wants=ssh-host-keys.service
After=ssh-host-keys.service
UNIT
systemctl enable ssh-host-keys

# MOTD is fully daemon-managed
rm -f /etc/update-motd.d/* 2>/dev/null || true
echo "" > /etc/motd

# Keep the published image lean. Agent tarballs/native binaries can leave a
# large root npm cache, and apt package indexes are useless until the next
# explicit refresh.
npm cache clean --force >/dev/null 2>&1 || true
rm -rf /root/.npm /var/lib/apt/lists/* /tmp/*
apt-get clean
rm -f /etc/ssh/ssh_host_*
SETUP

incus --project "$PROJECT" stop "$NAME"
incus --project "$PROJECT" publish "$NAME" --alias "$ALIAS" --reuse
incus --project "$PROJECT" delete "$NAME"
echo "image '$ALIAS' published."
