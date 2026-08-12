# usebench.dev — Current Release Specification

**Status:** Normative current-release specification

**Version:** 6.0

**Date:** 2026-08-01
**Product:** Beginner-friendly, preconfigured remote environments for agentic coding

This document describes the product that is intended to ship now. Anything
listed under Roadmap is not a current-release promise or release gate.

---

## 1. Product contract

usebench.dev gives a developer a persistent, SSH-accessible Debian environment
with the tools and coding agents needed for agentic development already
installed. A beginner should be able to go from sign-in to provisioning after
only two product decisions after authentication:

1. sign in with Google, GitHub, or a passkey, then verify a new account
   with World ID or an administrator invite; and
2. choose one or more coding agents.

SSH keys, model credentials, GitHub, Cloudflare, Supabase, and Convex credentials are optional
during onboarding. Model, GitHub, Cloudflare, Supabase, and Convex credentials must be chosen
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
- **Bring your own model access.** usebench.dev does not subsidize inference.
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
3. Choose optional model, GitHub, Cloudflare, Supabase, and Convex credentials during setup, then
   use terminal commands for later changes.
4. Stop, start, rebuild, or destroy the environment with clear data-loss
   boundaries.
5. Understand whether the environment is waiting, building, ready, stopped, or
   needs attention.

---

## 3. Current scope and roadmap

### Current release

- Better Auth account management with Google, GitHub, and passkey sign-in.
- World ID proof-of-human or single-use administrator-invite eligibility verification.
- One environment per account.
- A free tier with 1 vCPU, 1536 MiB RAM, 1024 MiB swap, a 5 GiB persistent
  home volume, and a 5 GiB disposable root filesystem. The public 1-vCPU plan
  is backed by an enforced and reserved 1-vCPU Incus allowance.
- A paid tier with 2 vCPU, 4096 MiB RAM, 1536 MiB swap,
  an 8 GiB persistent home volume, and an 8 GiB disposable root filesystem.
  The public 2-vCPU plan is backed by an enforced and reserved 2-vCPU allowance.
  Stripe-hosted self-service purchase and in-place upgrades are available only
  when the complete billing configuration and `BILLING_ENABLED` launch gate
  are enabled. An account's first self-service Paid subscription begins with a
  seven-day free trial before Stripe attempts the first charge. Dedicated service remains
  operator-entitled.
- Debian 13, SSH, a standard development toolchain, and four coding agents.
- Pi, Claude Code, Codex, and OpenCode selection.
- Optional SSH key, enrollment-token flow, model credentials, Cloudflare, Supabase, and Convex tokens,
  Codex subscription sign-in, and optional GitHub App integration with
  repository selection and automatic cloning.
- A publishable `usebench` terminal client. `npx usebench` provides a
  keyboard-driven alternative to the web onboarding flow, with browser-based
  Google/GitHub SSO, World ID QR or invite verification, agent authentication,
  GitHub repository selection, optional tool credentials, asynchronous status,
  and local SSH setup.
- Asynchronous provision, start, stop, rebuild, destroy, key-sync, and
  credential-refresh jobs.
- Automatic bounded-backfill FIFO waitlist admission when host capacity becomes
  available.
- Dashboard status, a running-Free in-place Premium upgrade CTA, a key-gated
  SSH command and host-key fingerprints, post-ready key management, read-only
  credential presence, lifecycle controls, and account deletion.
- One production control-plane Worker and a D1-registered fleet of heterogeneous
  Incus hosts, plus an isolated staging Worker, D1 database, secret set, and
  daemon trust domain at `staging.usebench.dev` for release validation. Shared
  hosts accept both Free and Paid resource shapes after reporting the mixed-tier
  capability. A dedicated host accepts only its assigned paid account and has
  exactly one tenant slot.
- An authenticated fleet controller for host onboarding, registration,
  drain/probe/state operations, destructive host evacuation and container
  re-homing, class changes, generation replacement, deregistration, policy
  audit, and sequential daemon rollout.

### Explicitly not in the current release

- Email delivery for application-specific billing notices, self-service
  dedicated purchase, refunds, metered billing, or arbitrary plan switching.
- Backups, snapshot replication, restore after host loss, or live migration.
- A web terminal or browser IDE.
- More than one environment per account.
- Multi-region placement, automatic host creation, or automatic evacuation.
- Docker-in-container or nested virtualization.
- Hardware-VM isolation.
- Guaranteed availability or support response times.

### Roadmap, not a commitment

- Email delivery, additional paid plans, and a legally reviewed grace/export
  policy.
- Encrypted production storage, replicated backups, and restore tooling.
- Regional placement, automated capacity acquisition, and host evacuation.
- mTLS or private connectivity to host daemons.
- Per-container bandwidth shaping, sustained-CPU abuse controls, and richer
  telemetry.
- Web terminal, additional agents/providers, and multiple environments.

---

## 4. Beginner experience

### 4.1 Sign in and verify

The landing page presents four account entry points: Sign in with Google, Sign
in with GitHub, Create passkey, and Use passkey. Better Auth
owns provider callbacks, account linking, passkey ceremonies, and application
sessions. Passkey-first registration uses a server-signed, ten-minute opaque
context; it never accepts a caller-chosen user ID. Passkeys are discoverable and
require both a resident key and user verification.

