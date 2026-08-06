# Product, UX, and platform suggestions

Reviewed 2026-08-06 against the current worktree.

## Purpose

This document records follow-on opportunities found by reviewing the product
contract, Worker routes and state transitions, browser clients, terminal client,
shared contract, daemon lifecycle, migrations, tests, and fleet runbooks. It is
an opportunity backlog, not a change to the current release contract.

The existing [UI / UX / Design Review](./ui-ux-review.md) is treated as the
baseline. Its visual-system fixes are already marked implemented, so this
document concentrates on product capability, information architecture,
workflow recovery, and operational maturity that are not covered there.

## Executive summary

usebench.dev has unusually solid foundations for an early infrastructure
product: the control plane has explicit desired state, transactional placement,
exact host-class rules, a FIFO waitlist, signed and sealed Worker-to-daemon
requests, clear destructive boundaries, and a keyboard-driven CLI. The tests
also cover many race conditions that are easy to miss in this kind of system.

The main product gap is visibility and control after a user submits a request.
The system already records jobs, queue timestamps, host health, credential
presence, and passkeys, but the user generally sees only a single current
status, a latest-job error, a credential boolean, or a passkey count. The next
phase should turn that hidden state into safe, comprehensible actions.

The recommended order is:

1. Make lifecycle progress and waitlist position understandable.
2. Make onboarding resumable and make the first successful SSH connection
   easier to complete.
3. Add safe export/recovery before expanding destructive or paid workflows.
4. Add post-provision management for credentials, repositories, SSH keys,
   passkeys, and CLI operations.
5. Make the execution queue durable and add measurable operational guarantees.

## Current strengths to preserve

- Agent selection is the only required setup choice, and the web and CLI both
  support a no-credential path.
- The Worker persists desired state in D1 and the reconciler converges it after
  polling gaps, host health changes, and daemon restarts.
- Placement is exact-class and transactional. Budget, regular, and dedicated
  pools cannot silently substitute for one another.
- `/home/dev` is separated from the disposable root filesystem, so rebuild is
  a meaningful recovery operation rather than an opaque reinstall.
- Credentials are encrypted at rest, sealed to the selected daemon, omitted
  from job rows and logs, and exposed to the dashboard only as presence.
- SSH is fail-closed until an authorized key exists, with host fingerprints
  shown alongside the command.
- Destructive actions have explicit confirmation, account deletion is gated on
  destroying the environment, and the runbook is careful about drain/probe/
  release sequencing.
- The CLI has browser SSO, World ID/invite verification, agent and integration
  setup, asynchronous readiness, and optional SSH config management.

These strengths suggest that the product can become much more capable without
changing its core isolation or control-plane model.

## Prioritized opportunity backlog

| Priority | Opportunity | Primary value | Size |
| --- | --- | --- | --- |
| P0 | Lifecycle activity and actionable job detail | Reduces uncertainty and support load during provisioning, rebuild, and failures | M |
| P0 | Waitlist position, admission updates, and readiness notifications | Makes capacity limits feel fair and observable | M |
| P0 | Resumable setup draft and first-run checklist | Improves completion through OAuth and the first SSH login | M |
| P0 | Export/safety flow before rebuild, destroy, or host loss | Addresses the largest stated data-loss risk | L |
| P1 | Post-provision credential management | Removes the current “use manual terminal commands” cliff | L |
| P1 | Repository management after provisioning | Makes GitHub integration useful beyond initial cloning | M/L |
| P1 | SSH device management and configuration helper | Makes multi-device access safer and easier to audit | M |
| P1 | Passkey and session management | Gives users real account recovery and security controls | M |
| P1 | Ongoing CLI commands and web/CLI parity | Turns the CLI into a durable product surface instead of a one-time wizard | M |
| P2 | Self-service plans and multiple workbenches | Expands monetization and project separation | L/XL |
| P2 | Browser terminal or emergency shell | Provides access when local SSH is unavailable | XL |

The priority is based on user impact and the current product’s explicit
limitations, not on implementation difficulty alone.

## Feature and UX recommendations

### 1. Add a lifecycle activity timeline with actionable failures — P0

