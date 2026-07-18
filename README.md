# Codestation

Codestation provisions a persistent Debian coding environment with Pi, Claude
Code, Codex, OpenCode, and the everyday development toolchain preinstalled. It
is designed so a beginner can sign in, choose agents, and launch without first
learning VPS administration.

The current release is a free service reached through World ID or a one-time
administrator invite: one Incus system container per account, reached over
public-key SSH. It is intentionally described as a cloud container rather than
a hardware-isolated VM. Paid plans,
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

1. The user signs in with World ID or a passkey, or creates an account with an
   eight-character, single-use administrator invite. Invite signup creates a
   discoverable passkey before consuming the code, because that passkey is the
   account's required return path. A new World ID account can optionally add a
   passkey and can always continue signing in with World ID.
2. Onboarding requires only one choice: one or more coding agents. SSH and all
   model/developer credentials are optional, but model, GitHub, and Cloudflare
   credentials must be selected before creating the server. Later credential
   changes require manual terminal commands. When GitHub is configured, users
   can authorize the GitHub App and select repositories to clone automatically
   into `~/repos/<repo-name>`.
3. The Worker reserves host capacity and an SSH port, stores state in D1, seals
   any credentials to the selected host, signs the request, and returns HTTP
   202 immediately.
4. The daemon clones codestation-base inside a restricted Incus project,
   applies hard CPU/memory/process limits, caps the disposable root disk,
   attaches the separately capped persistent /home/dev volume, configures SSH
   and credentials, and verifies the selected agents.
   All four agents are baked into the image; a missing-only fallback installer
   runs only for a selected binary that is unexpectedly absent. The selected
   set drives dashboard and MOTD guidance even though every binary is available.
5. The dashboard displays clear waiting/building/ready/error states. It reveals
   the SSH command and host-key fingerprints only after an SSH key is added. If
   capacity is full, the FIFO waitlist is admitted automatically by the
   reconciler.
6. After the server is ready, a user without a key can copy an enrollment prompt
   to a local coding agent. The agent creates a local keypair, sends only the
   public key with a single-use one-hour token, and configures ssh codestation.

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
The checked-in Wrangler configuration keeps DEV_AUTH=0. WebAuthn permits
passkeys on localhost over HTTP. To exercise invites locally, put a disposable
`INVITE_ADMIN_SECRET` in the untracked `.dev.vars` and point `invite:create` at
`http://localhost:8787`; never commit `.dev.vars`.

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
- GitHub, Cloudflare, World ID, Codex auth endpoints, WebAuthn verification,
  and daemon HTTP are mocked.
- CI runs npm ci, npm run typecheck, and npm test on Node.js 22.

There is not yet an automated real-Incus nightly suite. Provision-to-SSH,
firewall, reboot, browser accessibility, and rollback checks are manual release
evidence listed in SPEC.md. The destructive multi-tenant staging gate is in
[infra/MULTITENANT_TESTING.md](./infra/MULTITENANT_TESTING.md).

## Control-plane configuration

apps/worker/wrangler.jsonc declares the deployed Worker, D1 binding, KV binding,
five-minute Cron trigger, public base URL, and World ID identifiers.

Required Worker secrets:

- RP_SIGNING_KEY
- CREDENTIAL_MASTER_KEY
- NULLIFIER_HMAC_KEY
- WORKER_RPC_PRIVATE_KEY
- INVITE_ADMIN_SECRET

Optional secrets:

- GITHUB_APP_CLIENT_SECRET, paired with the public `GITHUB_APP_CLIENT_ID` Worker
  variable; also set `GITHUB_APP_SLUG` to enable the installation chooser

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
    npx wrangler secret put INVITE_ADMIN_SECRET
    npx wrangler deploy