After authentication, an account without a saved workbench configuration goes
to `/configure`; an account with a saved configuration goes to `/dashboard`.
The dashboard summarizes an existing configuration and offers the Free and
Premium instance choices only after setup has been saved. `/onboarding` is a
compatibility redirect to `/configure` and is not part of the active user flow.

The verification screen offers World ID Proof of Human and a single-use
administrator invite. World ID 4.0-only requests are signed by the Worker, bind
the proof signal to the authenticated internal user ID, and are verified
through the Developer Portal. The verified nullifier is stored permanently so the same
person cannot verify another account. An invite is also verification evidence,
not an authentication credential: the account must already have a valid Better
Auth session before redeeming it. Every valid session continues to `/configure`
until it saves a workbench configuration, then returns to the dashboard.
Tier-specific authorization
is enforced only when the account creates an instance: Free requires permanent
verification and Premium requires a current paid/manual Premium entitlement.
An ineligible session may also access account security, billing status, hosted
Premium Checkout, and an existing workbench's lifecycle controls so an expired
paid owner can manage billing, export data, or destroy the workbench.

Public signup offers permanently eligible Free after World ID/invite
verification. When the billing launch gate is enabled, any authenticated owner
may start a seven-day Paid trial without gaining permanent Free eligibility.
Stripe collects the payment method in Checkout and charges it after the trial.
The browser
cannot submit a Price, Customer, subscription, tier, or placement mode; the
server derives those values from configured billing state. Dedicated service
is operator-managed. The landing page also states that the environment is a
shared-kernel cloud container. Account security allows authenticated users to
add backup passkeys at any time.

### 4.2 Configure and launch

Authentication continues to `/configure` until configuration is complete.
The configuration screen has one required field: at least one agent from Pi,
Claude Code, Codex, and OpenCode. All other fields are visibly optional:

- SSH public key;
- OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Kimi, MiniMax, Z.AI,
  or Vercel AI Gateway API key;
- per-agent Claude subscription sign-in for Claude Code, Pi, and OpenCode;
- per-agent ChatGPT-plan sign-in for Codex, Pi, and OpenCode;
- Cloudflare API token;
- Supabase personal or OAuth access token;
- Convex personal access token; and
- GitHub App authorization and repositories to clone, when configured.

Agent choices include a plain-language description without recommending one.
Pi and OpenCode each present separate **Sign in with ChatGPT** and **Sign in
with Claude** actions inside their agent choice.

All four binaries are present for fast startup. The selected set records the
user's preferred agents and drives dashboard wording, MOTD guidance, credential
emphasis, and missing-binary verification. The selected set is fixed for the
environment, although a user can run any baked binary.

The interface explains where a beginner can find an SSH public key and offers
the agent-assisted enrollment path when they do not have one. Secret fields use
password inputs and are never echoed back. The browser and CLI may save a
short-lived, account-bound setup draft containing only agent choices, selected
repository names, the setup step, and an SSH-key choice. Drafts expire after
24 hours, are deleted after configuration is saved or explicit clearing, and never
contain API tokens, OAuth tokens, authorization codes, or SSH key material.
Reloads and OAuth round trips restore that non-secret state. Credential
connections already stored server-side are shown as saved, and the user gets
a final review step with a **Save** action. A completed configuration persists
independently from its draft and does not allocate an instance.

The dashboard shows the completed configuration as an expandable summary, then
offers `1 vCPU 1.5GB RAM` for Free and `2 vCPU 4GB RAM` for Premium. Free
deployment requires permanent verification. Premium deployment requires a
current Premium entitlement. Verification and Premium are independent booleans,
yielding Unverified, Verified, Premium, and Verified premium account states.
An action that lacks its prerequisite leads directly to verification or hosted
Checkout. A valid deployment request returns HTTP 202 with the initial container
view and does not wait for Incus or package installation.

### 4.2.1 Terminal onboarding

`npx usebench` is a supported onboarding surface for a real TTY. It uses the
same account, verification, provisioning, and integration APIs as the web
flow. The CLI must:

- open Google or GitHub SSO in the user's browser and receive the result only
  through a short-lived, one-time loopback callback;
- offer World ID Proof of Human through a rendered QR code or accept an
  administrator invite code;
- provide keyboard selection for agents, per-agent Claude/ChatGPT sign-in,
  GitHub App authorization and repository selection, and the supported model,
  Cloudflare, Supabase, and Convex setup;
- persist only the Better Auth session cookie locally, under the user's config
  directory with restrictive permissions, and support clearing that session;
- resume from the server-side non-secret setup draft after interruption or a
  browser OAuth round trip; pasted secrets must be requested again, while
  already stored credential connections remain connected;
- reuse `~/.ssh/id_ed25519.pub`, generate
  `~/.ssh/workbench_id_ed25519` when requested, or continue without a key; and
- after a successful build, ask before adding a managed `Host workbench` block
  to `~/.ssh/config`. It must never overwrite an unrelated existing
  `Host workbench` block.

The terminal client does not receive OAuth provider secrets, World ID signing
keys, stored integration tokens, or credential plaintext from the Worker.
Browser SSO handoff records and exchange codes expire and are single-use.

### 4.3 Provisioning, waitlist, and readiness

- With capacity, the environment enters provisioning immediately.
- Without capacity, it enters waitlisted and retains the selected agents and
  optional setup.
