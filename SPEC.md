# Codestation — Current Release Specification

**Status:** Normative current-release specification

**Version:** 4.1

**Date:** 2026-07-18
**Product:** Beginner-friendly, preconfigured remote environments for agentic coding

This document describes the product that is intended to ship now. Anything
listed under Roadmap is not a current-release promise or release gate.

---

## 1. Product contract

Codestation gives a developer a persistent, SSH-accessible Debian environment
with the tools and coding agents needed for agentic development already
installed. A beginner should be able to go from sign-in to provisioning after
only two product decisions after authentication:

1. sign in with World ID or use an administrator invite with a required
   passkey; and
2. choose one or more coding agents.

SSH keys, model credentials, GitHub, and Cloudflare credentials are optional
during onboarding. Model, GitHub, and Cloudflare credentials must be chosen
before the server is created; later changes use manual terminal commands. SSH
key management unlocks only after a successful build. The provisioning request
returns immediately and the dashboard explains every intermediate state.

### Product principles

- **Fast first success.** Remove network installs and credential setup from the
  critical provisioning path wherever possible.
- **Beginner legibility.** Use plain language, safe defaults, copyable commands,
  specific errors, and explicit consequences for destructive actions.
- **Agent-ready by default.** Debian, the development toolchain, Pi, Claude
  Code, Codex, and OpenCode are baked into the base image.
- **Bring your own model access.** Codestation does not subsidize inference.
- **Defer optional setup.** A missing credential never blocks provisioning.
- **Fail visibly.** A failed operation reaches an error state with a retry or
  recovery path; it never leaves an indefinite spinner.
- **Honest infrastructure.** The product is a VPS-like Incus system container,
  not a hardware-isolated virtual machine.

### Honest isolation boundary

Each environment is an Incus system container with its own Debian userspace,
systemd, resource limits, home volume, SSH host keys, and forwarded SSH port.
Containers share the host kernel. Isolation is provided by Linux namespaces,
cgroups, seccomp, and AppArmor rather than KVM or another hypervisor.

---

## 2. Users and jobs

### Primary users

| User | Need |
|---|---|
| Beginner developer | A working remote coding box without learning VPS administration first |
| Agent-first developer | A persistent Linux environment a local coding agent can operate over SSH |
| Multi-device developer | One stable workspace reachable from any trusted device |

### Jobs to be done

1. Create a ready-to-use coding environment in minutes.
2. Connect from a terminal or let a local coding agent enroll an SSH key.
3. Choose optional model, GitHub, and Cloudflare credentials during setup, then
   use terminal commands for later changes.
4. Stop, start, rebuild, or destroy the environment with clear data-loss
   boundaries.
5. Understand whether the environment is waiting, building, ready, stopped, or
   needs attention.

---

## 3. Current scope and roadmap

### Current release

- World ID proof-of-human authentication with World ID 4.0 and Orb v3 support,
  passwordless passkey login, and single-use administrator invite signup.
- One free environment per account.
- Free resources, as presented in the web interface: 1 vCPU, 2048 MiB RAM,
  an 8 GiB persistent home volume, and an 8 GiB disposable root filesystem.
  The daemon provisions a 2-vCPU Incus limit for developer experience; this
  provisioned limit is intentionally different from the presented allocation.
- Debian 13, SSH, a standard development toolchain, and four coding agents.
- Pi, Claude Code, Codex, and OpenCode selection.
- Optional SSH key, enrollment-token flow, model credentials, Cloudflare token,
  Codex subscription sign-in, and optional GitHub App integration with
  repository selection and automatic cloning.
- Asynchronous provision, start, stop, rebuild, destroy, key-sync, and
  credential-refresh jobs.
- Automatic FIFO waitlist admission when host capacity becomes available.
- Dashboard status, a key-gated SSH command and host-key fingerprints,
  post-ready key management, read-only credential presence, lifecycle controls,
  and account deletion.
- One deployed control-plane Worker and one small development Incus host.

### Explicitly not in the current release

- Paid plans, Stripe, email notifications, dunning, or paid upgrades.
- Backups, snapshot replication, restore after host loss, or live migration.
- A web terminal or browser IDE.
- More than one environment per account.
- Multi-region placement or automatic host creation.
- Docker-in-container or nested virtualization.
- Hardware-VM isolation.
- Guaranteed availability or support response times.