#### Evidence

- `apps/worker/src/jobs.ts` stores a durable job row for every operation, but
  `containerView()` returns only `latestJob()` and the dashboard renders only
  the latest operation.
- `apps/worker/src/reconciler.ts` distinguishes queueing, polling, timeout,
  background retry, host health, and drift correction, but those distinctions
  are mostly invisible to the account holder.
- `apps/worker/client/dashboard.tsx` shows “Building”, “Deleting”, or “Needs
  attention” and offers a generic Retry action. Technical details are tucked
  into a raw `<details>` block.
- Daemon jobs currently expose only queued/running/succeeded/failed, even
  though provisioning has meaningful phases: image/rootfs, storage, SSH,
  credentials, repository cloning, agent verification, and fingerprints.

#### Proposed experience

Add an “Activity” section to the dashboard showing the current and recent
operations:

- submitted, admitted or waitlisted, dispatched, running, completed, or failed;
- operation start and completion times;
- a human label for the current phase;
- a safe failure category such as “host unavailable”, “GitHub access expired”,
  “repository destination already exists”, or “storage setup failed”;
- the next recommended action, such as retry, reconnect GitHub, remove a
  conflicting repository, or contact support; and
- a short request/job identifier that a user can include in a support message.

The first implementation can derive coarse phases from the operation and
daemon result. A later contract extension can add explicit phase events or
percent-free progress where the daemon can measure it honestly. Do not invent
percentage progress for an operation whose duration is dominated by external
package or GitHub calls.

#### Guardrails and success measures

- Keep credential values, host internals, and raw command output out of user
  messages.
- Preserve the current latest-job behavior for the compact summary card.
- Measure the share of failed jobs that users retry successfully, time to first
  successful SSH connection after `running`, and support contacts containing a
  useful job identifier.

### 2. Expose waitlist position and notify on meaningful transitions — P0

#### Evidence

- The reconciler maintains deterministic FIFO order separately for each
  placement pool (`apps/worker/src/reconciler.ts`), but the dashboard only says
  “All hosts are full. Your place is saved.”
- The waitlist stores `requested_at` and `admitted_at`, which is enough to
  compute position and time-in-queue without revealing another user’s
  identity.
- Notifications are currently global announcements stored in `notifications`
  and shown only on the Account page. There is no per-account lifecycle event.

#### Proposed experience

For a waitlisted account, show:

- “Position N in the free/paid queue”;
- when the request entered the queue;
- the last admission check or a plain-language “checked automatically” note;
- a broad historical estimate based on recent admission durations only when
  the sample is large enough; and
- what happens next: the account does not need to refresh, and the dashboard
  will change to Building when a slot is reserved.

Add in-product events for admitted, ready, failed, host maintenance, and
approaching destructive grace-period deadlines. Start with the existing
Account notification center and browser-visible status; add email only after
notification preferences, consent, unsubscribe behavior, and delivery
reliability are defined.

The queue position must be calculated within the account’s placement class or
dedicated pool. It should not expose total fleet capacity or another user’s
account information.

#### Success measures

Track waitlist abandonment, median queue time by pool, proportion of users who
reload manually while waitlisted, and notification delivery/read rates.

### 3. Make setup resumable without persisting secrets in the browser — P0

#### Evidence

- The web onboarding form submits all choices in one request and redirects to
  GitHub in a new tab. It preserves selected agent checkboxes in
  `sessionStorage`, but not repository selections, non-secret preferences, or
  the user’s place in the form.
- OAuth flows save credentials server-side when they complete, while the page
  still presents the overall setup as a single unsaved form.
- The CLI caches its authenticated session, but `runOnboarding()` does not
  persist a partially completed agent/integration/repository setup.
- A browser refresh, closed tab, expired external flow, or terminal interruption
  can therefore force the user to reconstruct a long setup journey.

#### Proposed experience

Introduce a short-lived setup draft keyed to the authenticated account and
deployment:

- persist only non-secret state: selected agents, repository names, SSH-key
  choice, and which optional sections were reviewed;
- show server-side credential connections as “saved for this setup” without
  returning values to the browser;
