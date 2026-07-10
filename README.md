# Codestation

Codestation provisions a persistent Debian coding environment with Pi, Claude
Code, Codex, OpenCode, and the everyday development toolchain preinstalled. It
is designed so a beginner can sign in, choose agents, and launch without first
learning VPS administration.

The current release is a free, World ID-gated service: one Incus system
container per verified human, reached over public-key SSH. It is intentionally
described as a cloud container rather than a hardware-isolated VM. Paid plans,
Stripe, email, backups, and production redundancy are roadmap work, not current
features. See [SPEC.md](./SPEC.md) for the normative release contract.

## Repository layout

    packages/contract   Shared Zod wire schemas, Ed25519 request signing,
                        X25519 sealed delivery, and at-rest crypto
    apps/worker         Hono SSR pages and JSON APIs on Cloudflare Workers;
                        D1, KV sessions, and the Cron reconciler
    apps/daemon         Hono on Node.js; verifies signed RPC, opens sealed
                        payloads in memory, and drives local Incus
    infra               Host bootstrap, base-image build, and operations runbook

There is no separate Pages application. One Worker serves the HTML and APIs.

## User flow

1. The user completes one World ID 4.0 Session proof. The RP-scoped
   session_id provides both one-human/one-account uniqueness and repeat login.
2. Onboarding requires only one choice: one or more coding agents. SSH and all
   model/developer credentials are optional.
3. The Worker reserves host capacity and an SSH port, stores state in D1, seals
   any credentials to the selected host, signs the request, and returns HTTP
   202 immediately.
4. The daemon clones codestation-base, caps the disposable root disk, attaches
   the separately capped persistent /home/dev volume, configures SSH and
   credentials, and verifies the selected agents.
   All four agents are baked into the image; a missing-only fallback installer
   runs only for a selected binary that is unexpectedly absent. The selected
   set drives dashboard and MOTD guidance even though every binary is available.
5. The dashboard displays clear waiting/building/ready/error states, the SSH
   command, and host-key fingerprints. If capacity is full, the FIFO waitlist
   is admitted automatically by the reconciler.
6. A user without a key can copy an enrollment prompt to a local coding agent.
   The agent creates a local keypair, sends only the public key with a
   single-use one-hour token, and configures ssh codestation.

The dashboard loads container, credential-presence, and SSH-key data with one
aggregate request. While work is active, it polls only container state: every
five seconds for jobs/transitions and every thirty seconds on the waitlist.
Polling is non-overlapping, pauses in a hidden tab, and resumes on visibility.

## Local development

Requirements: Node.js 22 and npm.

    npm ci
    npm run typecheck
    npm test

Prepare local D1 and start the Worker:

    cd apps/worker
    npm run db:migrate:local
    npx wrangler dev --var DEV_AUTH:1

The dashboard is normally at http://localhost:8787. DEV_AUTH=1 exposes the
visible local development login and must not be committed as a deployed value.
The checked-in Wrangler configuration keeps DEV_AUTH=0.

To exercise real provisioning, use a Debian 12/13 Linux box or VM with Incus.
Bootstrap it with [infra/RUNBOOK.md](./infra/RUNBOOK.md), register the host in
the local D1 database, then run the Worker locally. A file-backed ZFS pool is
acceptable only for development.

### Test architecture

The fast suite never contacts live external services or infrastructure:

- Worker tests use Vitest, an in-memory node:sqlite database with the real
  migrations, a Map-backed KV double, and intercepted fetch calls.
- Daemon tests inject command execution and assert the generated Incus commands.
- Contract tests exercise signing, replay rejection, encryption, sealing,
  cross-runtime-safe encodings, and tamper failures.
- GitHub, Cloudflare, World ID, Codex auth endpoints, and daemon HTTP are mocked.
- CI runs npm ci, npm run typecheck, and npm test on Node.js 22.

There is not yet an automated real-Incus nightly suite. Provision-to-SSH,
firewall, reboot, browser accessibility, and rollback checks are manual release
evidence listed in SPEC.md.

## Control-plane configuration

apps/worker/wrangler.jsonc declares the deployed Worker, D1 binding, KV binding,
five-minute Cron trigger, public base URL, and World ID identifiers.

Required Worker secrets:

- RP_SIGNING_KEY
- CREDENTIAL_MASTER_KEY
- NULLIFIER_HMAC_KEY
- WORKER_RPC_PRIVATE_KEY

Optional secrets:

- GITHUB_APP_CLIENT_SECRET, paired with GITHUB_APP_CLIENT_ID
- DEV_AUTH_TOKEN, for a controlled deployed development bypass

Generate service keys with:

    cd apps/worker
    npx tsx scripts/genkeys.ts