### Roadmap, not a commitment

- A paid tier with in-place resource upgrades, Stripe, email, and a documented
  grace/export policy.
- Encrypted production storage, replicated backups, and restore tooling.
- Multiple production hosts, draining and capacity automation, and regional
  placement.
- mTLS or private connectivity to host daemons.
- Per-container bandwidth shaping, sustained-CPU abuse controls, and richer
  telemetry.
- Web terminal, additional agents/providers, and multiple environments.

---

## 4. Beginner experience

### 4.1 Sign in

The landing page explains the available authentication paths and key service facts:

- World ID can prove one human per account without an email;
- returning accounts with a passkey can sign in directly;
- an administrator invite is single-use and requires creating a passkey;
- the current service is free and needs no credit card; and
- the environment is a shared-kernel cloud container.

For a new sign-in, the user proves the fixed `codestation-login` action with a
v4 proof-of-human credential or the Orb v3 fallback. The action-scoped
nullifier is normalized and reused for later sign-ins. A browser that already
holds a v4 session ID continues to use the session-proof path.

An eight-character uppercase alphanumeric invite is generated only through the
administrator script. Entering a valid unused code starts passkey registration.
The code remains unused if registration is cancelled or fails. Successful
WebAuthn verification atomically persists the user, initial passkey, and
redemption before creating an application session. Invite-backed accounts have
no reusable invite login and use a discoverable passkey to return.

The landing page also supports usernameless passkey authentication. A new World
ID user is offered an optional passkey after first sign-in and may skip it;
World ID remains a valid return path. Account security remains available later
to add additional passkeys. Invite-backed accounts are advised to add a second
passkey as a recovery option.

### 4.2 Configure and launch

The onboarding screen has one required field: at least one agent from Pi,
Claude Code, Codex, and OpenCode. All other fields are visibly optional:

- SSH public key;
- OpenAI, Anthropic, Gemini, or OpenRouter API key;
- Claude subscription token;
- Codex ChatGPT-plan sign-in or auth.json paste;
- Cloudflare API token; and
- GitHub App authorization and repositories to clone, when configured.

Agent choices include a plain-language description and a beginner-oriented
recommendation without hiding the other choices.

All four binaries are present for fast startup. The selected set records the
user's preferred agents and drives dashboard wording, MOTD guidance, credential
emphasis, and missing-binary verification. The selected set is fixed for the
environment, although a user can run any baked binary.

The interface explains where a beginner can find an SSH public key and offers
the agent-assisted enrollment path when they do not have one. Secret fields use
password inputs and are never echoed back.

Submitting valid choices returns HTTP 202 with the initial container view. It
does not wait for Incus or package installation.

### 4.3 Provisioning, waitlist, and readiness

- With capacity, the environment enters provisioning immediately.
- Without capacity, it enters waitlisted and retains the selected agents and
  optional setup.
- The reconciler admits waitlisted users automatically in FIFO order by
  requested_at, then container created_at, with user_id as the final
  deterministic tie-breaker.
- Admission reserves host RAM, disk, and an SSH port before it marks the
  waitlist row admitted and enqueues the provision job. A failed reservation
  must leave the user waitlisted rather than oversubscribe a host.
- The dashboard explains that admission is automatic and keeps checking without
  requiring a reload.
- Success shows the exact SSH command and SSH host-key fingerprints once an
  authorized key exists; without a key, it guides the user to manual or
  agent-assisted key setup without exposing the endpoint.
- Failure shows a short, non-secret error and a Retry action.

The provisioning target is three minutes from submit to SSH-ready on a healthy
host with a warm base image. It is a target, not an availability guarantee.

### 4.4 Dashboard loading and polling

The dashboard makes one aggregate bootstrap request for the container view,
credential-presence summary, SSH keys, and integration availability. After
bootstrap:

- only the container endpoint is polled while a container is waitlisted, a job
  is queued or running, or the container is transitioning;
- a non-overlapping timeout polls active jobs/transitions every five seconds
  and a waitlisted container every thirty seconds;
