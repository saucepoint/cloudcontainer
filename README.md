# usebench.dev

usebench.dev provisions a persistent Debian coding environment with Pi, Claude
Code, Codex, OpenCode, and the everyday development toolchain preinstalled. It
is designed so a beginner can sign in, choose agents, and launch without first
learning VPS administration.

Public signup is free with World ID or administrator-invite eligibility
verification: one Incus system container per account, reached over public-key
SSH. Operator-entitled paid and dedicated accounts are placement-ready, but
Stripe, self-service upgrades, email, backups, and automatic failover are not
current features. Environments are intentionally described as cloud containers
rather than hardware-isolated VMs. See [SPEC.md](./SPEC.md) for the normative
release contract.

## Repository layout

    packages/contract   Shared Zod wire schemas, Ed25519 request signing,
                        X25519 sealed delivery, and at-rest crypto
    apps/worker         Hono SSR pages and JSON APIs on Cloudflare Workers;
                        Better Auth, D1, and the Cron reconciler
    apps/daemon         Hono on Node.js; verifies signed RPC, opens sealed
                        payloads in memory, and drives local Incus
    infra               Fleet controller, host policy/bootstrap/audit,
                        base-image build, and operations runbook

There is no separate Pages application. One Worker serves the HTML and APIs.

## User flow

1. The user signs in with Google, GitHub, or an existing passkey, or creates a
   new passkey-first account through Better Auth.
2. A new or previously unverified account proves one-person eligibility with
   World ID or redeems an eight-character, single-use administrator invite.
   Existing verified accounts skip this step.
3. Onboarding requires only one choice: one or more coding agents. SSH and all
   model/developer credentials are optional, but model, GitHub, and Cloudflare
   credentials must be selected before creating the server. Later credential
   changes require manual terminal commands. When GitHub is configured, users
   can authorize the GitHub App and select repositories to clone automatically
   into `~/repos/<repo-name>`.
4. The Worker maps the account to its enforced host class, reserves capacity
   and an SSH port on an eligible healthy host, stores state in D1, seals
   any credentials to the selected host, signs the request, and returns HTTP
   202 immediately.
5. The daemon clones workbench-base inside a restricted Incus project,
   applies hard CPU/memory/process limits, caps the disposable root disk,
   attaches the separately capped persistent /home/dev volume, configures SSH
   and credentials, and verifies the selected agents.
   All four agents are baked into the image; a missing-only fallback installer
   runs only for a selected binary that is unexpectedly absent. The selected
   set drives dashboard and MOTD guidance even though every binary is available.
6. The dashboard displays clear waiting/building/ready/error states. It reveals
   the SSH command and host-key fingerprints only after an SSH key is added. If
   its matching capacity pool is full, that pool's FIFO waitlist is admitted
   automatically by the reconciler without blocking independent host classes.
7. After the server is ready, a user without a key can copy an enrollment prompt
   to a local coding agent. The agent creates a local keypair, sends only the
   public key with a single-use one-hour token, and configures ssh workbench.

The dashboard loads container, credential-presence, and SSH-key data with one
aggregate request. While work is active, it polls only container state: every
five seconds for jobs/transitions and every thirty seconds on the waitlist.
Polling is non-overlapping, pauses in a hidden tab, and resumes on visibility.

SSH sessions use Bash by default, with a prompt showing the user, machine, and
current directory. Zsh is installed with the same prompt; opt in with
`sudo usermod --shell /bin/zsh "$USER"` and reconnect. Switch back with
`sudo usermod --shell /bin/bash "$USER"`.

## Local development

Requirements: Node.js 22 and npm.

    npm ci
    npm run build:client -w apps/worker
    npm run typecheck
    npm run lint
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
  migrations, a D1-compatible adapter double, and intercepted fetch calls.
- Daemon tests inject command execution and assert the generated Incus commands.
- Contract tests exercise signing, replay rejection, encryption, sealing,
  cross-runtime-safe encodings, and tamper failures.