- The reconciler uses one shared FIFO ordered by requested_at, container
  created_at, then user_id. It tries the oldest request first and may inspect at
  most eight later shared requests for bounded backfill. Each successful
  backfill increments the oldest row's skip count; after three skips the oldest
  cannot be bypassed. Dedicated account-bound placement remains independent.
- Admission reserves host CPU, RAM, disk, and an SSH port before it marks the
  waitlist row admitted and enqueues the provision job. A failed reservation
  must leave the user waitlisted rather than oversubscribe a host.
- The requested tenancy mode and legacy rollout class are persisted with the
  container row when it first waitlists; a later account-field change cannot
  silently move that request.
- The dashboard explains that admission is automatic and keeps checking without
  requiring a reload.
- Success shows the exact SSH command and SSH host-key fingerprints once an
  authorized key exists; without a key, it guides the user to manual or
  agent-assisted key setup without exposing the endpoint.
- Failure shows a short, non-secret error and a Retry action.

The provisioning target is three minutes from submit to SSH-ready on a healthy
host with a warm base image. It is a target, not an availability guarantee.

### 4.4 Dashboard loading and polling

The dashboard makes one aggregate bootstrap request for account state, saved
configuration, the container view, credential-presence summary, SSH keys, and
integration availability. After
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
SSH-key controls. The dashboard orders the configuration summary before
instance creation or the environment summary, with SSH Access after an instance
exists. Credential presence is read-only:
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

### Better Auth and passkeys

- Better Auth is mounted at `/api/auth/*` and is the only production owner of
  social OAuth identities, passkey records, and application sessions.
- Google and GitHub OAuth client IDs are public Worker variables; their client
  secrets and `BETTER_AUTH_SECRET` are Worker secrets.
- OAuth provider tokens are encrypted by Better Auth before D1 persistence.
- Passkey credential IDs are unique. D1 stores the public key, monotonic
  counter, transports, device type, backup state, AAGUID, and non-secret
  timestamps. WebAuthn verifies the exact request origin and RP hostname.
- Better Auth stores passkey ceremony values in its short-lived verification
  table and consumes them during verification. Production ceremonies require
  HTTPS; localhost development may use HTTP.

### Eligibility verification

- Invite codes contain exactly eight random uppercase alphanumeric characters.
- `INVITE_ADMIN_SECRET` is a high-entropy Cloudflare Worker secret. The
  generation endpoint requires it as a bearer token and compares fixed-size
  hashes in constant time.
- D1 stores only each invite's HMAC-SHA-256, keyed by the Worker secret so a
  D1-only leak cannot be searched offline. A redemption record persists after
  account deletion so the code cannot become reusable. Rotating the secret
  invalidates outstanding unused invites.
- The raw code is returned once to the administrator script and is never logged.
- Invite redemption and the user's `verified_at` update execute in one D1 batch.
  A unique code hash and unique user link prevent concurrent or repeated use.
- World ID uses an RP signing key held only by the Worker. The Worker rejects
  legacy v3 proofs, then checks the configured action and the user-bound signal
  hash before forwarding a proof to `POST /api/v4/verify/{rp_id}`. It persists
  the returned 256-bit nullifier as a canonical decimal string with a unique
  `(action, nullifier)` key.
- World ID nullifiers and invite redemptions remain after account deletion, with
  their former user link cleared, so eligibility evidence cannot be recycled.

### Application sessions

- Better Auth creates cryptographically random sessions after social OAuth or
  passkey authentication and stores them in D1 for seven days.
- The signed cookie is HttpOnly, SameSite=Lax, Path=/, and Secure on HTTPS.
- Session lookup and logout use the D1 record, so revocation and destructive
  account operations do not depend on an eventually consistent cache.
- Expired session and ceremony rows are pruned by the reconciler.

### Local development login

DEV_AUTH=1 may expose a visible local-only development login. Deployed
environments keep DEV_AUTH=0.

---

## 6. Container and toolchain

### Base image

The workbench-base image is Debian 13 and contains:

- openssh-server, sudo, git, GitHub CLI, build-essential, CMake, and OpenSSL and SQLite development libraries;
- Python 3, virtual environments, and uv;
- system-wide Node.js 22;
- curl, rsync, bash, zsh, tmux, ripgrep, fd, bat, jq, zip, unzip, sqlite3, nano, tree, less, and manpages;
- unattended-upgrades; and
- Pi, Claude Code, Codex, and OpenCode installed from the package versions that
  were current when the image was built.

The image has a non-root dev user with passwordless sudo. Bash is the default
login shell and its prompt shows the user name, machine name, and working
directory. Zsh is also installed and uses the same prompt when selected. Users
can opt into zsh, or switch back to Bash, with `sudo usermod --shell
/bin/zsh "$USER"` and `sudo usermod --shell /bin/bash "$USER"`. SSH password and
root login are disabled. Baked SSH host keys are removed so each new
environment generates unique keys.

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
2. initializes a fresh root filesystem from workbench-base;
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
volume. Files elsewhere are lost. Static credentials and SSH keys are
re-synchronized; unchanged CLI-owned OAuth snapshots preserve the newer tokens
rotated inside the persistent home. Selected agents are verified against the
new image. Destroy removes both the container and its home volume permanently.

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
add a Host workbench entry to the local SSH config, and verify the connection.

---

## 8. Credentials and integrations

### Supported model access

- OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Kimi, MiniMax, Z.AI,
  and Vercel AI Gateway API keys.