- at most one scheduled poll may exist;
- polling stops in a steady state;
- transient failures retry without clearing useful content;
- polling pauses while the document is hidden and resumes immediately when it
  becomes visible;
- enrolling a key or opening a key form must not reset the poll loop or erase
  in-progress user input; and
- a page reload reconstructs the correct state from D1 and the daemon.

Poll updates render only container status, connection details, and dependent
danger-zone state. They do not rerender the credential section, SSH-key list,
inline forms, or an enrollment prompt, except when a successful build unlocks
SSH-key controls. The dashboard orders the environment summary first, SSH
Access second, and credentials after access. Credential presence is read-only:
the dashboard directs users to manual terminal commands for changes. SSH Access
offers manual-key guidance and agent-assisted enrollment only when the server
is Ready. The SSH command and the then-available enrollment prompt have
explicit copy controls.

Machine states are rendered with human labels: Ready, Building, Waiting for
capacity, Stopped, Suspended, Upgrade pending, Needs attention, and Deleting.
Raw state names may be available to APIs but are not the primary beginner-facing
copy.

Mutations refresh only the affected dashboard data plus the container view when
the mutation creates a job.

### 4.5 Accessibility requirements

The sign-in, onboarding, dashboard, dialogs, and lifecycle controls must be
usable with keyboard alone. Specifically:

- inputs have programmatic labels and related choices use fieldset and legend;
- the document has a main landmark and a keyboard skip link;
- focus is visible and follows opened inline forms or validation summaries;
- status and error changes are announced through a polite live region without
  repeatedly announcing every poll;
- busy controls expose their busy/disabled state and cannot submit twice;
- color is not the only status signal;
- copy buttons report success in text;
- destructive confirmations name the action and its irreversible consequence;
- motion respects prefers-reduced-motion; and
- core text and controls meet WCAG 2.1 AA contrast targets.

---

## 5. Identity and sessions

### World ID

New v4 sign-ins create a proof-of-human session and returning v4 sign-ins prove
that session; the verified RP-scoped `session_id` is the durable account
identity. A user whose World App cannot create a v4 session receives the
fixed-action `codestation-login` proof-of-human request with
`allow_legacy_proofs` enabled, preserving the Orb v3 migration fallback. The
backend normalizes and stores only the verified v3 fallback nullifier. It never
uses a v4 uniqueness nullifier as a reusable login identity. Existing World ID
accounts can replace their old identity with a verified v4 session while their
Codestation login remains active.

World ID identifiers live in auth_identities under the `world_id` provider and
are unique provider subjects; they are not columns on the user profile.
Internal relationships use a generated user UUID. Each user also has a random,
non-identifying 32-byte WebAuthn user handle.

For an abuse ban, the service stores an HMAC-SHA256 of the canonical identity
key in banned_nullifiers. This keyed value may remain after account deletion
solely to prevent immediate re-signup by a banned identity.

### Invites and passkeys

- Invite codes contain exactly eight random uppercase alphanumeric characters.
- `INVITE_ADMIN_SECRET` is a high-entropy Cloudflare Worker secret. The
  generation endpoint requires it as a bearer token and compares fixed-size
  hashes in constant time.
- D1 stores only each invite's HMAC-SHA-256, keyed by the Worker secret so a
  D1-only leak cannot be searched offline. A redemption record persists after
  account deletion so the code cannot become reusable. Rotating the secret
  invalidates outstanding unused invites.
- The raw code is returned once to the administrator script and is never logged.
- Passkeys are discoverable credentials with resident keys and user
  verification required. D1 stores credential ID, public key, counter,
  transports, device type, backup state, and non-secret timestamps.
- Registration and authentication challenges expire after five minutes. D1
  stores only a hash of the HttpOnly ceremony cookie, and `DELETE ... RETURNING`
  consumes each challenge before verification to prevent replay.
- WebAuthn verifies the exact request origin and RP hostname. Production
  ceremonies require HTTPS; HTTP is accepted only for localhost development.

### Application sessions

- A successful World ID, invite-registration, development, or passkey flow
  creates a random 32-byte session ID.