- restore the draft after GitHub/OAuth callbacks and after a reload;
- provide “Clear setup draft” and an expiry (for example, 24 hours); and
- show a final review page that lists every selected integration and repository
  before dispatching provisioning.

The CLI should use the same conceptual checkpoints and support a safe resume
after a network or terminal interruption. Secret values should remain in the
existing encrypted server-side store or be entered again; do not place them in
local JSON session state or browser storage.

### 4. Add a first-run readiness checklist and a connection helper — P0

#### Evidence

- The dashboard’s connection card correctly withholds the endpoint until a key
  exists, then offers an SSH command and fingerprints.
- New users without a key must choose between a manual key form and a long
  agent prompt. The first-login checklist exists in `/etc/motd`, but it is not
  visible in the web dashboard.
- The CLI can optionally write a `Host workbench` block, but the web flow does
  not offer a generated config block or a “verify connection” sequence.

#### Proposed experience

When the container first becomes Ready, show a compact, dismissible checklist:

1. Add or enroll a key.
2. Copy the SSH command or `Host workbench` config.
3. Verify the host fingerprint on first connection.
4. Connect a repository or enter `~/repos`.
5. Launch the selected agent and open the dashboard from the MOTD.

Offer copyable artifacts for both shell users and coding agents:

- the current SSH command;
- a safe `~/.ssh/config` block using the selected key path; and
- a short verification command that does not transmit secrets.

Do not automatically write local files from the web. Keep the current explicit
copy-and-confirm model and make the checklist disappear only after the user
dismisses it or a successful connection signal is deliberately added later.

### 5. Provide export and recovery before destructive actions — P0

#### Evidence

- The Terms, dashboard confirmations, README, and runbook all state that
  rebuild/destroy or host loss can permanently remove data.
- `destroy` deletes both the Incus container and the persistent home volume;
  rebuild preserves `/home/dev` but removes the disposable root filesystem.
- The current release has no backup, snapshot replication, restore, or user
  data export. Forced host retirement explicitly queues a clean replacement
  environment and does not recover host-local data.

#### Proposed experience

Ship a staged safety feature before encouraging more destructive lifecycle use:

- an export page with an explicit scope: `/home/dev`, selected repositories,
  configuration metadata, or a full provider-specific archive;
- copyable `rsync`/`scp` commands and a CLI export command for large data;
- an export manifest containing size, timestamp, workbench ID, and restore
  notes, but never credential values;
- a pre-destroy/rebuild checklist that explains exactly what survives;
- optional encrypted snapshots with a documented retention period; and
- a recovery/grace window for accidental destroy if the storage backend can
  support it safely.

The first version can be user-driven export rather than hosted backup. The
important UX improvement is to make “destroy” a decision informed by a real
artifact, not only a warning dialog. Long term, implement encrypted ZFS
snapshots/replication and a tested restore path before advertising recovery.

### 6. Replace the post-provision credential cliff with scoped management — P1

#### Evidence

- `apps/worker/src/auth.ts` intentionally locks credential changes once a
  container row exists.
- The account page offers only “Delete saved credentials”, and the dashboard
  reports presence without provider-level actions.
- The daemon already supports full-snapshot `refresh-credentials`, per-provider
  managed files, fingerprints, and clearing removed credentials. The protocol
  therefore has useful primitives for a safer management surface.
- The current MOTD tells users to change credentials with manual terminal
  commands, which is a large drop in usability for the beginner audience.

#### Proposed experience

Add an account “Integrations” page or section with one row per provider:

- connected/not connected, provider account label where safe, and last sync
  result/time;
- connect, rotate, disconnect, and retry actions per provider;
- a clear explanation of where the credential will be available in the
  container and which operations it can authorize; and
- a separate “remove all credentials” action retained as a danger-zone escape
  hatch.

Use provider-specific scopes and revocation semantics. A failed sync should
  leave the previous working credential in place and show “saved in the
  control plane; pending on the workbench” rather than implying success.
  Preserve the current rule that local CLI-owned rotations are not overwritten
  by an unchanged dashboard snapshot.

### 7. Turn GitHub repository setup into a lifecycle feature — P1