- Per-agent Claude subscription sign-in for Claude Code, Pi, and OpenCode.
- Per-agent ChatGPT-plan device-code sign-in for Codex, Pi, and OpenCode.

The ChatGPT device flow reuses the Codex CLI client behavior. It is not a
separately registered third-party OAuth integration and could stop working if
the upstream flow changes. In-shell login remains the recovery path.

### Optional developer integrations

- A scoped Cloudflare API token is validated before storage.
- Supabase personal and OAuth bearer tokens are validated through the
  Management API and exported as `SUPABASE_ACCESS_TOKEN` for the CLI.
- Convex sign-in opens the CLI's browser-token page and exchanges its
  short-lived authorization token for a personal access token. A personal token
  may also be pasted directly; it is validated through the CLI authorization
  endpoint. The resulting token is installed in `~/.convex/config.json`, and an
  unchanged dashboard token never overwrites a newer local Convex login.
- A GitHub App flow is shown only when its client ID, client secret, and valid
  public-page slug form a complete install-capable configuration. One
  **Connect or update GitHub** action opens the App installation chooser for a
  personal or organization account and its granted repositories, then GitHub
  continues into user authorization. Installation and authorization remain
  distinct GitHub grants but one product journey; there is no separate direct
  OAuth or destructive reauthorization action. A working token remains stored
  unless a replacement callback succeeds. The live App must be public and
  installable on any account, request OAuth during installation, use expiring
  user tokens, and request read-only Contents permission (plus implicit
  Metadata) and user-level SSH signing-key write permission. Organization
  approval, permission-change approval, and an active SAML session remain
  GitHub-side prerequisites where applicable.
- GitHub user-to-server access and refresh tokens are stored encrypted. The App
  installation itself is not an authentication credential. The control-plane
  reconciler refreshes expiring user access; the refresh token never goes to a
  host. The short-lived user access token configures `gh`; Git reuses it through
  `gh auth git-credential`, without a second `.git-credentials` token copy.
  When GitHub is configured, the daemon creates a persistent SSH signing key at
  `~/.ssh/workbench_github_signing_key`, idempotently registers its public half
  with the connected GitHub account, and sets `commit.gpgsign=true` with SSH
  signing as the global Git default. The private key never leaves the instance.
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
- CLI-owned ChatGPT and Wrangler OAuth stores rotate refresh tokens inside the
  persistent home. The daemon records a non-secret fingerprint of each applied
  dashboard grant and never replaces a locally rotated credential when that
  fingerprint is unchanged. A changed grant replaces only that provider, and
  removing a previously managed grant clears only its managed store. Existing
  homes without fingerprints adopt their local credentials during rollout.
- Convex uses the same fingerprint reconciliation rule so a later GitHub token
  refresh cannot replace a manually updated Convex CLI login.
- Every Claude and ChatGPT sign-in is bound to its intended agent and stored in
  a distinct encrypted credential slot. The daemon installs it only into that
  agent's auth store; it never seeds one OAuth credential into multiple
  independent clients. Each ChatGPT store has its own rotation fingerprint,
  and independently authenticated local stores are preserved during rollout.
- SSH key changes use sync-keys and are available only while the server is
  Ready. Model, GitHub, Cloudflare, Supabase, and Convex credentials are selected during setup;
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
| Web/control plane | One Hono application deployed as independent production and staging Cloudflare Workers, serving SSR HTML and JSON APIs |
| Durable state | Independent production and staging Cloudflare D1 databases |
| Identity and sessions | Better Auth with Cloudflare D1 and the passkey plugin |
| Reconciler | Worker Cron Trigger every five minutes |
| Shared contract | TypeScript package with Zod wire schemas, crypto, and signed-request helpers |
| Host daemon | Hono on Node.js 22 under systemd |
| Runtime | Incus system containers through the host-local CLI/socket |
| Storage | Per-environment Incus custom home volume on the host storage pool |
| Fleet operations | `infra/hostctl.sh` using the secret-authenticated Worker fleet API and management SSH |

There is no separate Cloudflare Pages application in the current release.
Staging is an operational environment, not a second production tenant pool.
Its Worker secrets, D1 state, daemon signing key, fleet administrator secret,
and host sealing keys are independent from production.

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

### Fleet administration

The `/api/admin/hosts` API is absent unless `FLEET_ADMIN_SECRET` is configured
and otherwise requires that separate high-entropy bearer secret, compared as
fixed-size hashes in constant time. It accepts validated public bootstrap
metadata, lists non-secret operational state, performs signed daemon probes,
updates conservative capacity only for drained hosts without active jobs or
below-reservation reductions, and controls draining/active/dead state. New
hosts are always inserted as draining. Activation requires a recent valid probe
and zero current failures; a dedicated host additionally requires an eligible
assigned dedicated account.
An empty drained host may change its legacy class/tenancy configuration only
together with a fresh capacity report and a new signed probe. An evacuated dead
ID may be replaced as a new generation, or deregistered, while immutable
history retains the old class, capacity, release, and hardware telemetry. No
raw D1 mutation is required.
A forced dead transition is a manual disaster action: it fails active jobs,
quarantines ports, detaches desired container rows, clears the dedicated
assignment and allocation counters, reconciles eligible accounts to their
current service plans, and returns them to the appropriate FIFO. It does not
copy host-local home data, so the failed machine must first be isolated.
A fleet-introducing migration also drains every legacy host until its inferred
class policy and daemon release have been deployed and explicitly verified.
A signed administrator probe requires explicit legacy class, tenancy mode,
mixed-tier capability, release identity, and CPU hardware telemetry, and
rejects a wrong host ID/mode/class or a RAM/vCPU registration that exceeds the
daemon's hardware report. The background reconciler alone tolerates omitted new
fields during a rolling interval and then applies legacy exact-class placement.
The API never returns a host credential private key because no such key leaves
the host.