- Session data lives in KV with a seven-day TTL.
- The cookie is HttpOnly, SameSite=Lax, Path=/, and Secure on HTTPS.
- Logout deletes KV state and records the session-ID hash in D1.
- Sensitive operations, including account deletion, check the D1 revocation
  record because KV is eventually consistent.

### Local development login

DEV_AUTH=1 may expose a visible local-only development login. Deployed
environments keep DEV_AUTH=0.

---

## 6. Container and toolchain

### Base image

The codestation-base image is Debian 13 and contains:

- openssh-server, sudo, git, GitHub CLI, build-essential, CMake, and OpenSSL and SQLite development libraries;
- Python 3, virtual environments, and uv;
- system-wide Node.js 22;
- curl, rsync, zsh, tmux, ripgrep, fd, bat, jq, zip, unzip, sqlite3, nano, tree, less, and manpages;
- unattended-upgrades; and
- Pi, Claude Code, Codex, and OpenCode installed from the package versions that
  were current when the image was built.

The image has a non-root dev user with passwordless sudo. SSH password and root
login are disabled. Baked SSH host keys are removed so each new environment
generates unique keys.

Provisioning verifies every selected agent binary. It runs a missing-only
fallback installer only when a selected binary is absent. It must not reinstall
or upgrade agents already present in the image. This keeps normal provisioning
independent of the npm registry while still recovering from an incomplete or
older image.

The daemon records the selected set in the container and uses it for subsequent
MOTD refreshes. Key or credential synchronization must not silently change the
guidance from the selected agents to every baked binary.

If personalization fails after Incus initialization, the daemon removes the
partial disposable root filesystem and SSH proxy but preserves the separately
managed home volume so Retry can start cleanly without deleting user data.

### Provisioning sequence

The daemon:

1. creates or reuses the quota-limited home volume;
2. initializes a fresh root filesystem from codestation-base;
3. caps the root filesystem, applies CPU/RAM limits, and enables boot.autostart;
4. mounts the volume at /home/dev;
5. adds the host-to-container SSH proxy;
6. starts the container and waits for systemd;
7. writes authorized keys and credentials;
8. clones selected GitHub repositories into `/home/dev/repos/name`;
9. writes the first-login checklist;
10. verifies selected agents and installs only missing ones; and
11. returns SSH host-key fingerprints.

No SSH key means no authorized_keys file and therefore no usable SSH login.

### Rebuild and persistence

Rebuild replaces the root filesystem and reattaches the existing /home/dev
volume. Files elsewhere are lost. Credentials and SSH keys are re-synchronized,
and selected agents are verified against the new image. Destroy removes both
the container and its home volume permanently.

---

## 7. SSH and enrollment

Each placed environment receives one host TCP port forwarded to port 22 in the
container. Once the user has an authorized key, the dashboard displays:

    ssh -p PORT dev@HOST

It also displays the generated host-key fingerprints for first-connection
verification. Without an authorized key, the dashboard withholds the host,
port, and connection command, and directs the user to add a public key manually
or generate an agent-assisted enrollment prompt. Released ports stay quarantined
for 30 days to reduce stale known_hosts confusion.

When the server is Ready and the user has no key, the authenticated dashboard
can mint a random single-use enrollment token:

- only its SHA-256 hash is stored;
- it expires after one hour;
- the public enrollment endpoint accepts the token and a valid SSH public key
  while the server remains Ready;
- redemption is atomic and can happen only once; and
- successful redemption enqueues a live key-sync job when a container exists.

Once the server is Ready, the dashboard supplies a copyable prompt that tells a
local coding agent to create an ed25519 keypair, transmit only the public key,
add a Host codestation entry to the local SSH config, and verify the connection.

---

## 8. Credentials and integrations

### Supported model access

- OpenAI, Anthropic, Gemini, and OpenRouter API keys.
- Claude Code subscription token.
- Codex ChatGPT-plan device-code sign-in.
- Advanced Codex auth.json paste fallback.

The Codex device flow reuses the Codex CLI client behavior. It is not a
separately registered third-party OAuth integration and could stop working if
the upstream flow changes. In-shell login and auth.json paste remain recovery
paths.

### Optional developer integrations