#### Evidence

- GitHub selection is available only before the first container row exists;
  `GET /api/github/repos` is explicitly locked after provisioning.
- Repositories are cloned only during provision/rebuild, with a limit of 20 and
  a flat destination of `~/repos/<repository-name>`.
- The daemon correctly rejects duplicate destination names, but the user can
  learn about a collision only at submit/provision time rather than while
  selecting repositories.
- There is no repository status, branch selection, sync, detach, or retry UI.

#### Proposed experience

Add a Repositories section with safe, explicit operations:

- preflight destination collisions in the picker and explain the owner/name
  conflict before submit;
- show repository privacy, default branch, selected ref, clone status, and
  last sync result;
- add a repository after provisioning without rebuilding the whole rootfs;
- retry one failed clone independently; and
- remove only the integration metadata, never delete a local worktree without
  a separate, strongly confirmed action.

Begin with a “clone/sync into a new directory” operation. Avoid silently
resetting or pulling a user’s modified worktree; offer explicit fetch/pull
commands or a user-selected conflict policy later.

### 8. Make SSH devices auditable and easier to configure — P1

#### Evidence

- The API accepts a key `label`, but the dashboard’s add-key form does not
  collect one and `SshKeys` posts only `pubkey`.
- The dashboard displays the first 60 characters of the raw public key, with no
  fingerprint, created date, device label, sync status, or last-use signal.
- A key change queues a background sync and may fail/retry independently, but
  the UI gives no per-key synchronization result.
- The CLI has a managed SSH config block, while the web flow has only the raw
  command.

#### Proposed experience

For each key, show a short SHA-256 fingerprint, label, creation date, source
(`onboarding`, `manual`, or `enrolled`), and current sync state. Add:

- label-at-add and rename;
- copy fingerprint/public key;
- per-device revoke with a clear “access will stop after sync” state;
- a generated config block and a `known_hosts` verification hint; and
- a visible warning if a key synchronization job is pending or failed.

If last-use telemetry is added, collect only a safe timestamp and do not log
source IPs by default. Preserve the current endpoint-hiding behavior until an
authorized key exists.

### 9. Expand account security from a passkey count to a security console — P1

#### Evidence

- The account page displays only the number of passkeys and an “Add another
  passkey” action.
- Better Auth stores passkey names, creation metadata, and account sessions in
  D1, but no user-facing list or revoke action is exposed.
- Account deletion warns users about irreversible eligibility consequences,
  yet there is no session/device review to help them recover from a lost or
  compromised device.

#### Proposed experience

Add a Security page with:

- named passkeys with created/last-used timestamps;
- rename and revoke controls, with a guard against removing the final recovery
  method without a fresh confirmation;
- active sessions with device/browser and last-seen time, plus “sign out other
  sessions”; and
- a recent security activity summary for sign-in, passkey addition, key
  changes, integration connection, and account deletion attempts.

Avoid displaying sensitive raw user-agent or IP data unless there is a clear
privacy rationale. This feature should be paired with a recovery runbook for
users who lose every passkey.

### 10. Give the CLI a durable role after onboarding — P1

#### Evidence

- `packages/usebench-cli` currently centers on a single onboarding wizard and
  stores only a session cookie locally.
- The Worker already exposes authenticated lifecycle, key, notification, and
  credential-presence APIs that can support a small management CLI.
- The web and CLI have subtly different status presentation: the CLI prints
  raw states such as `waitlisted` and `provisioning`, while the web maps them to
  beginner labels.

#### Proposed experience

Add focused commands rather than another long wizard:

```text
npx usebench status
npx usebench open
npx usebench ssh configure
npx usebench ssh keys
npx usebench workbench start|stop|rebuild|destroy
npx usebench export
npx usebench doctor
```

Each command should support a human-readable mode and a stable `--json` mode.
`doctor` can check session validity, DNS/TLS reachability, local `ssh`, the
configured host entry, and whether the displayed host fingerprint is present
in `known_hosts`; it must not read private keys or print credential material.

Reuse the web’s human status labels and error taxonomy. Keep destructive CLI
actions opt-in with an explicit confirmation or `--yes` requirement.