`infra/hostctl.sh` is the supported mutation client. It discovers management
targets from D1, never copies local secrets or environment files, and deploys
hosts sequentially: drain and atomically fence new daemon jobs, require zero
active jobs, back up the old release and host configuration, copy
the clean checkout, install locked production dependencies, restart, audit,
probe the exact Git commit release, then restore hosts that began active. Any
failure and any host that began draining or unhealthy remains draining.
The same controller can orderly re-home one container by confirming data loss,
destroying its old Incus instance, then atomically applying the account's
current service plan and waitlisting it. This is an explicit administrative
path for tenancy changes and recovery; ordinary Free/Paid changes resize the
existing container in place. Unsupported subscription values are rejected
before mutation. Existing placements remain on their persisted actual tier
until a resize succeeds, so a billing event alone cannot make ordinary
lifecycle traffic diverge mid-job.

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
- retries in-place plan transitions and repairs stale canonical Stripe state;
- enforces trial, paid-through, optional grace, billing suspension, and
  explicitly configured export deadlines;
- expires old transient rows;
- processes the existing suspended-container cleanup rule; and
- compares running/stopped D1 state with daemon stats.

The daemon serializes queued work per container so two lifecycle or
configuration jobs cannot mutate the same environment concurrently. Repeated
delivery of the same job ID is idempotent only when the container and operation
also match.

### Placement

Only active, recently healthy hosts in the request's tenancy mode receive new
environments. The account service plan maps both `free` and `paid` to `shared`;
operator-entitled `dedicated` maps to an account-bound `dedicated` host while
retaining paid resource limits. `budget` and `regular` remain dual-written only
as rolling-release fallback labels. Dedicated hosts have `max_tenants = 1`;
shared hosts have an independently configured safety ceiling.

Placement requires all of the following at reservation time:

- an exact tenancy-mode match and, for dedicated, an exact assigned-user match;
- mixed-tier daemon capability on shared hosts, or an exact legacy class match
  during the rolling interval;
- a free tenant slot below `max_tenants`;
- enough additive vCPU reservation capacity (1 free, 2 paid/dedicated), matching
  the advertised 1/2-vCPU plan value stored on the container;
- enough additive 1.25x non-reserved RAM capacity;
- enough registered disk capacity for both home and root quotas;
- a recent successful signed daemon stats response with no current failure;
- a reported daemon release identity (legacy reduced stats never admit work);
  and
- an available, non-quarantined SSH port on that host.

Every host row carries independent CPU, RAM, reserve, disk, and tenant budgets.
The scheduler scores the post-placement normalized headroom deterministically,
avoids a single-resource hotspot, and then minimizes aggregate slack. The same
resource, health, tenancy, tenant, and port predicates gate the authoritative
D1 reservation against races. When a physical machine is shared by production
and staging, each control plane uses a
separate daemon process, signing/sealing keys, listener, Incus project, SSH port
range, and statically capped host row. Because separate D1 databases cannot
coordinate reservations, the sum of those project tenant caps must not exceed
the physical resource-derived ceiling. Bootstrap derives each machine's tenant
ceiling from online-vCPU overcommit, allocatable RAM, safe storage, worst-case
shared swap, isolated-ID ranges, and the conservative legacy class shape. The
vCPU multiplier defaults to the supported maximum of 4 and may be lowered per
host. RAM retains the 1.25x policy. The host reserves the larger of 3 GiB
(3072 MiB) or a rounded-up eight percent of detected total RAM; an operator may
configure a larger reserve. One failed daemon health check
immediately pauses new placement; three consecutive failures mark an active host unhealthy, and
a later valid signed stats response recovers it. Draining hosts continue to be
probed and reconciled but receive neither a new tenant nor a new daemon job;
already-started jobs remain pollable, and key/credential edits defer to the
next full start snapshot. CPU/RAM/disk accounting,
tenant-ceiling checks, port assignment, and FIFO admission are committed
together so concurrent requests cannot double-allocate capacity.

### Billing, entitlement, and plan transitions

Permanent Free eligibility and time-bounded paid entitlement are independent.
World ID, invite, and development verification can yield Free after Paid ends;
payment alone never does. Manual paid/dedicated entitlements have an explicit
source and are never fabricated as, or overwritten by, Stripe state.

New Paid sales are exposed only when `BILLING_ENABLED=1`, the single supported
monthly Price is configured server-side, its matching
`PAID_PLAN_MONTHLY_PRICE` and `PAID_PLAN_CURRENCY` disclosure values exist,
both Stripe secrets exist, and the `BILLING_EVENTS` Queue is bound. Checkout
requires an authenticated owner but not Free verification, stores one Customer
mapping, permits one unexpired Checkout attempt and one non-terminal
subscription, and reuses the attempt's stable Stripe idempotency key across
retries. Only the account's first subscription is trial-eligible. Before
Checkout, the Worker retrieves the configured Price and fails closed unless its
active Product, interval, amount, currency, quantity model, and tax metadata
match the published offer. It also lists the stored Customer's canonical Stripe
subscriptions and refuses a new Session when an unsynced non-terminal
subscription exists; remote terminal history suppresses repeat trials. It never
accepts a client Price or plan. The account,
dashboard, and landing page render the configured amount and currency. The
success redirect is display-only. Portal sessions require the stored Customer
mapping.