- A scoped Cloudflare API token is validated before storage.
- A GitHub App flow is shown only when its client ID, client secret, and valid
  public-page slug form a complete install-capable configuration. One
  **Connect or update GitHub** action opens the App installation chooser for a
  personal or organization account and its granted repositories, then GitHub
  continues into user authorization. Installation and authorization remain
  distinct GitHub grants but one product journey; there is no separate direct
  OAuth or destructive reauthorization action. A working token remains stored
  unless a replacement callback succeeds. The live App must be public and
  installable on any account, request OAuth during installation, use expiring
  user tokens, and request only read-only Contents permission (plus implicit
  Metadata). Organization approval, permission-change approval, and an active
  SAML session remain GitHub-side prerequisites where applicable.
- GitHub user-to-server access and refresh tokens are stored encrypted. The App
  installation itself is not an authentication credential. The control-plane
  reconciler refreshes expiring user access; the refresh token never goes to a
  host. The short-lived user access token configures `gh`; Git reuses it through
  `gh auth git-credential`, without a second `.git-credentials` token copy.
  Onboarding searches only repositories shared by the user and an App
  installation, revalidates selected names at submission, and clones at most 20
  during provision or rebuild. Ungranted private repositories remain invisible
  and fail revalidation.

### Storage and delivery

- D1 credential blobs use XChaCha20-Poly1305 under a 32-byte Worker secret.
- For host delivery, the Worker decrypts in memory and immediately seals JSON to
  that host's X25519 public key using ephemeral X25519, HKDF-SHA256, and
  XChaCha20-Poly1305.
- Credential plaintext is absent from job rows and must not be logged.
- The daemon opens the payload in memory and writes only the required
  in-container files.
- Managed files are owned by dev with mode 0600.
- SSH key changes use sync-keys and are available only while the server is
  Ready. Model, GitHub, and Cloudflare credentials are selected during setup;
  the dashboard does not modify them after a server row exists. Later changes
  require manual terminal commands.
- Presence APIs return booleans or account labels, never stored secret values.

Code run by the user or a coding agent inside the environment can read the
credentials available to that environment. Narrow scopes and short-lived
tokens reduce but do not remove this inherent risk.

---

## 9. Architecture

### Components

| Component | Current implementation |
|---|---|
| Web/control plane | One Hono application on Cloudflare Workers, serving SSR HTML and JSON APIs |
| Durable state | Cloudflare D1 |
| Session cache | Cloudflare KV |
| Reconciler | Worker Cron Trigger every five minutes |
| Shared contract | TypeScript package with Zod wire schemas, crypto, and signed-request helpers |
| Host daemon | Hono on Node.js 22 under systemd |
| Runtime | Incus system containers through the host-local CLI/socket |
| Storage | Per-environment Incus custom home volume on the host storage pool |

There is no separate Cloudflare Pages application in the current release.

### Worker-to-daemon RPC

The daemon exposes a narrow HTTPS API for health, stats, job submit, and job
status. Every request must carry an Ed25519 signature over method, path,
timestamp, random nonce, and body hash.

The daemon:

- accepts a publicly trusted TLS connection;
- verifies signatures with its configured Worker public key;
- rejects timestamps outside a five-minute window;
- records accepted nonces in memory for the replay window; and
- rejects repeated nonces while the process remains alive.

The nonce store is not persistent. A daemon restart clears it, so a previously
captured valid request could only be retried during the remaining timestamp
window. Persistent nonces, mTLS, private networking, and firewall restriction
to trusted ingress are hardening work, not current claims. The
daemon_cert_fp field is informational; the Worker does not pin it.

Credential payloads are independently sealed to the host, so TLS is not the
only protection for user secrets.

### Asynchronous jobs and convergence

D1 jobs contain identifiers, operation, status, timestamps, and a sanitized
error. They never contain credential payloads. The Worker constructs and sends
the signed request directly to the daemon, whose job registry is in memory.

The dashboard container poll and Cron reconciler fold daemon status back into
D1. A daemon restart can lose an active job; the next poll marks it failed with
a retry path. Other jobs time out after 15 minutes. The reconciler also:

- admits the FIFO waitlist;
- polls recent jobs even when no dashboard is open;
- refreshes GitHub credentials;
- expires old transient rows;
- processes the existing suspended-container cleanup rule; and
- compares running/stopped D1 state with daemon stats.

The daemon serializes queued work per container so two lifecycle or
configuration jobs cannot mutate the same environment concurrently. Repeated
delivery of the same job ID is idempotent only when the container and operation
also match.

### Placement

Only active, recently healthy hosts receive new environments. Placement
requires enough vCPU reservation capacity, enough unallocated disk for both
the home and root quotas, and enough non-reserved RAM. One failed daemon health
check immediately pauses new placement; three consecutive failures mark the
host unhealthy, and a later valid signed stats response recovers it. Hosts
retain a RAM reserve so future operations are not scheduled against every
available byte. CPU/RAM/disk accounting, port assignment, and FIFO admission
must be committed together so concurrent reconciler runs cannot
double-allocate capacity.

---

## 10. State and data model

### Container states

| State | Meaning |
|---|---|
| waitlisted | Configuration is saved; no host or port has been assigned |
| provisioning | A provision or rebuild job is active |
| running | SSH may be available when at least one key exists |
| stopped | User intentionally stopped the environment |
| error | A lifecycle operation failed; detail and recovery are shown |
| destroying | Permanent deletion is active |
| suspended | Reserved internal state; no current billing UI drives it |
| upgrade_pending | Reserved for a future paid upgrade flow |

Job states are queued, running, succeeded, and failed. Supported current user
actions are start, stop, rebuild, destroy, and retry where valid. Background
operations synchronize keys and credentials.

### Core D1 tables and invariants

| Table | Important invariant |
|---|---|
| users | Internal UUID primary key; random WebAuthn user handle; signup method |
| auth_identities | Unique external provider subject; at most one per user |
| passkeys | Credential ID unique; public key and monotonic signature counter |
| invite_codes | Keyed HMAC-SHA-256 only; raw eight-character code is never stored |
| invite_redemptions | One permanent redemption per invite; user link clears on account deletion |
| auth_challenges | Hashed ceremony cookie; five-minute expiry; atomically consumed |
| ssh_keys | Multiple public keys per user; never private keys |
| containers | user_id unique; at most one environment per account; selected GitHub repositories are non-secret JSON metadata |
| hosts | Capacity, status, SSH hostname, daemon endpoint, and X25519 public key |
| jobs | No secret or arbitrary payload column |
| credentials_encrypted | One encrypted credential bundle per user |
| enrollment_tokens | Hash only; one-hour expiry; single use |
| oauth_states | Short-lived, user-bound authorization attempts |
| waitlist | One row per user; requested_at ordering and admitted_at audit |
| port_quarantine | Host/port composite identity; 30-day hold |
| session_revocations | Hashes of revoked application sessions |
| banned_nullifiers | HMAC only, retained for abuse prevention |

All account foreign references use internal IDs. World ID identifiers are never
user primary keys or resource foreign keys.

---

## 11. Security and operations

### Current controls

- Public-key-only SSH and unique per-environment host keys.
- A dedicated restricted Incus project with aggregate CPU, memory, process,
  disk, and instance ceilings.
- Per-tenant 2-vCPU provisioned allowance, hard 2 GiB memory without swap,
  1024-process ceiling, isolated unprivileged idmap, an 8 GiB home-volume
  quota, and an 8 GiB root-disk quota. The web interface intentionally
  presents the free tier as 1 vCPU; host accounting continues to reserve that
  presented allocation alongside both disks.
- No nesting, privileged containers, raw low-level Incus configuration, or
  Docker-in-container support.
- NIC MAC/IPv4/IPv6 anti-spoofing, east-west port isolation, and a 100 Mbit/s
  per-tenant bandwidth ceiling.
- Host scheduler-debug and kernel-slab metadata are root-only to reduce
  cross-tenant container-name and kernel-information leakage.
- Host nftables drops forwarded outbound TCP port 25 and caps new outbound
  connections per source address.
- One shared host egress IPv4, disclosed as a shared-fate risk.
- Encrypted D1 credentials and host-sealed delivery.
- Signed daemon RPC with a short timestamp window.
- Browser responses use no-referrer, no-sniff, clickjacking, and unnecessary
  camera/microphone/geolocation restrictions.