### 11. Make plan and capacity behavior legible before paid expansion — P2

#### Evidence

- The landing page shows the free tier and labels the larger tier “coming soon”.
- Paid and dedicated entitlements are operator-managed, and users cannot
  self-serve upgrades or see a plan-change workflow.
- Re-homing deliberately destroys the old instance before returning the row to
  the matching FIFO pool; this has major durability and wait-time implications.

#### Proposed experience

Before enabling self-service billing, add a transparent plans/capacity page:

- advertised versus enforced CPU reservations explained in plain language;
- current placement class and whether the account is waitlisted;
- what changes during an upgrade/downgrade, including the rebuild/re-home and
  data-preservation rules;
- estimated admission behavior without promising an availability SLA; and
- an operator/request path for dedicated capacity.

When Stripe is eventually added, make billing, entitlement, re-home, grace
period, export, and dunning one coherent workflow rather than exposing a
payment button before the lifecycle semantics are ready.

### 12. Treat multiple workbenches and browser access as deliberate later bets — P2

The current one-environment-per-account and SSH-first model is coherent. If
research shows demand, two larger capabilities are natural extensions:

- multiple named workbenches for separate projects, each with its own keys,
  repositories, credentials, and plan/placement state; and
- a browser terminal or emergency shell for users who cannot install or use
  SSH locally.

Both need strong boundaries before implementation. Multiple workbenches affect
unique-account invariants, capacity, billing, deletion, and dashboard
navigation. A browser terminal introduces a new command-execution and secret
exposure surface and should reuse the daemon’s least-privilege model rather
than becoming an unrestricted Incus proxy.

## Technical and operational improvements

This is intentionally a smaller section. These items improve reliability,
security, and operator confidence without requiring all product features above
to ship first.

### A. Make job execution durable across daemon restarts

The daemon’s `JobRunner` and replay nonce store are in memory. The reconciler
eventually turns a lost job into a visible error, but a restart still creates a
failure window and the current 15-minute timeout is a poor substitute for a
durable queue.

Consider a durable dispatch record with a host generation, attempt count,
lease, daemon job ID, and idempotency key. A D1-backed outbox, Cloudflare Queue,
or host-local spool can then safely redeliver after Worker or daemon failure.
Persist only non-secret metadata; continue sealing credential payloads per
delivery. Persisted replay protection or a private ingress path should replace
the current process-local nonce store.

### B. Establish backups, restore drills, and a host-loss policy

Encrypted production ZFS, D1 exports, retention, key-unlock recovery, and
restore tests should be treated as a product capability, not only an
infrastructure note. Start with:

- encrypted, versioned home-volume snapshots;
- off-host replication with a separate key and access policy;
- D1 backup/export and migration-compatible restore procedures;
- a user-visible retention and recovery policy; and
- a destructive quarterly restore drill covering a full host loss.

Do not advertise “persistent” as durable backup until a restore has been
rehearsed and the user-facing RPO/RTO expectations are documented.

### C. Add end-to-end telemetry, alerting, and an error taxonomy

`SPEC.md` lists useful success measures, but the current operational limitations
explicitly include no automated alerting or SLO reporting. Add privacy-reviewed
metrics for:

- authentication-to-SSH time;
- queue wait by placement pool;
- provision phase latency and retry rate;
- daemon reachability, host health transitions, and reconcile duration;
- D1 read latency and dashboard polling volume; and
- capacity utilization by CPU, RAM, disk, swap, and tenant ceiling.

Give every lifecycle operation a sanitized correlation ID and map raw daemon
errors to a small stable taxonomy. Alert on stuck jobs, repeated host health
failure, capacity accounting drift, failed credential sync, certificate
expiry, and backup/replication lag.

### D. Close the image and agent supply-chain gap

The base image and fallback installers resolve agent npm packages at build or
fallback time. Move to a versioned manifest with exact package versions and
lockfile metadata, immutable image identifiers, reproducible build inputs,
SBOM generation, vulnerability scanning, and signed release evidence. Record
the selected agent versions in non-secret container metadata so support can
distinguish an image issue from an upstream package change.