- GitHub, Cloudflare, Codex, Better Auth, and World ID endpoints,
  and daemon HTTP are mocked.
- CI installs dependencies, builds browser clients, type-checks, lints, and runs all tests on Node.js 22.

There is not yet an automated real-Incus nightly suite. Provision-to-SSH,
firewall, reboot, browser accessibility, and rollback checks are manual release
evidence listed in SPEC.md. The destructive multi-tenant staging gate is in
[infra/MULTITENANT_TESTING.md](./infra/MULTITENANT_TESTING.md).

## Control-plane configuration

apps/worker/wrangler.jsonc declares the deployed Worker, D1 binding,
five-minute Cron trigger, and public base URL.

Required Worker secrets:

- CREDENTIAL_MASTER_KEY
- BETTER_AUTH_SECRET
- WORKER_RPC_PRIVATE_KEY
- INVITE_ADMIN_SECRET
- FLEET_ADMIN_SECRET

Optional secrets:

- GITHUB_APP_CLIENT_SECRET, paired with the public `GITHUB_APP_CLIENT_ID` and
  `GITHUB_APP_SLUG` Worker variables. GitHub setup is hidden unless all three
  values form a complete install-capable App configuration.
- AUTH_GOOGLE_CLIENT_SECRET and AUTH_GITHUB_CLIENT_SECRET, paired with their
  `AUTH_*_CLIENT_ID` variables.
- WORLD_ID_SIGNING_KEY, paired with `WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, and
  `WORLD_ID_ACTION`. Invite verification remains available without World ID.

Generate service keys with:

    cd apps/worker
    npx tsx scripts/genkeys.ts

The generated Worker RPC public key belongs in each daemon configuration. The
private half remains a Worker secret.

`FLEET_ADMIN_SECRET` is a separate high-entropy bearer used only by
`infra/hostctl.sh` and the host administration API. Do not reuse the invite
secret. The API responds as not found when the fleet secret is absent, and it
exposes only non-secret operational host metadata.

### First control-plane setup

This is only for a new Cloudflare environment:

    cd apps/worker
    npx wrangler d1 create workbench

Copy the returned D1 ID into wrangler.jsonc, then:

    npm run db:migrate:remote
    npx wrangler secret put BETTER_AUTH_SECRET
    npx wrangler secret put CREDENTIAL_MASTER_KEY
    npx wrangler secret put WORKER_RPC_PRIVATE_KEY
    npx wrangler secret put INVITE_ADMIN_SECRET
    npx wrangler secret put FLEET_ADMIN_SECRET
    npx wrangler deploy

### Account providers and World ID

Create OAuth applications for the two Better Auth providers and configure
these callback URLs:

    https://usebench.dev/api/auth/callback/google
    https://usebench.dev/api/auth/callback/github

Put each public client ID in the matching `AUTH_*_CLIENT_ID` Worker variable
and each secret in `AUTH_*_CLIENT_SECRET`. These credentials are separate from
the GitHub App used later for repository access.

For World ID, create or migrate an application in the World Developer Portal,
register its relying party, and set `WORLD_ID_APP_ID`, `WORLD_ID_RP_ID`, and
`WORLD_ID_ACTION`. Store the RP signing key only as `WORLD_ID_SIGNING_KEY`.
Production accepts only signed World ID 4 Proof of Human uniqueness requests.
The Worker binds each proof signal to the authenticated account,
forwards the unchanged result to the Developer Portal, and persists the
returned nullifier so one person cannot verify multiple accounts.

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
    npm run create:invite
    unset INVITE_ADMIN_SECRET

The script targets `https://usebench.dev` by default. Pass `-- --url
https://YOUR_BASE_URL` after the command to target another deployment.

The script prints one eight-character uppercase alphanumeric code. Send it to
its intended recipient through a private channel. The recipient first signs in
or creates a passkey account, then redeems the code on the verification screen.
The redemption and account eligibility update occur in one D1 batch.

### Account notifications