- Account and ban identities separated from internal UUIDs.
- Self-service account deletion after the environment is destroyed.

### Account deletion

The account-delete control is disabled while a real host environment exists.
The user first destroys the environment, then confirms account deletion.
Deletion purges credentials, SSH keys, passkeys, external identities,
enrollment tokens, OAuth state, waitlist state, and the user row, and revokes
the current session. A hostless waitlisted row can be removed as part of
deletion. A prior abuse-ban HMAC and a used-invite redemption may remain.

### Current operational limitations

- The deployed host is a small development VPS with a 20 GiB file-backed,
  unencrypted ZFS pool. Its registered capacity fits only one current free
  environment after reserve. It is not a production storage design.
- There are no backups. Host or pool loss means permanent user-data loss.
- The daemon endpoint is public and currently relies on TLS plus signed
  requests; unsolicited probes are expected and are rejected.
- There is no mTLS binding or private network path.
- The daemon job registry and replay nonce store are in memory.
- The current Certbot deploy hook restarts the daemon, so an uncoordinated
  renewal can lose an active in-memory job.
- There is no automated alerting, SLO reporting, or tested disaster recovery.
- GitHub integration is absent when its application credentials are unset.
- The static development-bypass token is intentionally weaker than production
  World ID and passkey authentication.
- Agent packages and fallback installers currently resolve the latest npm
  release at image-build or fallback time. Exact version pins, recorded build
  metadata, and an SBOM are supply-chain hardening gaps.

Production host requirements are stricter: encrypted ZFS, documented key
loading after reboot, adequate reserve and disk, a trusted certificate,
restricted daemon ingress, monitoring, and tested restore/incident procedures.
See infra/RUNBOOK.md.

---

## 12. Non-functional requirements

| Area | Current requirement |
|---|---|
| Provision submit | Return an asynchronous response without waiting for the host |
| Provision latency | Target at most three minutes on a healthy warm host |
| Dashboard | One aggregate bootstrap request; container-only transitional polling |
| Read performance | Target p95 under 300 ms for ordinary D1-backed dashboard reads; measurement is not yet automated |
| Convergence | Recent jobs polled by dashboard and Cron; 15-minute stuck-job failure |
| Secret hygiene | No credential values in job rows, errors, Worker logs, or daemon logs |
| SSH | Public-key only; no authorized key means no access |
| Accessibility | Core flows satisfy the requirements in section 4.5 |
| Availability | Best effort; one host and no failover |
| Data durability | No backup guarantee in the current release |
| Compatibility | Current Chrome, Firefox, Safari, and Edge; responsive phone and desktop layouts |

---

## 13. Testing and release evidence

### Automated fast suite

The repository runs on Node.js 22 in CI:

    npm ci
    npm run typecheck
    npm test

Tests use Vitest. The Worker suite uses an in-memory node:sqlite database with
the real migration files, a Map-backed KV double, and intercepted fetch calls.
It does not use a live D1 database, Miniflare, World ID, GitHub, Cloudflare, or
an Incus host.

Real-host multi-tenant capacity, isolation, quota, reboot, health-quarantine,
and soak acceptance is defined in infra/MULTITENANT_TESTING.md.

Current automated coverage includes:

- shared schema, signing, replay-window, encryption, sealing, and tamper tests;
- World ID-backed account behavior through the gated development auth seam,
  bans, sessions, and revocation;
- admin-secret invite generation, HMAC-only invite storage, mandatory initial
  passkey persistence, one-time redemption races, optional World ID passkey
  attachment, passwordless login counters, and challenge replay rejection;
- state transitions, ports, placement, jobs, timeout/retry, waitlist admission,
  and reconciler logic;
- onboarding and lifecycle APIs, credential presence, key enrollment, account
  deletion, and external-call validation;
- Codex device-flow state and authorization binding;
- server-rendered page/script smoke tests;
- daemon config, RPC authorization, Incus command construction, provisioning,
  credentials, MOTD, agent fallback, and rebuild behavior.

### Manual release checks

The repository does not yet contain a nightly real-Incus E2E harness. Before a
public release, an operator must record:

