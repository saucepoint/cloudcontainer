# Codestation

World ID-gated Debian "cloud containers" preconfigured for coding agents
(Pi / Claude Code / Codex / OpenCode), on Incus hosts, with a Cloudflare
control plane. Implements [SPEC.md](./SPEC.md) **minus email and Stripe**
(free tier only; billing/dunning/upgrade flows are stubbed at the state-machine
level and slot in at M3).

## Layout

```
packages/contract   shared wire contract: job schemas, X25519 sealed-box +
                    at-rest crypto, Ed25519 signed-request scheme (runs
                    identically on Workers and Node — same code, no runtime split)
apps/worker         control plane: Hono on Cloudflare Workers — World ID login,
                    onboarding wizard, dashboard (SSR), job orchestration, D1
                    state, KV sessions, cron reconciler
apps/daemon         per-host daemon: Hono on Node — verifies signed RPCs, opens
                    sealed credential payloads in memory, drives incus (provision/
                    start/stop/rebuild/resize/destroy/sync-keys/refresh-credentials)
infra/              host bootstrap script, base-image build, runbook
```

## How a signup becomes an SSH login (≤ 5 min)

1. **Sign in with World ID** (World ID 4.0 Session proof, via IDKit). First
   sign-in creates the account; `session_id` is stable per (RP, human), so one
   human = one account, and banned-nullifier HMACs are enforced at signup.
2. **Wizard** (one required choice): pick one or more agents, optionally paste
   an SSH public key, LLM API keys / subscription credentials (Claude
   `setup-token` token, Codex `~/.codex/auth.json`), Cloudflare token. Submit
   returns immediately; provisioning is an async job.
3. **Worker** allocates a host + SSH port, writes D1, seals credentials to the
   host's X25519 key, signs the job request, POSTs it to the daemon.
4. **Daemon** clones the prebaked `codestation-base` image (Debian 13 +
   toolchain + sshd hardened to pubkey-only), attaches a per-container home
   volume (quota'd), adds the NAT proxy device for the SSH port, writes
   `authorized_keys` + credential files (0600, owned by `dev`) + MOTD
   checklist, installs the chosen agents idempotently.
5. **Dashboard** polls, then shows `ssh -p <port> dev@<host>` plus the host-key
   fingerprints. No key? Mint a one-time enrollment token instead (single-use,
   1 h TTL) and let your local agent register a key via `POST /api/enroll`.

## Local development

```bash
npm install
npm test                      # contract + worker + daemon suites
npm run typecheck
# Tests never touch the network or real infra: the worker suite runs against
# an in-memory SQLite standing in for D1 (same engine, real migrations applied
# — see apps/worker/test/helpers/env.ts), a Map for KV, and a stubbed fetch
# for daemon/GitHub/Cloudflare HTTP; the daemon suite injects a fake exec to
# assert exact incus command construction. Clocks are injected (SPEC §18).

# control plane on Miniflare (D1/KV local):
cd apps/worker
npx wrangler d1 migrations apply codestation --local
npx wrangler dev              # http://localhost:8787 — DEV_AUTH=1 enables /auth/dev
```

`DEV_AUTH=1` (default in the committed `wrangler.jsonc` only if you set it)
adds a "Dev login" button that skips World ID — never enable it in production.
To bypass World ID on a *deployment* (e.g. while debugging the World ID
integration), set a `DEV_AUTH_TOKEN` secret instead and log in via
`/auth/dev?token=<value>&sub=<any-id>`; no button is shown and the route 404s
without the token. Delete the secret to close the bypass.

To exercise the full provision path locally you need any Linux box/VM with
Incus (see `infra/RUNBOOK.md`; a file-backed ZFS pool via `ZFS_LOOP_GB=40`
behaves like the real thing). Register it in your **local** D1 with the SQL the
bootstrap prints, run `wrangler dev`, and sign up.

## Deploying the control plane

```bash
cd apps/worker
npx wrangler d1 create codestation          # paste id into wrangler.jsonc
npx wrangler kv namespace create SESSIONS   # paste id into wrangler.jsonc
npx wrangler d1 migrations apply codestation --remote

npx tsx scripts/genkeys.ts                  # prints the four secrets
npx wrangler secret put CREDENTIAL_MASTER_KEY
npx wrangler secret put NULLIFIER_HMAC_KEY
npx wrangler secret put WORKER_RPC_PRIVATE_KEY
npx wrangler secret put RP_SIGNING_KEY            # from developer.world.org, World ID 4.0

# set vars in wrangler.jsonc: BASE_URL (your domain), WORLD_ID_APP_ID, WORLD_ID_RP_ID, DEV_AUTH="0"
npx wrangler deploy
```

World ID setup (developer.world.org): create an app (or upgrade an existing
one via the **Enable World ID 4.0** banner), which mints an `rp_id` and a
one-time `signing_key` — copy both immediately, the key is shown only once
(rotate via the Developer Portal if lost). A staging app works with the
[World App simulator](https://simulator.worldcoin.org) for end-to-end testing
without an Orb verification.

Optional GitHub App: register one with callback
`https://<your-domain>/auth/github/callback`, user-to-server token expiry
**enabled**, repo-scoped permissions; set `GITHUB_APP_CLIENT_ID` (var) and
`GITHUB_APP_CLIENT_SECRET` (secret). The reconciler refreshes the ~8 h tokens
control-plane-side; refresh tokens never reach hosts.

## Adding a host

`infra/RUNBOOK.md`. Summary: rsync repo → `bootstrap.sh` (incus + node +
nftables baseline + daemon systemd + host keypair) → `build-image.sh` → insert
the printed `hosts` row. No code changes (AC12).

## Deviations from SPEC.md (deliberate, documented)

- **No Stripe / no email** (per project owner): free tier only. `suspended`,
  grace expiry, and `resize` are implemented so billing can attach at M3;
  upgrade/dunning UI does not exist.
- **World ID verify:** the spec's separate incognito-action proof assumed the
  v2 verify API; World ID has since moved to 4.0. The app uses IDKit **Session
  proofs** alone (`apps/worker/src/worldid.ts`) — `session_id` is already the
  unique per-(RP, human) identifier, doing double duty as signup uniqueness
  gate and login — instead of a separate uniqueness-preset verify + OIDC pair.
- **mTLS:** daemon RPC ships with pinned self-signed TLS + mandatory Ed25519
  signed requests (nonce + timestamp). Attaching a Workers mTLS-certificate
  binding is config-only and recommended for production.
- **Sustained-CPU ceiling & egress bandwidth shaping** are not yet enforced
  (cgroup hard caps, port-25 block, and connection-rate limits are). TODO at M4.
- **Daemon job registry is in-memory**; a daemon restart mid-job is converged
  by the reconciler's stuck-job timeout into `error` + retry.