Administrators can publish a global notification before planned maintenance,
including a container-destruction warning. Notifications appear on the Account
button as an unread badge and remain available on the Account page until each
user marks them read. Use the same bearer secret as invite generation:

    curl -fsS https://usebench.dev/api/admin/notifications \
      -H "Authorization: Bearer $INVITE_ADMIN_SECRET" \
      -H "Content-Type: application/json" \
      -d '{"title":"Scheduled system upgrade","message":"Your container will be destroyed during the system upgrade. Export anything you need before the maintenance window.","severity":"critical"}'

The supported severities are `info`, `warning`, and `critical`. Set
`expiresAt` to a future Unix timestamp in milliseconds when an announcement
should stop appearing.

For optional GitHub repository access, register a public GitHub App and set all
of `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG`.
The production App is named `usebench.dev` and uses the slug `usebench-dev`.
The slug is the final path segment of `https://github.com/apps/APP-SLUG`.
Configure the first callback URL as:

    https://usebench.dev/auth/github/callback

Enable **Request user authorization (OAuth) during installation** and expiring
user-to-server tokens. Grant **Contents: read-only** repository permission
(Metadata read access is implicit), make the App installable on **Any account**,
and do not request broader permissions. The single onboarding action opens the
App installation chooser, where a user selects a personal or organization
account and grants all or specific repositories. GitHub then continues into
user authorization and returns to the callback.

Installation and authorization remain distinct GitHub grants even though the
product presents one browser journey. The installation grant is not a `gh`
credential. The resulting short-lived GitHub App user access token is what the
control plane uses for repository search and what the container uses for `gh`
and HTTPS Git access.

Organization installations may require owner approval. If the organization
uses SAML SSO, the user must start an active SAML session before using
**Connect or update GitHub** again. When permissions change, owners of existing
installations must approve the new permissions in GitHub. Before release, use
the single action on a test account, grant one private repository, verify that
search and `gh repo clone` can access it, and verify that an ungranted private
repository is rejected.

The control plane refreshes access tokens; refresh tokens never leave it.
Provisioning writes the current short-lived token once to `gh` configuration
and runs `gh auth setup-git`, so Git reuses `gh auth git-credential` rather than
storing a duplicate token in `.git-credentials`. Access remains limited to the
intersection of the user grant and each App installation.

## Repeat deployment

Do not recreate D1 for a normal release. From a clean checkout, the
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

The one-time `0014_host_fleet.sql` rollout deliberately leaves every legacy
host draining until its class policy and daemon have been deployed, audited,
probed, and explicitly reactivated through the fleet controller. See the
control-plane rollout in the runbook before applying it.
`0015_host_lifecycle.sql` adds generation history and orderly re-home state.
`0016_free_tier_cpu.sql` repairs host CPU accounting to the actual 1/3-vCPU
reservations.

If apps/daemon, packages/contract, its dependencies, the systemd unit, or host
infrastructure changed, use the fleet controller and the compatibility order
in [infra/RUNBOOK.md](./infra/RUNBOOK.md). A normal daemon fleet release is:

    read -rs FLEET_ADMIN_SECRET && export FLEET_ADMIN_SECRET
    echo
    npm run hostctl -- list
    npm run hostctl -- deploy --all
    unset FLEET_ADMIN_SECRET

The controller processes hosts sequentially and requires a clean checkout. For
each host it drains placement, refuses to restart with active jobs, backs up the
old release and host configuration, copies the release, installs locked
production dependencies, audits policy, performs a signed probe, verifies the
reported Git commit, and only then restores hosts that were previously active. A failure, pre-drained host,
or unhealthy host remains draining. Daemon restarts still clear in-memory jobs
and replay nonces; draining atomically fences new daemon-job inserts, so the
zero-active-job gate cannot race a user lifecycle action.

Verify:

    curl -fsS -o /dev/null https://usebench.dev/
    cd apps/worker
    npx wrangler d1 migrations list workbench --remote
    npx wrangler deployments list

When a Worker-only release fails, find the prior version in the deployment
list and roll it back:

    npx wrangler rollback PRIOR_VERSION_ID --message "rollback: reason"