1. a real or World ID simulator sign-in, optional passkey attachment, and
   subsequent passkey sign-in;
2. invite generation, invite signup with its required passkey, attempted invite
   reuse, and the all-optional-onboarding-fields-skipped path;
3. provision to SSH using a pasted key;
4. provision to SSH using enrollment;
5. command availability for all four agents and base tools;
6. fingerprint agreement between dashboard and SSH;
7. post-ready SSH key enrollment and terminal-based credential guidance;
8. stop, start, rebuild with /home/dev preserved, and destroy;
9. forced provision failure and retry;
10. automatic FIFO waitlist admission;
11. host reboot/autostart and daemon reconciliation;
12. port-25 and connection-rate enforcement;
13. keyboard-only and screen-reader status/error checks; and
14. deployment and rollback using infra/RUNBOOK.md.

Manual results are release evidence; they must not be described as automated
coverage.

---

## 14. Current-release acceptance criteria

A release is acceptable when all automated tests pass and the risk-proportionate
manual checks above have been completed for affected areas.

1. **Identity:** a valid v4 proof-of-human session or Orb v3 fallback creates
   or reuses the account for its verified identity; a valid invite is consumed
   exactly once only after its required passkey is verified; a World ID account
   may attach a passkey; either World ID or a registered passkey can reaccess
   the appropriate account; a banned identity is refused; logout revokes the
   application session.
2. **Fast onboarding:** agent selection is the only configuration requirement.
   Skipping every credential and SSH field still creates a provisioning or
   waitlisted environment.
3. **Image readiness:** the base image contains the complete toolchain and all
   four agents. Normal provisioning performs no agent package install; an
   intentionally missing selected binary triggers only its fallback installer.
4. **Provisioning:** successful provisioning produces a Debian 13 environment,
   enforced RAM/CPU/home/root limits, a persistent home volume, and any selected
   GitHub repositories cloned under `~/repos/name` with `gh` authenticated. A
   copyable SSH command and matching host-key fingerprints appear only after an
   authorized key exists.
5. **No-key safety:** without a key, SSH fails closed. After a successful build,
   a one-hour, single-use enrollment token can add a public key and allow SSH.
6. **Waitlist:** insufficient capacity produces a clear waitlisted state.
   Capacity release admits users automatically in deterministic FIFO order
   without double allocation.
7. **Dashboard efficiency:** initial load uses one aggregate request. Only the
   container view polls during transitional or waitlisted states using
   non-overlapping five-second or thirty-second schedules; one timeout is
   active, polling resumes after visibility/network interruptions, and key
   forms and enrollment output are preserved while available.
8. **Lifecycle clarity:** failures become error with useful sanitized detail
   and retry. Stop/start work, rebuild preserves /home/dev, and destroy removes
   the environment and volume.
9. **Configuration boundaries:** SSH keys can be added or removed after a
   successful build. Credentials are set during onboarding and are read-only in
   the dashboard after server creation; later changes require manual terminal
   commands. APIs never return secret values.
10. **Accessibility:** the core flow is keyboard operable, labels and state are
    programmatic, asynchronous changes are announced without poll spam, focus
    remains predictable, and reduced-motion/contrast requirements hold.
11. **Security:** passwords and root SSH are disabled; credential values are
    encrypted at rest, sealed to the host, absent from D1 jobs and logs, and
    written in-container with restrictive ownership/mode.
12. **Account deletion:** a user can destroy their environment and then purge
    account data; a hostless waitlist entry does not trap the account.
13. **Operations:** remote migrations are current, the daemon and Worker can be
    deployed and verified independently, and the documented rollback path has
    been exercised for any release that changes their shared contract.

---

## 15. Success measures

The primary product measure is median time from first successful account
authentication to first successful SSH connection. Supporting measures are:

- onboarding completion and optional-field skip rates;
- wait time and FIFO admission rate;
- provision duration and failure/retry rate;
- dashboard request count during steady and transitional states;
- enrollment success rate;
- active environments and recent SSH use; and
- host capacity, job timeout, and daemon reachability.

No analytics implementation is implied by this list; collection must be
privacy-reviewed before it is added.