World ID setup is in the World Developer Portal. The app must be upgraded for
World ID 4.0, register the `WORLD_ID_ACTION` action, and provide
`WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, `WORLD_ID_ENVIRONMENT`, and the one-time RP
signing key. Use `WORLD_ID_ENVIRONMENT=production` with the real World App. Use
`staging` only when the configured app/RP and World simulator are also staging.
`DEV_AUTH` does not select the World ID environment.

### Administrator invites

`INVITE_ADMIN_SECRET` is a high-entropy bearer secret shared only between the
Worker and an administrator running the generation script. The Worker compares
it in constant time. It returns the raw invite once and stores only an
HMAC-SHA-256 keyed by that Worker secret in D1; a completed redemption remains
recorded even if the account is later deleted. Rotating the secret intentionally
invalidates every outstanding unused invite.

Generate a code against a deployed Worker without putting the admin secret in
shell history:

    read -rs INVITE_ADMIN_SECRET && export INVITE_ADMIN_SECRET
    echo
    npm run invite:create -w apps/worker -- --url https://YOUR_BASE_URL
    unset INVITE_ADMIN_SECRET

The script prints one eight-character uppercase alphanumeric code. Send it to
its intended recipient through a private channel. The code is not consumed if
the recipient cancels or fails the required passkey prompt; it is consumed
atomically when the account and first passkey are persisted.

For optional GitHub repository access, register a public GitHub App and set
`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`. Set `GITHUB_APP_SLUG` to
enable the installation chooser; without it, onboarding keeps the direct OAuth
connection and repository selector available. The slug is the final path
segment of `https://github.com/apps/APP-SLUG`. Configure the first callback URL
as:

    https://YOUR_BASE_URL/auth/github/callback

Enable **Request user authorization (OAuth) during installation** and expiring
user-to-server tokens. Grant **Contents: read-only** repository permission
(Metadata read access is implicit), make the App installable on **Any account**,
and do not request broader permissions. The onboarding action then opens the
App's installation chooser when `GITHUB_APP_SLUG` is configured, so a user can
select a personal or organization account and grant either all repositories or
specific repositories.

Organization installations may require owner approval. If the organization
uses SAML SSO, the user must start an active SAML session before reauthorizing.
When permissions change, owners of existing installations must approve the new
permissions in GitHub. Before release, install the App on a test account, grant
one private repository, reauthorize, verify that search finds it, and verify
that an ungranted private repository is rejected.

The control plane refreshes access tokens; refresh tokens never leave it.
Provisioning preconfigures both `gh` and Git's HTTPS credential helper with the
short-lived access token, which can clone only repositories shared by the user
grant and the App installation.

## Repeat deployment

Do not recreate D1 or KV for a normal release. From a clean checkout, the
root deploy command runs the locked install, type checks, tests, remote D1
migrations, Worker deployment, and a public-root smoke test:

    npm run deploy

It asks before making remote changes. Use `npm run deploy -- --yes` in an
intentional non-interactive release, or `npm run deploy -- --dry-run` to run
the local release gates and print the remote actions without performing them.
`DEPLOY_URL=https://example.com npm run deploy -- --yes` overrides the
configured `BASE_URL` used for the smoke test. Run `./deploy.sh --help` for
the escape hatches; skipping checks or migrations should be exceptional.

Review migrations before approving the command. D1 migrations do not roll back
automatically; prefer backward-compatible expand-first changes.

If apps/daemon, packages/contract, its dependencies, the systemd unit, or host
infrastructure changed, release the daemon first using the drain, backup,
rollback, and verification procedure in [infra/RUNBOOK.md](./infra/RUNBOOK.md).
A daemon restart clears active in-memory jobs and replay nonces, so never
restart it while jobs are queued or running.

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

## Adding and maintaining hosts

See [infra/RUNBOOK.md](./infra/RUNBOOK.md). For a multi-tenant staging rollout,
also follow [infra/MULTITENANT_TESTING.md](./infra/MULTITENANT_TESTING.md). In
summary:

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
- Tenant NICs enforce anti-spoofing, east-west isolation, and a 100 Mbit/s
  bandwidth ceiling. CPU is capped per tenant and admitted against a host-wide
  vCPU reservation ceiling.
- The base image is not automatically rebuilt. Rebuild it for tool/agent/base
  changes and on the security refresh cadence in the runbook.
- Agent npm packages currently resolve latest-at-image-build, and fallback
  installers are also unpinned. Exact pins, recorded build metadata, and an
  SBOM remain supply-chain hardening work.
- GitHub is hidden unless a GitHub App is configured.
- Codex ChatGPT-plan device authorization follows the CLI flow and is not a
  separately registered third-party OAuth integration; upstream changes may
  require auth.json paste or in-shell login.