The public webhook verifies Stripe's signature over the exact raw body within
a five-minute tolerance and publishes only event ID, type, and creation time.
It returns success only after Queue publication. The at-least-once consumer
deduplicates by event ID, re-fetches the Event and canonical Subscription,
requires and validates internal user metadata, Customer, configured Price, quantity, the
seven-day trial bound, and one-subscription invariants, and applies monotonic
D1 facts. Canonical `trialing` state grants access only through `trial_end`;
only a settled `invoice.paid` with canonical `active` subscription state may
advance `service_until`, so Stripe's zero-value opening trial invoice is not
paid-through service while legitimate zero-value settled renewals covered by
credits or discounts remain valid. Payment failure
never advances a deadline. Older events cannot shorten
a newer deadline or reverse newer canonical subscription state. The Cron
reconciler performs bounded stale-subscription repair rather than polling every
account.

A paid entitlement makes Premium resources available but does not change an
existing Free container. The owner must explicitly opt in from the dashboard;
that action creates an idempotent in-place resize intent. The current container
tier and resource fields do not change until the daemon succeeds. Free-to-Paid
claims only the positive CPU/RAM/disk delta on its current mixed shared host;
insufficient capacity leaves the Free container usable in `upgrade_pending` and
retries automatically. Resize failure retains the claimed delta and retries
without double reservation. Upgrade success restores the prior running/stopped
state. Paid-to-Free remains automatic: it first stops a running container, then
applies the lower CPU/RAM limits while stopped and leaves it stopped. The UI
warns that stopping disconnects sessions and can lose unsaved progress. Every
plan transition keeps at least the container's current home/root allocation;
an already-grown allocation remains reserved as explicit grandfathered
storage. Automated paid changes never rebuild, destroy, or re-home the
container.

Canceling a trial removes Paid access immediately. A failed first post-trial
charge does the same; a failed renewal preserves already-paid service and any
configured grace, then expires. At the applicable trial, service, or grace
deadline, a permanently Free-eligible owner is downgraded in place. An owner
who used paid bypass is billing-suspended and
directed to billing and verification recovery plus operator-assisted export
guidance. Automatic destruction is disabled unless
`BILLING_EXPORT_WINDOW_DAYS` is explicitly configured.

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
| suspended | Billing access ended for an owner without permanent Free eligibility; billing, verification, and operator-assisted export guidance remain available |
| upgrade_pending | The current environment remains usable while an in-place plan resize waits or retries |

Job states are queued, running, succeeded, and failed. Supported current user
actions are start, stop, rebuild, destroy, and retry where valid. Background
operations synchronize keys and credentials.

### Core D1 tables and invariants

| Table | Important invariant |
|---|---|
| users | Better Auth identity plus product `verified_at` and verification method |
| auth_accounts | Unique provider/account identity; encrypted OAuth token material |
| auth_sessions | Unique session token, user binding, and seven-day expiry |
| auth_verifications | Short-lived Better Auth OAuth/passkey ceremony state |
| passkey | Credential ID unique; public key and monotonic signature counter |
| invite_codes | Keyed HMAC-SHA-256 only; raw eight-character code is never stored |
| invite_redemptions | One permanent redemption per invite; user link clears on account deletion |
| world_id_nullifiers | Canonical decimal nullifier unique per action; user link clears on deletion |
| ssh_keys | Multiple public keys per user; never private keys |
| containers | user_id unique; at most one environment per account; actual tier, tenancy mode, legacy class, billing suspension/deadline, grandfathered storage, and nullable administrative re-home target; selected GitHub repositories are non-secret JSON metadata |
| hosts | Current host generation, tenancy mode, rollout class/capabilities, independent CPU/RAM/disk and tenant budgets, allocation counters, health/release telemetry, management address, SSH hostname, daemon endpoint, X25519 public key, optional dedicated-account assignment, and retirement time |
| host_history | Immutable class, capacity, release, and hardware snapshot for each retired host ID/generation |
| jobs | No secret or arbitrary payload column |
| credentials_encrypted | One encrypted credential bundle per user |
| setup_drafts | One expiring, non-secret onboarding draft per user; selections only, never credentials or key material |
| workbench_configurations | One durable completed setup per user; agents and repository names only, while credentials and SSH public keys remain in their owning tables |
| enrollment_tokens | Hash only; one-hour expiry; single use |
| oauth_states | Short-lived, user-bound authorization attempts |
| waitlist | One row per user; requested_at ordering, bounded-backfill skip count, and admitted_at audit |
| port_quarantine | Host/port composite identity; 30-day hold |
| notifications | Global in-app announcements with optional expiry; no secret payloads |
| notification_reads | One read marker per notification and user; cascades on account deletion |
| account_entitlements | One effective paid/dedicated entitlement source with trial, paid-through, and grace projections per user |
| stripe_customers | One internal user to Stripe Customer mapping plus account-level trial-consumption state; account deletion is restricted while present |
| stripe_subscriptions | Canonical non-card subscription facts, trial bounds, monotonic event/sync markers, and paid-through deadlines |
| stripe_checkout_attempts | One active creating/open attempt per user, stable Stripe idempotency key, Stripe Session correlation, and explicit completion/expiry/failure state |
| stripe_billing_events | Event-ID dedupe, processing attempts, sanitized error codes, and no webhook bodies |
| container_plan_transitions | One idempotent in-place transition per container with exact claimed deltas and prior runtime state |