The generated Worker RPC public key belongs in each daemon configuration. The
private half remains a Worker secret.

### First control-plane setup

This is only for a new Cloudflare environment:

    cd apps/worker
    npx wrangler d1 create codestation
    npx wrangler kv namespace create SESSIONS

Copy the returned IDs into wrangler.jsonc, then:

    npm run db:migrate:remote
    npx wrangler secret put CREDENTIAL_MASTER_KEY
    npx wrangler secret put NULLIFIER_HMAC_KEY
    npx wrangler secret put WORKER_RPC_PRIVATE_KEY
    npx wrangler secret put RP_SIGNING_KEY
    npx wrangler deploy

World ID setup is in the World Developer Portal. The app must use World ID 4.0
and provide WORLD_ID_APP_ID, WORLD_ID_RP_ID, and the one-time RP signing key.
A staging World ID app can be exercised with the World simulator.

For optional GitHub authorization, register a GitHub App with callback:

    https://YOUR_BASE_URL/auth/github/callback

Enable expiring user-to-server tokens and request only needed repository
permissions. The control plane refreshes access tokens; refresh tokens never
leave it.

## Repeat deployment

Do not recreate D1 or KV for a normal release. From a clean checkout:

    npm ci
    npm run typecheck
    npm test
    npm run db:migrate:remote -w apps/worker

Review migrations before applying them. D1 migrations do not roll back
automatically; prefer backward-compatible expand-first changes.

If apps/daemon, packages/contract, its dependencies, the systemd unit, or host
infrastructure changed, release the daemon first using the drain, backup,
rollback, and verification procedure in [infra/RUNBOOK.md](./infra/RUNBOOK.md).
A daemon restart clears active in-memory jobs and replay nonces, so never
restart it while jobs are queued or running.

Then deploy the Worker:

    npm run deploy

Verify:

    curl -fsS -o /dev/null https://codestation.saucepoint.workers.dev/
    cd apps/worker
    npx wrangler d1 migrations list codestation --remote
    npx wrangler deployments list

When a Worker-only release fails, find the prior version in the deployment
list and roll it back:

    npx wrangler rollback PRIOR_VERSION_ID --message "rollback: reason"

Rolling back Worker code does not reverse D1 migrations or roll back a daemon.
Shared-contract changes therefore need backward compatibility or an explicitly
coordinated release.

### Deployed development bypass

Keep DEV_AUTH=0. To enable a token-gated bypass temporarily:

    cd apps/worker
    npx wrangler secret put DEV_AUTH_TOKEN

Then use:

    https://BASE_URL/auth/dev?token=TOKEN&sub=TEST_ID

The token is a shared bearer secret in the query string and may appear in
browser history or request metadata. Use it only for controlled development.
Remove it when finished:

    npx wrangler secret delete DEV_AUTH_TOKEN

Without a matching secret the route returns 404. A successful request creates
or reuses the dev-prefixed test account and creates a KV session.

## Adding and maintaining hosts

See [infra/RUNBOOK.md](./infra/RUNBOOK.md). In summary:

1. copy the repository to /opt/codestation;
2. run infra/bootstrap.sh with the host ID and Worker RPC public key;
3. issue a publicly trusted daemon certificate;
4. build codestation-base;
5. register the host in D1; and
6. complete a real provision-to-SSH check.

Adding a host requires a hosts row, not a code change. Existing-host updates
must use draining and active-job checks; do not rerun bootstrap blindly.

## Current limitations

- Free tier only; no Stripe, paid upgrade, email, or dunning UI.
- One small development host; current registered capacity supports one free
  environment after reserve.
- Development storage is file-backed ZFS without encryption. Production must
  use encrypted ZFS and documented key handling.
- No backups, replication, live migration, or host-failure recovery.
- Daemon HTTPS is public. Ed25519 signatures and sealed credential payloads are
  enforced, but mTLS/private networking and ingress restriction are not.
- Daemon jobs and replay nonces are in memory and are lost on daemon restart.
- The current certificate-renewal hook restarts the daemon; production should
  use hot-reload TLS termination or coordinate renewal with active-job checks.
- Port 25 and new-connection rate limits are enforced; bandwidth shaping and a
  sustained-CPU ceiling are not.
- The base image is not automatically rebuilt. Rebuild it for tool/agent/base
  changes and on the security refresh cadence in the runbook.
- Agent npm packages currently resolve latest-at-image-build, and fallback
  installers are also unpinned. Exact pins, recorded build metadata, and an
  SBOM remain supply-chain hardening work.
- GitHub is hidden unless a GitHub App is configured.
- Codex ChatGPT-plan device authorization follows the CLI flow and is not a
  separately registered third-party OAuth integration; upstream changes may
  require auth.json paste or in-shell login.