Rolling back Worker code does not reverse D1 migrations or roll back a daemon.
Shared-contract changes therefore need backward compatibility or an explicitly
coordinated release.

## Adding and maintaining hosts

See [infra/RUNBOOK.md](./infra/RUNBOOK.md). For a multi-tenant staging rollout,
also follow [infra/MULTITENANT_TESTING.md](./infra/MULTITENANT_TESTING.md).
`hostctl` is the supported registration and mutation path; do not construct a
hosts row with ad hoc SQL.

Host classes are enforced end to end:

| Host class | Eligible account | Advertised / enforced shape | Tenant ceiling |
|---|---|---|---|
| budget | free only | 1 / 1 vCPU, 1536 MiB RAM, 1 GiB swap, 5+5 GiB disk | calculated per host |
| regular | paid only | 2 / 3 vCPU, 4096 MiB RAM, swap disabled, 8+8 GiB disk | calculated per host |
| dedicated | one assigned paid account | paid shape | exactly one |

Each host reserves `max(3072 MiB, ceil(8% of total system RAM))`; only the
remainder is tenant RAM. Its CPU reservation capacity defaults to four times
the detected online vCPU count, and an operator may select a lower multiplier
from 1 through 4. CPU tenant capacity is rounded up after dividing by the
class reservation, while RAM permits 1.25x oversubscription and is also rounded
up. The calculated tenant ceiling is the minimum of those CPU/RAM limits plus
safe disk, swap where required, and available isolated ID maps.
The scheduler rechecks that ceiling and all resource counters transactionally.
Every host registers its own numbers, so two budget hosts (for example 4
vCPU/8 GiB and 8 vCPU/16 GiB) can have different ceilings, independent of an
8-vCPU/16-GiB regular host.
After a deliberate hardware or host-policy change,
`npm run hostctl -- capacity HOST_ID` drains, recalculates, safely re-registers,
audits, and probes the new ceiling before restoring prior active state.

Typical onboarding, after a trusted daemon certificate exists on the host:

    export WORKER_RPC_PUBLIC_KEY='PUBLIC_KEY_FROM_genkeys'
    read -rs FLEET_ADMIN_SECRET && export FLEET_ADMIN_SECRET
    echo
    npm run hostctl -- onboard \
      --id budget-fsn-1 \
      --type budget \
      --management-host admin-fsn-1.example.com \
      --ssh-hostname ssh-fsn-1.example.com \
      --daemon-endpoint https://daemon-fsn-1.example.com:8443 \
      --tls-cert-path /etc/letsencrypt/live/daemon-fsn-1.example.com/fullchain.pem \
      --tls-key-path /etc/letsencrypt/live/daemon-fsn-1.example.com/privkey.pem \
      --activate
    unset FLEET_ADMIN_SECRET WORKER_RPC_PUBLIC_KEY

Onboarding copies the clean current commit, bootstraps policy, builds the base
image, audits the host, registers it as draining, probes the signed daemon, and
activates only when explicitly requested. Existing-host updates use `hostctl
deploy`; never rerun bootstrap as an update mechanism.

`hostctl rehome` applies a changed account plan by destroying the old instance
before waitlisting it on the new class. `hostctl reclass` safely repurposes an
empty host. Forced dead-host retirement evacuates desired rows and frees a
dedicated assignment after the failed hardware is isolated; `onboard
--replace-dead`, `history`, and `remove` provide the replacement and
deregistration lifecycle without raw D1 edits. These are destructive
reprovisioning paths, not backup or live-migration features.

## Current limitations

- Public signup is free; paid/dedicated entitlements are administrative until
  Stripe, paid upgrade, email, and dunning UI exist.
- A development budget host may use file-backed ZFS, but every such host is
  explicitly non-production and contributes only its calculated safe capacity.
- Development storage is file-backed ZFS without encryption. Production must
  use encrypted ZFS and documented key handling.
- No backups, replication, live migration, or user-data recovery after host
  loss; manual force-retirement can only queue clean replacement environments.
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