---

## 11. Security and operations

### Current controls

- Public-key-only SSH and unique per-environment host keys.
- A dedicated restricted Incus project with aggregate CPU, memory, process,
  disk, and instance ceilings.
- Public plan values remain free 1 vCPU and paid/dedicated 2 vCPU. Incus limits
  and host scheduler reservations use the enforced class values: free uses 1
  vCPU and paid/dedicated use 2 vCPU. Free has hard 1.5 GiB memory,
  1 GiB swap, and 5 GiB each for home and root; paid/dedicated have hard 4 GiB
  memory, 1.5 GiB swap, and 8 GiB each for home and root. Every class also has
  a 1024-process ceiling and an isolated unprivileged idmap.
- No nesting, privileged containers, or Docker-in-container support. The
  restricted project permits low-level configuration only for the daemon-owned
  bounded swap limit; tenant users have no Incus API access.
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
- Self-service account deletion after the environment is destroyed.

### Account deletion

The account-delete control is disabled while a real host environment exists.
The user first destroys the environment, then confirms account deletion.
Deletion purges credentials, SSH keys, Better Auth accounts/sessions/passkeys,
enrollment tokens, OAuth state, waitlist state, and the user row. A hostless
waitlisted or ineligible error row can be removed as part of deletion. Used-invite redemptions and
World ID nullifiers remain with a cleared user link so neither can be reused.

### Current operational limitations

- The fleet can contain a small development budget host with file-backed,
  unencrypted ZFS. Such a host must remain explicitly classified and is not a
  production storage design; production hosts require encrypted real ZFS.
- There are no backups. Host or pool loss means permanent user-data loss.
- The daemon endpoint is public and currently relies on TLS plus signed
  requests; unsolicited probes are expected and are rejected. Production and
  staging daemons never share Worker signing keys, X25519 private keys, config
  trees, listener ports, or Incus tenant projects.
- There is no mTLS binding or private network path.
- The daemon job registry and replay nonce store are in memory.
- The current Certbot deploy hook restarts the daemon, so an uncoordinated
  renewal can lose an active in-memory job.
- There is no automated alerting, SLO reporting, or tested disaster recovery.
- Fleet releases are operator-triggered and sequential. The controller does
  not create machines, evacuate tenants, wait indefinitely for active jobs, or
  make an unhealthy host active.
- GitHub integration is absent when its application credentials are unset.
- The local development login is intentionally disabled in deployed environments.
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
| Availability | Best effort across the registered fleet; no automatic failover, evacuation, or live migration |
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
the real migration files, a D1-compatible adapter double, and intercepted fetch calls.
It does not use a live D1 database, Miniflare, GitHub, Cloudflare, or
an Incus host.

Real-host multi-tenant capacity, isolation, quota, reboot, health-quarantine,
and soak acceptance is defined in infra/MULTITENANT_TESTING.md.

Current automated coverage includes:

- shared schema, signing, replay-window, encryption, sealing, and tamper tests;
- gated development login, Better Auth D1 sessions, logout, and eligibility routing;
- all four landing-page account options, passkey-first signed contexts, backup
  passkey attachment, and Better Auth schema migration;
- admin-secret invite generation, HMAC-only invite storage, authenticated
  one-time redemption races, v4-only World ID user-signal binding, remote
  verification, and permanent nullifier uniqueness;
- state transitions, ports, mixed-tier placement, jobs, timeout/retry, bounded
  waitlist backfill, dedicated assignment, heterogeneous resource budgets, and
  reconciler logic;
- raw Stripe webhook verification, metadata-only Queue publication, event
  deduplication, monotonic paid-through projection, single-flight Checkout,
  Price disclosure validation, first-subscription-only trials, refund
  correlation, and the disabled sales gate;
- in-place upgrade delta reservation, no-capacity preservation, idempotent
  resize retry, upgrade prior-state restoration, stop-before-resize downgrade,
  and nonshrinking grandfathered storage;
- authenticated host registration/probe/state APIs, daemon release telemetry,
  and fleet-controller release ordering;
- onboarding and lifecycle APIs, credential presence, key enrollment, account
  deletion, setup-draft expiry/secret exclusion, and external-call validation;
- CLI browser-auth handoff, one-time code exchange, session-state redaction,
  CLI package type-check/build, and SSH configuration rendering;
- Codex device-flow state and authorization binding;
- server-rendered page/script smoke tests;
- daemon config, RPC authorization, Incus command construction, provisioning,
  credentials, MOTD, agent fallback, and rebuild behavior.

### Manual release checks

The repository does not yet contain a nightly real-Incus E2E harness. Before a
public release, an operator must record:

1. Google and GitHub sign-in callbacks in the production provider apps,
   including an instance-pushed commit verified with its registered SSH signing
   key;
2. passkey-first registration, subsequent passkey sign-in, and backup passkey attachment;
3. World ID verification, invite verification, attempted nullifier/invite reuse,
   and the all-optional-onboarding-fields-skipped path;