### E. Reduce public daemon exposure and remove certificate-renewal restarts

The daemon is intentionally public and currently relies on TLS plus signed
requests. A private network path or mTLS with per-host identities would reduce
attack surface and make origin validation stronger. Independently, replace the
current certificate-renewal restart hook with hot reload or a drain-aware
reload so certificate maintenance does not discard in-memory jobs.

Keep signed requests even after mTLS: they provide application-level
authorization and replay semantics rather than only transport identity.

### F. Add database retention and performance hygiene

Completed job rows are used for latest-state and drift/version gates, but the
production code has no general retention path for old jobs. Add a retention
policy that archives or compacts terminal history only after it is no longer
needed by reconciliation and user activity views. Keep an immutable audit
summary for support and security events.

Review indexes and query plans as the fleet grows, especially for jobs by
container/status, waitlist ordering by placement class, host health scans,
notification reads, and expired-state cleanup. Add bounded cleanup for stale
notifications, port quarantine entries, and any future event tables without
deleting evidence required for incident review.

### G. Automate a real-Incus release and disaster test lane

The fast suite intentionally mocks Incus and external providers, and the
repository states that there is not yet an automated real-Incus nightly suite.
Keep the fast tests, but add a disposable Linux/Incus lane that exercises:

- provision-to-SSH and host-key verification;
- reboot and daemon restart with running and stopped tenants;
- disk, RAM, process, network, and east-west isolation;
- credential/key synchronization and local credential rotation;
- rebuild persistence and forced host retirement; and
- rollback, restore, and certificate renewal behavior.

The lane should emit the same evidence artifacts the runbook asks operators to
record, so manual staging checks become reviewable rather than purely
procedural.

### H. Add canary and release-readiness automation

The sequential `hostctl` release process is a good safety baseline. Add a
preflight that checks migration compatibility, image/version manifests,
certificate expiry, backup freshness, and zero active jobs, then deploy one
representative host per class as a canary. Require a real provision/start/stop
smoke test and one reconciler pass before proceeding. If the canary fails,
leave the remaining fleet untouched and publish the exact failed host/job
correlation ID.

## Suggested delivery sequence

### Next release

- Lifecycle activity timeline with safe error categories and correlation IDs.
- Waitlist position and in-product admission/ready/failure events.
- Resumable non-secret setup draft for web and CLI.
- First-run connection checklist, config-block copy, and export warning copy.
- Metrics for time-to-SSH, queue wait, phase latency, and host/job health.

### Following release

- User-driven export plus a restore-oriented CLI command.
- Per-provider credential connect/rotate/disconnect and sync status.
- Repository management with clone preflight and per-repository retry.
- SSH key labels/fingerprints/sync state and passkey/session management.
- Durable job dispatch design and a real-Incus test lane.

### Later, after durability and measurement

- Replicated backups and tested restore service.
- Self-service billing and plan re-home workflow.
- Ongoing CLI management commands.
- Multiple workbenches or browser terminal, based on observed demand.

## Review references

- Product and architecture contract: `SPEC.md`, especially sections 3, 4, 6–12,
  14, and 15.
- Product limitations and setup flow: `README.md` sections “User flow” and
  “Current limitations”.
- Existing visual review and completed design work:
  `specs/ui-ux-review.md`.
- Worker lifecycle and reconciliation:
  `apps/worker/src/api.ts`, `jobs.ts`, `placement.ts`, `reconciler.ts`,
  `state.ts`, and `container-view.ts`.
- Browser UX:
  `apps/worker/src/pages/views.tsx`,
  `apps/worker/client/onboarding.ts`, `dashboard.tsx`, `dashboard-ssh.tsx`,
  `security.ts`, and `account.tsx`.
- Terminal UX: `packages/usebench-cli/src/onboarding.ts`, `session.ts`, and
  `ssh.ts`.
- Host execution and isolation:
  `apps/daemon/src/jobs.ts`, `provisioner.ts`, `incus.ts`, and `motd.ts`.
- Operational constraints and acceptance evidence:
  `infra/RUNBOOK.md` and `infra/MULTITENANT_TESTING.md`.