4. provision to SSH using a pasted key;
5. provision to SSH using enrollment;
6. command availability for all four agents and base tools;
7. fingerprint agreement between dashboard and SSH;
8. post-ready SSH key enrollment and terminal-based credential guidance;
9. stop, start, rebuild with /home/dev preserved, and destroy;
10. forced provision failure and retry;
11. automatic FIFO waitlist admission;
12. mixed Free/Paid shared placement and account-bound dedicated placement,
    including bounded-backfill fairness, fragmentation, and exact final
    CPU/RAM/disk accounting;
13. host reboot/autostart and daemon reconciliation while active and draining;
14. port-25 and connection-rate enforcement;
15. keyboard-only and screen-reader status/error checks; and
16. one fleet-controller daemon rollout and rollback using infra/RUNBOOK.md;
17. Stripe sandbox signup, unverified paid bypass, success-redirect non-grant,
    duplicate Checkout start, abandoned-Checkout expiry, first-trial-only
    resubscription, renewal, payment failure, scheduled cancellation and undo,
    refund/dispute correlation, and expiry; and
18. running and stopped in-place upgrade, no-capacity retry, resize failure,
    running downgrade to a stopped Free container, stopped downgrade, and
    grandfathered disk behavior.

Manual results are release evidence; they must not be described as automated
coverage.

---

## 14. Current-release acceptance criteria

A release is acceptable when all automated tests pass and the risk-proportionate
manual checks above have been completed for affected areas.

1. **Identity:** every landing option authenticates through Better Auth; an
   unverified account reaches only the World ID/invite gate; each invite or
   World ID nullifier verifies at most one account; accounts route to
   configuration or dashboard according to saved workbench configuration;
   logout revokes the
   D1-backed application session.
2. **Terminal parity:** `npx usebench` can complete the same verification,
   agent, integration, provisioning, and readiness flow as the web app from a
   keyboard-driven TTY; browser SSO codes and CLI sessions are expiring and
   one-time where applicable.
3. **Fast onboarding:** agent selection is the only configuration requirement.
   Skipping every credential and SSH field still creates a provisioning or
   waitlisted environment.
4. **Image readiness:** the base image contains the complete toolchain and all
   four agents. Normal provisioning performs no agent package install; an
   intentionally missing selected binary triggers only its fallback installer.
5. **Provisioning:** successful provisioning produces a Debian 13 environment,
   enforced RAM/CPU/home/root limits, a persistent home volume, and any selected
   GitHub repositories cloned under `~/repos/name` with `gh` authenticated. A
   copyable SSH command and matching host-key fingerprints appear only after an
   authorized key exists.
6. **No-key safety:** without a key, SSH fails closed. After a successful build,
   a one-hour, single-use enrollment token can add a public key and allow SSH.
7. **Waitlist:** insufficient capacity produces a clear waitlisted state.
   Capacity release admits users automatically in deterministic FIFO order
   with bounded smaller-request backfill and a starvation cap, without double
   allocation; dedicated account pools remain independent.
8. **Dashboard efficiency:** initial load uses one aggregate request. Only the
   container view polls during transitional or waitlisted states using
   non-overlapping five-second or thirty-second schedules; one timeout is
   active, polling resumes after visibility/network interruptions, and key
   forms and enrollment output are preserved while available.
9. **Lifecycle clarity:** failures become error with useful sanitized detail
   and retry. Stop/start work, rebuild preserves /home/dev, and destroy removes
   the environment and volume.
10. **Configuration boundaries:** SSH keys can be added or removed after a
   successful build. Credentials are set during onboarding and are read-only in
   the dashboard after server creation; later changes require manual terminal
   commands. APIs never return secret values.
11. **Accessibility:** the core flow is keyboard operable, labels and state are
    programmatic, asynchronous changes are announced without poll spam, focus
    remains predictable, and reduced-motion/contrast requirements hold.
12. **Security:** passwords and root SSH are disabled; credential values are
    encrypted at rest, sealed to the host, absent from D1 jobs and logs, and
    written in-container with restrictive ownership/mode.
13. **Account deletion:** a user can destroy their environment and then purge
    account data; a hostless waitlist entry does not trap the account.
14. **Operations:** remote migrations are current, the daemon and Worker can be
    deployed and verified independently, every active host reports the intended
    daemon release, host onboarding begins draining and requires a signed probe,
    and the documented fleet rollback path has been exercised for any release
    that changes the shared contract.
15. **Billing integrity:** Checkout uses only the configured server Price; a
    validated Product/Price must match the published offer; only the account's
    first subscription receives a seven-day trial; one active Checkout attempt
    supplies a stable idempotency key; a redirect cannot grant service;
    the raw webhook is verified before durable
    metadata-only Queue publication; duplicate/out-of-order events converge on
    canonical Stripe state; opening trial invoices and payment failure never
    extend paid-through service; canceled trials and failed first charges remove
    Paid access; and disabled billing cannot contact Stripe for a new sale.
16. **Safe plan change:** Free-to-Paid claims only the resource delta and keeps
    the current container usable when capacity is absent; retries cannot
    double-reserve; upgrade success restores running/stopped state;
    Paid-to-Free stops before lowering limits, finishes stopped, and warns
    about unsaved progress; no transition shrinks storage; and automated paid
    changes never rebuild, destroy, or re-home.

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
