# Codestation — Product Specification

**Status:** Draft v3.2 for build (v2 revised after design review; v3 simplifies onboarding — agent-first wizard, all credentials optional/deferrable, agent-subscription auth supported; v3.1 adds the test suite, §18; v3.2 replaces the per-host Go daemon with a Hono-on-Node.js daemon — the same web framework as the control-plane Worker, sharing a common contract package and auth middleware; §10 records why a direct Worker→Incus design was rejected)
**Date:** 2026-07-08
**One-liner:** World ID-gated, lightweight Debian "cloud containers" preconfigured for coding agents, on Hetzner + Incus, free and paid tiers.

---

## 1. Vision

Codestation lets any **World ID-verified human** spin up a lightweight, always-on Debian "cloud container" — an Incus system container — that comes pre-wired for coding-agent work: SSH-key access, GitHub + Cloudflare credentials, the user's chosen coding agents (Pi / Claude Code / Codex / OpenCode) preinstalled, and the user's own LLM API keys injected at boot. The service never subsidizes inference; users bring their own keys.

### Why this exists (Problem)
- Coding agents need a stable, well-tooled Linux environment to do real work.
- Users don't want to manage their own VPS, install tools, wire credentials, or babysit a machine.
- Operators don't want unbounded free-tier abuse; **World ID bounds one human to one account**, and soft caps + ToS bound the rest.
- Operators want **sustainable unit economics** (free is a customer-acquisition cost; the $5 tier is the business).

### Honest framing
Marketed as **"cloud containers,"** not VPS. The product is Incus **system containers** (shared kernel), not KVM VMs. Users get root-like control inside a Debian userspace with systemd, but isolation is namespace/seccomp/AppArmor-based, not hardware virtualization.

---

## 2. Target Users & Personas

| Persona | Description | Primary need |
|---|---|---|
| **Agent-first dev** | Runs Pi/Claude/Codex/OpenCode locally; wants a remote headless Linux box those agents can drive | A persistently-on, reproducible, credentialed environment |
| **Capability-curious human** | World ID-verified; wants to try coding agents without setup pain | A no-credit-card, one-click sandbox to play with one agent |
| **Road-warrior dev** | Codes from multiple devices; wants the environment reachable from anywhere via SSH | A single persistent address to SSH into |

### World ID role: two distinct functions

World ID serves **two separate purposes**, and the spec treats them separately:

1. **Uniqueness gate (signup only).** At signup the user completes a World ID **verify** with an incognito action (`signup`). The resulting **nullifier** is stored (uniquely) against the account; duplicate nullifiers are rejected. This is a **one-time proof** — it prevents the same human creating multiple accounts. There is no fallback proof-of-personhood path.
2. **Authentication (every session).** Returning users authenticate via **Sign in with World ID (OIDC)**. The OIDC `sub` is bound to the account at signup. Verify proofs are *not* reused for login — a one-per-action incognito proof cannot serve as a repeatable auth factor.

World ID gates *both* tiers. It prevents the same human making multiple free accounts; it does **not** stop a single legit account being abused (handled via caps + ToS + monitoring, §11/§13).

> **Design rule:** the World ID nullifier is stored as a `UNIQUE` column, **never as a primary key or foreign key**. Nullifiers are derived per app/action — rotating the World ID app ID or action string would otherwise strand every account. All internal references use an internal `user_id` UUID.

---

## 3. Jobs To Be Done

1. **"I'm World ID-verified and want a coding sandbox right now"** → sign up, complete a short wizard, have an SSH-ready Debian container with my agent installed in minutes.
2. **"I want my agent to actually have GitHub/Cloudflare/LLM access"** → connect GitHub, paste a Cloudflare API token and LLM keys during onboarding so the running container is immediately usable by the agent.
3. **"I outgrew free"** → pay $5/mo via Stripe and have my *same* container upgraded in place (more CPU/RAM/disk) without losing work or my home directory.
4. **"I don't have an SSH key handy"** → finish onboarding without one: the dashboard mints a one-time **enrollment token**; my local agent generates a keypair, registers the public key via the enrollment API, and connects over normal SSH.

---

## 4. Core Use Cases (MVP)

- **U1 — Signup & launch.** World ID verify (uniqueness) + SIWO (auth) → setup wizard (pick agent → agent auth → optional SSH pubkey / GitHub / Cloudflare) → container provisioned asynchronously → connection details shown. **Only the agent pick is a hard requirement**; every credential step is skippable and completable later from the dashboard — the happy path from signup to "Provision" is two decisions.
- **U2 — Upgrade in place.** Free user checks out via Stripe (email captured from Checkout — required for paid) → container CPU/RAM/disk limits raised live, home dir kept, identity unchanged. One-way in v1.
- **U3 — SSH access.** User SSHes in with their pubkey over a host-NAT'd forwarded port and lands in a Debian shell as a non-root `dev` user, agent preinstalled.
- **U4 — No-key enrollment.** User with no pubkey completes the wizard anyway. The dashboard shows a one-time, short-lived **enrollment token** plus a copy-paste instruction block for their local agent: *generate an SSH keypair, `POST` the public key to the enrollment endpoint with the token, then `ssh -p <port> dev@<host>`*. The token is single-use, expires in 1 hour, and can be re-minted from the dashboard. Until a key is enrolled, the container has **no** authorized keys and is unreachable by design.
- **U5 — Account & keys management.** Add/remove SSH pubkeys, rotate LLM keys, replace the Cloudflare token, reauthorize GitHub from the dashboard. Changes apply **live**: the control plane issues a `refresh-credentials` (or `sync-keys`) job to the host daemon, which rewrites the in-container credential files without a restart. (Containers are always-on; "applies on next boot" would mean never.)
- **U6 — Payment failure.** Stripe dunning runs its retries; if unrecovered, status → `past_due`, container **suspended** (stopped, distinguishable from a user-initiated stop), disk kept **7 days**, then destroyed. The user is emailed at each stage (email is guaranteed to exist for paid users — captured at Checkout).
- **U7 — Voluntary cancellation.** Paid service runs to the end of the billing period. Because paid→free downgrade is not offered in v1, cancellation then enters the same 7-day grace: container suspended, and the dashboard offers a one-time **48-hour export window** (container started so the user can `rsync`/`scp` their data off) before destruction. Re-subscribing during grace resumes service.
- **U8 — Account deletion.** Self-serve from the dashboard: container destroyed, all credentials and keys purged, user row deleted. If the account was banned, an HMAC of the nullifier is retained solely to enforce the ban at re-signup (§13).

---

## 5. UX & Onboarding Flow

The interface is a **World ID login followed by a setup wizard.**

1. **Signup:** World ID verify (`signup` action; nullifier stored; duplicates rejected with a clear message) + Sign in with World ID binding for future sessions.
2. **Setup wizard** (multi-step; **only step one is required** — every other step has a prominent "Skip — set up later" and can be completed from the dashboard afterward. Time-to-first-SSH is the metric the wizard is designed around):
   - **Pick agent (required)** — choose exactly one of: **Pi, Claude Code, Codex, OpenCode.** Fixed at creation. (Users may always SSH in and install another agent manually afterward; the wizard's job is to streamline a working default.) The pick tailors the rest of the wizard: only credentials relevant to the chosen agent are emphasized.
   - **Agent authentication — strongly encouraged, skippable.** The agent needs model access; three paths:
     - **Paste an API key** — OpenAI / Anthropic / Google (Gemini) / OpenRouter; encrypted server-side.
     - **Bring an existing subscription** where the agent supports it — e.g. Claude Code accepts a long-lived token minted via `claude setup-token` (Claude Pro/Max); pasted subscription tokens are stored and injected exactly like API keys. Agents whose subscription auth is interactive-only (e.g. Codex ChatGPT sign-in) are flagged "sign in in-shell on first SSH."
     - **Skip** — allowed; the first-login checklist (below) shows the agent as not yet authenticated.
   - **SSH public key — optional.** User may paste one or skip.
     - If provided: container is configured for SSH-key auth with that pubkey.
     - If **not provided**: the wizard explains the **enrollment-token path** (U4) and shows it once provisioning completes.
   - **GitHub — optional.** Connect via **GitHub App** authorization (user-to-server token + refresh token; see §9).
   - **Cloudflare — optional.** Paste a **scoped API token** (guided: the wizard links to Cloudflare's token-creation page with the recommended permission template — Workers Scripts:Edit, DNS:Edit — and validates the token with a test call). *Note: Cloudflare offers no public third-party OAuth program; token paste is the supported path.*
3. **Provision container.** Provisioning is an **async job**: the wizard submit returns immediately with a `provisioning` state; the dashboard polls job status and then shows the SSH connection string (e.g. `ssh -p <port> dev@<host-ip>`) **plus the container's SSH host-key fingerprints** (so the first connection can be verified instead of blind-TOFU'd) — or, on the no-key path, the enrollment token + instruction block.
4. **First-login checklist (MOTD).** On SSH login the container prints a short status block: which credentials are connected (agent auth / GitHub / Cloudflare), which are missing, and the dashboard URL to add them. Skipped wizard steps land here instead of blocking signup. The daemon rewrites this block on every `refresh-credentials`/`sync-keys` job.
5. **Dashboard home** thereafter: container status, SSH connection, manage keys, upgrade to paid, manage subscription, delete account.

### Steady-state view
- One container per account (free or paid).
- Status: `waitlisted` / `provisioning` / `running` / `stopped` / `suspended` / `upgrade_pending` / `error` / `destroying`.
- Actions: start/stop, rebuild (re-run image), upgrade (free→paid), destroy, edit keys/pubkeys, refresh GitHub authorization, replace Cloudflare token, delete account.
- A provisioning **failure** surfaces as an explicit `error` state with a retry action — never a stuck spinner.

---

## 6. Feature Scope (MVP)

### In scope (v1)
- World ID uniqueness gate (verify) + Sign in with World ID (OIDC) sessions.
- Cloudflare Pages + Workers dashboard; D1 state; KV sessions (revocation list in D1); mTLS + signed-request per-host daemon with **async job model**.
- **Workers Cron Trigger reconciler** driving all time-based transitions (grace expiry, waitlist admission, job timeouts, D1↔host state reconciliation).
- Incus system containers on Debian 13, one agent pick fixed at creation (Pi/Claude/Codex/OpenCode).
- GitHub App authorization with **reconciler-driven token refresh** (refresh token never leaves the control plane); pasted Cloudflare API token; pasted LLM keys (OpenAI, Anthropic, Gemini, OpenRouter) or agent-subscription tokens (e.g. `claude setup-token`) — all encrypted at rest, **sealed to the destination host's key in transit**, injected at boot, **re-injectable live** via `refresh-credentials`. **All credential steps skippable at onboarding**, completable later from the dashboard.
- **First-login checklist (MOTD)**: in-shell status block showing connected vs. missing credentials, kept current by the daemon.
- No-key **enrollment token** path.
- Free (1/2GB/8GB) and Paid $5 (2/4GB/32GB) tiers; in-place upgrade with **host headroom reserve**; one-way paid; 7-day grace + export window.
- SSH-only access via NAT'd forwarded port; **outbound port 25 blocked**; per-container egress rate + connection-rate limits.
- Multi-host-ready control plane; **1 host deployed at MVP**; documented host-bootstrap procedure.
- Rebuild, start, stop, destroy, suspend operations.
- Stripe Checkout (email required) + Customer Portal + webhook idempotency.
- **Account deletion** (GDPR) flow.
- ToS + abuse ban runbook with **stated detection signals**.

### Out of scope (MVP)
- Automated disk backups / snapshot replication (v1.1).
- Web terminal / in-browser shell.
- IPv6-only or WireGuard/Tailscale access.
- Live migration between hosts; shared distributed storage.
- Downgrade paid → free (roadmap 1.8, gated on disk usage < 8 GB).
- Docker-in-container; nested virtualization.
- Multi-region.
- Auto-scaling (capacity-exceeded waits).
- Subsidized LLM tokens / free inference.
- More than one container per account.
- Agent auto-switching in place (fixed at creation; manual re-install via SSH is the path).
- RAM overcommit (v1 schedules against hard RAM caps; overcommit is a density lever for later — see §14).

### Future roadmap (post-v1)
- **1.1** Nightly ZFS snapshot replication to a backup target; restore-on-host-death runbook.
- **1.2** Per-container IPv6 (also mitigates shared-egress-IP blast radius, §13); optional WireGuard/Tailscale mesh.
- **1.3** Web terminal.
- **1.4** Multi-region; auto-scale hosts.
- **1.5** Multiple/second containers per account; teams.
- **1.6** Additional LLM providers via the shim interface.
- **1.7** Agent switchable in-place (vs rebuild).
- **1.8** Paid → free downgrade when disk usage < 8 GB (CPU/RAM shrink is trivial; a ZFS quota cannot shrink below used space, which is the real constraint behind "one-way" in v1).
- **1.9** RAM overcommit for free-tier density.
- **1.10** Warm pool of pre-provisioned base containers — claim-and-personalize on signup, cutting time-to-first-SSH from minutes to seconds.

---

## 7. UX Flows (detail)

### Sign-up flow
Landing page → "Sign in with World ID" → World ID verify (Orb / device path) → on success, nullifier stored (unique) and OIDC identity bound; duplicate nullifiers rejected with a clear message; **banned nullifier HMACs rejected** (§13).

### Setup wizard
1. **Pick agent (required)** — radio: Pi / Claude Code / Codex / OpenCode. Tailors the remaining steps to the chosen agent.
2. **Agent auth (skippable)** — API-key fields for OpenAI / Anthropic / Google (Gemini) / OpenRouter, with the chosen agent's providers surfaced first; or a subscription-token paste where the agent supports it (e.g. `claude setup-token`); or skip ("sign in in-shell later").
3. **SSH public key (optional)** — text area; "Skip — I'll enroll my agent's key instead" option.
   - Skip path: after provisioning, render the **enrollment instruction block**: a single copy-paste prompt for a local agent containing (a) the enrollment endpoint + one-time token, (b) instructions to generate a keypair and register the pubkey, (c) the eventual `ssh -p <port> dev@<host>` command. Token: single-use, 1-hour TTL, re-mintable.
4. **GitHub (skippable)** — "Connect GitHub" (GitHub App authorization).
5. **Cloudflare (skippable)** — guided API-token paste + live validation call.
6. **Review & launch** — summary (skipped steps listed as "set up later") → "Provision" → async job + progress → connection details incl. host-key fingerprints (or `error` + retry).

### Steady-state dashboard
- Container card: status, SSH command + host-key fingerprints, agent, tier, created date.
- Start / stop container (user-initiated stop is distinct from `suspended`).
- Credential checklist mirroring the in-container MOTD: connected vs. missing (agent auth / GitHub / Cloudflare), with one-click completion of any skipped wizard step.
- Upgrade button (free only) → Stripe Checkout (collects email) → webhook confirms → status flips to paid, resources live-resized (or `upgrade_pending` if the host lacks headroom — see §10 scheduler; ops-alerted, expected rare).
- Manage SSH pubkeys (add/remove — applied live via `sync-keys` job).
- Manage LLM keys (rotate / add provider — applied live via `refresh-credentials`).
- Re-authorize GitHub; replace Cloudflare token.
- Rebuild container (fresh rootfs from base image; `/home/dev` preserved; agent installer re-run **idempotently** — see §10 Container).
- Manage subscription (links to Stripe Customer Portal).
- Delete account (confirmation + consequences spelled out).

---

## 8. Data Model (D1, illustrative)

```
users
  id                   TEXT PRIMARY KEY   -- UUID, internal identity
  world_id_nullifier   TEXT UNIQUE NOT NULL
  world_id_oidc_sub    TEXT UNIQUE NOT NULL  -- SIWO subject for login
  email                TEXT NULL          -- optional while free; REQUIRED once paid
  status               TEXT               -- active|banned|deleted
  subscription_status  TEXT               -- free|paid|past_due|canceled
  stripe_customer_id   TEXT NULL
  stripe_sub_id        TEXT NULL
  created_at           INTEGER

ssh_keys
  id          INTEGER PRIMARY KEY
  user_id     TEXT REFERENCES users(id)
  label       TEXT
  pubkey      TEXT
  created_at  INTEGER

containers
  id               TEXT PRIMARY KEY      -- UUID
  user_id          TEXT UNIQUE REFERENCES users(id)   -- UNIQUE: one container per account
  host_id          TEXT REFERENCES hosts(id)
  ssh_port         INTEGER               -- UNIQUE(host_id, ssh_port)
  agent            TEXT                  -- pi|claude|codex|opencode
  tier             TEXT                  -- free|paid
  cpu              INTEGER               -- 1|2
  ram_mb           INTEGER               -- 2048|4096
  disk_gb          INTEGER               -- 8|32
  status           TEXT                  -- waitlisted|provisioning|running|stopped|
                                         -- suspended|upgrade_pending|error|destroying
  suspended_at     INTEGER NULL          -- grace-period clock (reconciler reads this)
  created_at       INTEGER
  last_upgraded_at INTEGER NULL

port_quarantine                   -- released SSH ports held out of reuse
  host_id      TEXT
  port         INTEGER
  released_at  INTEGER             -- reusable after 30 days (avoids host-key-mismatch
                                   -- confusion and stale known_hosts pointing at strangers)

credentials_encrypted             -- per-user secrets, all server-side encrypted
  user_id              TEXT PRIMARY KEY REFERENCES users(id)
  github_token         BLOB       -- GitHub App user-to-server token (short-lived)
  github_refresh_token BLOB       -- used by reconciler refresh loop;
                                  -- never sent to hosts (§10)
  github_expires_at    INTEGER
  cloudflare_token     BLOB       -- user-pasted scoped API token
  llm_keys             BLOB       -- JSON map {openai,anthropic,gemini,openrouter,
                                  --           claude_subscription_token,...}; any/all NULL
                                  -- (all credentials are optional at onboarding)
  rotated_at           INTEGER

enrollment_tokens                 -- no-key path (U4)
  token_hash   TEXT PRIMARY KEY   -- store hash, never the token
  user_id      TEXT REFERENCES users(id)
  expires_at   INTEGER            -- 1 hour TTL
  used_at      INTEGER NULL       -- single-use

oauth_states                      -- short-lived states for GitHub authorization
  state        TEXT PRIMARY KEY
  user_id      TEXT
  created_at   INTEGER
  expires_at   INTEGER

jobs                              -- async daemon operations (provision/resize/...)
                                  -- NO payload column by design: credential-bearing
                                  -- payloads travel only in the signed request body
                                  -- (sealed to the host key) and are never persisted
  id           TEXT PRIMARY KEY
  container_id TEXT
  op           TEXT               -- provision|start|stop|resize|rebuild|destroy|
                                  -- refresh-credentials|sync-keys|export-window
  status       TEXT               -- queued|running|succeeded|failed
  error        TEXT NULL
  created_at   INTEGER
  updated_at   INTEGER

stripe_events                     -- webhook idempotency (Stripe redelivers/reorders)
  event_id     TEXT PRIMARY KEY
  type         TEXT
  received_at  INTEGER
  processed_at INTEGER NULL

rpc_nonces                        -- daemon RPC replay protection (D1, NOT KV:
  nonce        TEXT PRIMARY KEY   -- KV is eventually consistent; replay windows
  seen_at      INTEGER            -- need strong consistency)

banned_nullifiers                 -- ban survives account deletion (GDPR-minimal)
  nullifier_hmac  TEXT PRIMARY KEY  -- keyed hash, not the raw nullifier
  banned_at       INTEGER
  reason          TEXT

waitlist
  user_id      TEXT PRIMARY KEY REFERENCES users(id)
  requested_at INTEGER
  admitted_at  INTEGER NULL

hosts                             -- registry of Hetzner hosts
  id                TEXT PRIMARY KEY
  ipv4              TEXT
  ipv6              TEXT
  daemon_endpoint   TEXT           -- https://host:port for the control daemon
  daemon_cert_fp    TEXT           -- pinned server-cert fingerprint
  daemon_pubkey     TEXT           -- X25519 public key (generated at bootstrap);
                                   -- credential payloads are sealed to this key
  ram_total_mb      INTEGER
  ram_allocated_mb  INTEGER        -- sum of container hard caps
  ram_reserve_mb    INTEGER        -- upgrade-headroom reserve (§10 scheduler)
  disk_total_gb     INTEGER        -- ZFS pool capacity — tracked so paid 32 GB
  disk_allocated_gb INTEGER        -- quotas can't silently oversubscribe the pool
  status            TEXT
  joined_at         INTEGER
```

KV stores signed session data (session **revocations** are written to D1 and checked on sensitive operations, since KV propagation is eventually consistent).

---

## 9. Integrations

- **World ID** — two integrations: (1) **verify** (incognito action `signup`) checked against World ID's verification API at signup; nullifier stored uniquely. (2) **Sign in with World ID (OIDC)** for all subsequent sessions.
- **GitHub** — **GitHub App** (not a classic OAuth app): fine-grained, repo-scoped user-to-server tokens. These expire (~8 h), so the **reconciler runs the refresh loop control-plane-side**: before expiry it exchanges the stored refresh token (which is D1-encrypted and **never leaves the control plane**) for a fresh user-to-server token and pushes it to the host via a `refresh-credentials` job; the daemon rewrites the in-container `gh` config + git credential file. In-container, `gh` CLI + a git credential helper read from that daemon-managed file. Hosts only ever hold the ~8 h short-lived token — a compromised host cannot mint new ones. (A classic OAuth app with long-lived broad tokens was rejected: worse blast radius when — not if — a container is compromised, §13.)
- **Cloudflare** — **user-pasted scoped API token** (guided creation, validated at paste time). Cloudflare has no public third-party OAuth program; the earlier "Cloudflare OAuth" plan was unbuildable. Surfaced in-container for Workers deploys / DNS.
- **OpenAI / Anthropic / Google (Gemini) / OpenRouter** — user-supplied API keys; injected to agents via per-agent config files (preferred) or env vars where the agent requires it. Each provider is implemented behind a small per-provider **shim** so additional providers can be added later without core changes.
- **Agent subscription auth** — where an agent supports a paste-able long-lived credential (e.g. Claude Code's `claude setup-token` for Claude Pro/Max), it is stored and injected through the same shim path as an API key. Interactive-only subscription sign-ins (e.g. Codex ChatGPT login) are done in-shell on first SSH; the wizard and MOTD say so explicitly. Devs with existing agent subscriptions should not need a separate API key to get value.
- **Stripe** — Checkout (subscribe; **collects email**, which we store — paid users must be reachable for dunning/grace notices), Webhooks (idempotent via `stripe_events`), Customer Portal (manage billing). PCI scope fully handled by Stripe.
- **Transactional email** — a sending provider (e.g. Cloudflare Email Service, Postmark, Resend) with SPF/DKIM configured on the product domain. Required for dunning/suspension/grace notices (U6/U7), waitlist admission, and export-window mails. Template set is small (~6 mails); provider is swappable behind a thin send interface.
- **Hetzner** — dedicated hosts (MVP: 1, Falkenstein).
- **Incus** — system container runtime; per-host control daemon invokes the Incus CLI / REST API for provision/start/stop/resize/destroy.

---

## 10. Architecture & Control Plane

### Top shape
- **Control plane:** Cloudflare Pages (dashboard front-end) + Workers (API).
- **State:** **D1** for structured state, RPC nonces, and session revocations; **KV** for session data only.
- **Secrets:** Cloudflare Workers Secrets (Stripe secret, GitHub App private key, host-daemon client cert/key, credential master key, nullifier-HMAC key).
- **Per-host control daemon:** a small **Hono-on-Node.js** process on each Hetzner host exposing an HTTPS API secured by **mTLS** (Workers mTLS-certificate binding; daemon server cert pinned) **plus signed requests with nonces** (replay-checked against D1). It is *the same web framework as the control-plane Worker*: the signed-request / nonce / sealed-payload logic is written once as **Hono middleware in the shared contract package** and mounted on both the Worker (Workers runtime) and the daemon (Node runtime). Credential-bearing payloads are additionally **sealed to the destination host's public key** (see Credential handling) — plaintext secrets never transit, even inside the mTLS tunnel, and a leaked Worker client cert alone cannot extract them. Operations are **asynchronous jobs**: the Worker enqueues (`provision`, `start`, `stop`, `resize`, `rebuild`, `destroy`, `refresh-credentials`, `sync-keys`, `export-window`) and receives a job ID; the daemon executes them, driving Incus over its **local Unix socket** (REST API / CLI via `child_process`) and owning the host-level operations that have no Incus API surface (nftables baseline, ZFS encryption-key handling), then reports status; the dashboard polls job state. Synchronous calls are limited to `health` and `stats`. *(Provisioning takes minutes; a Worker request cannot and should not hold that long.)*
  - **Rejected — Worker → Incus REST API directly (no host daemon):** Incus can expose its REST API over the network with mTLS client-cert auth, and a Worker could call it, so this was considered. Rejected on three grounds: **(1) it collapses the sealed-credential model** — the Worker would push plaintext secrets to Incus via `incus file push`, so sealing-to-host becomes moot and a leaked Worker mTLS cert grants *total* control of every container and the host's storage, versus the ~9 narrow, least-privilege ops the daemon exposes; **(2) not everything is in the Incus API** — the host nftables baseline (outbound-25 block, connection-rate limits), ZFS native-encryption key loading, and reboot resync are host-OS operations, so a host-side component is required regardless; **(3) duration/orchestration** — multi-minute, multi-step provisioning cannot ride a single Worker invocation, and pushing the whole workflow into the Cron reconciler still would not solve (2). The daemon keeps the Incus control surface on a private Unix socket and off the public edge.
- **Reconciler:** a **Workers Cron Trigger** (every 5 min) drives all time-based and corrective transitions: grace-period expiry (`suspended_at` + 7 days → destroy), export-window expiry, stuck-job timeouts, waitlist admission, the GitHub token refresh loop (control-plane-side, §9), and D1↔host drift detection (daemon `stats` diffed against D1 state). **No state transition depends on a user or webhook happening to arrive.**
- **Hosts:** **independent hosts** (no shared distributed storage, no live migration). MVP deploys **one Hetzner dedicated host** (~64 GB / 8-16 vCPU, Falkenstein), with architecture and scheduler multi-host-ready.

### Host lifecycle
- **Bootstrap (documented, repeatable):** provision Debian on the host → run the bootstrap script/Ansible role (installs Incus, **ZFS pool with native encryption enabled** — key handling documented in the runbook — the **Node.js runtime** and the control daemon (installed as a systemd service), nftables baseline incl. outbound-25 block) → issue daemon server cert → daemon generates its **X25519 credential keypair** (private key never leaves the host) → register row in `hosts` with endpoint + cert fingerprint + daemon public key. Adding a host is config + this runbook; no dashboard or daemon code changes (acceptance criterion 12).
- **Reboot behavior:** containers are marked `boot.autostart=true`; the daemon starts on boot, resyncs actual Incus state to D1 via the reconciler, and re-applies NAT port forwards and egress limits.
- **OS patching:** host runs unattended-upgrades; **containers ship with unattended-upgrades enabled by default** (user may disable; ToS states patching inside the container is ultimately the user's responsibility).

### Scheduler
Free-RAM heuristic with an **upgrade-headroom reserve**: each host reserves `ram_reserve_mb` (default **25 % of capacity**) exclusively for in-place upgrades; new containers place on the host with the most unallocated *non-reserved* RAM above required headroom. If a specific upgrade still cannot fit (reserve exhausted), the container enters `upgrade_pending`, ops is alerted, and the user is notified — expected rare, but stated because **there is no live migration to fall back on**. Capacity-exceeded at signup → `waitlisted` (manual admit); no autoscaling for v1.

Disk is scheduled explicitly too: placements and upgrades check `disk_allocated_gb` against `disk_total_gb` so paid 32 GB quotas can't oversubscribe the ZFS pool.

### Storage
- Per-container **ZFS dataset** with quota (8 GB free / 32 GB paid), on a pool with **ZFS native encryption** — container filesystems (which include injected credential files) are never plaintext on raw disk, protecting against decommissioned/recycled drives.
- Home directory is the persisted surface (`/home/dev` survives rebuilds); root/system state is disposable on rebuild.
- **Per-host-local storage only** in MVP. **Backups/snapshot replication are a v1.1 item.** A dead host takes its containers' disks in MVP — documented as a known limitation / best-effort.

### Container
- **Incus system container on Debian 13 (trixie)**.
- Image base: `git`, `gh`, `build-essential`, `python3` + `uv`, `node` (via nvm), `curl`, `zsh`, `tmux`, `ripgrep`, `fd-find`, `jq`, `unzip`, `sqlite3`. (`ripgrep`/`fd`/`jq` are on the list because coding agents lean on them heavily.) **No docker-in-container.**
- **Rebuild semantics (explicit):** fresh rootfs from the base image; `/home/dev` is preserved and re-attached. Because nvm and most agents install into `$HOME`, the post-rebuild provisioner re-runs all installers **idempotently** (upgrade-in-place if present, install if absent) rather than assuming a clean slate.
- Non-root **`dev` user** with **passwordless sudo**.
- Resource limits via cgroups: free = 1 vCPU / 2048 MB; paid = 2 vCPU / 4096 MB. CPU quota is soft for burst, **with a sustained-use ceiling** (throttle sustained ~100 % usage over multi-hour windows) so an always-on miner cannot monopolize idle host CPU (§11 abuse).
- Disk via ZFS quota.

### Networking (SSH-only access)
- **NAT + one ephemeral forwarded port** per container on the host's IPv4. User connects: `ssh -p <port> dev@<host.example>`. Released ports are **quarantined 30 days** before reuse.
- **All tenants share the host's egress IPv4** — a shared-fate risk (§13, §15). Mitigations at the host firewall: **outbound port 25 blocked** unconditionally; per-container egress bandwidth limit; per-container outbound **connection-rate limit** (blunts scanning/brute-forcing that triggers Hetzner abuse locks).
- IPv6-per-container is roadmap 1.2 (and reduces the shared-IP blast radius); WireGuard/Tailscale mesh explicitly out of scope for v1.
- No inbound ports other than the forwarded SSH port.

### Credential handling
- **At rest:** all user credentials (GitHub tokens, Cloudflare token, LLM keys, subscription tokens) are encrypted with the **credential master key** held in Cloudflare Workers Secrets and stored as ciphertext in D1. The master key never leaves the control plane.
- **Delivery (sealed to host):** when credentials must reach a host, the Worker decrypts in-memory and immediately **re-encrypts the payload to the destination host daemon's X25519 public key** (sealed-box; keypair generated at host bootstrap, public key registered in `hosts`). The sealed payload travels inside the mTLS tunnel; the daemon decrypts **in memory** and writes only the container's agent config files. Plaintext secrets never transit the network, are never persisted in `jobs` rows, and mTLS is defense-in-depth rather than the sole protection. "Decrypted only inside the host daemon" is thus literally true for the delivery hop.
- **Secrets hygiene:** credential material never appears in `jobs` rows, `jobs.error`, daemon or reconciler logs, or ops alerts — errors reference credential *kinds* ("github token refresh failed"), never values. Enforced as a code-review rule and checked in AC5.
- **GitHub** — user-to-server token + refresh token stored encrypted in D1; the **reconciler refresh loop** (control-plane-side) exchanges the refresh token for a fresh short-lived token before expiry and pushes it via `refresh-credentials`; the daemon rewrites `gh` config + credential-helper file. The refresh token — the credential that can mint new tokens — never leaves the control plane; hosts and containers only ever hold the ~8 h token.
- **Cloudflare** — pasted scoped API token, stored encrypted; delivered sealed; surfaced in-container.
- **LLM keys / agent-subscription tokens** — pasted by user; stored and delivered as above; written into the container as agent config files (mode 0600, owned by `dev`; env vars only where an agent requires them) at boot **and on any `refresh-credentials` job** — key rotation applies live, not "on next boot." **Providers v1: OpenAI, Anthropic, Google (Gemini), OpenRouter**, plus paste-able subscription tokens where the agent supports them, each behind a per-provider shim (adding a provider = new shim + dashboard field). All optional at onboarding; the MOTD checklist tracks what's missing.
- **No LLM token subsidy.** Service never pays for inference; no quota'd free model.

---

## 11. Subscription & Billing (Stripe)

- **Free tier:** no credit card, World ID only, always-on, indefinite (while in good standing). Email optional.
- **Paid tier:** **$5/month recurring** via Stripe Checkout + Customer Portal. **Email required** — captured from Checkout and stored; a paying user whose data is 7 days from destruction must be reachable.
- **Upgrade path:** paid is an **in-place upgrade of the free container** — same home dir, same account, same container UUID; cgroups and ZFS quota are raised live (CPU 1→2, RAM 2→4 GB, disk 8→32 GB). Running processes are not interrupted where possible. Host headroom is pre-reserved (§10); `upgrade_pending` is the rare fallback.
- **Paid → free is not offered in v1** (roadmap 1.8). The honest constraint is disk: a ZFS quota cannot shrink below used space. CPU/RAM shrink would be trivial; the downgrade ships when gated on usage < 8 GB.
- **Payment failure:** Stripe dunning (smart retries) runs first; if unrecovered → `past_due`, container **suspended** (`suspended_at` set), disk kept **7 days**, user emailed at suspension and before destruction; re-subscribe during grace to resume. After 7 days the reconciler destroys the container (home dir irrecoverable).
- **Voluntary cancellation:** service runs to the end of the paid period, then the same 7-day grace applies, **plus a one-time 48-hour export window** (container started so the user can copy data off via SSH) requestable from the dashboard during grace.
- **Webhooks:** processed idempotently against `stripe_events`; out-of-order delivery tolerated (state machine keyed on subscription status, not event arrival order).
- **Invoices/receipts** via Stripe Customer Portal.

### Resource limits & abuse

| Dimension | Free | Paid |
|---|---|---|
| CPU | 1 vCPU (soft burst; sustained-use ceiling) | 2 vCPU (soft burst; sustained-use ceiling) |
| RAM | 2 GB hard | 4 GB hard |
| Disk | 8 GB | 32 GB (in-place resize on upgrade) |
| Network egress | rate-limited + connection-rate-limited | rate-limited (higher) + connection-rate-limited |
| Outbound SMTP (port 25) | blocked | blocked |
| Always-on | Yes | Yes |
| Backups | No (v1.1) | No (v1.1) |

**Abuse policy (posture: soft caps + World ID + ToS + host-level telemetry):**
- ToS bans mining, proxy/VPN-exit-node operation, torrenting, DoS, spam, and any commercial/server-hosting misuse of the container.
- **Detection signals (stated, and disclosed in the ToS/privacy policy):** host-level per-container CPU-sustain, egress volume, and outbound-connection-rate telemetry. **We do not inspect container contents or traffic payloads**; detection is resource-pattern-based.
- Enforcement: cgroup caps + sustained-use ceiling, egress and connection-rate limits, port-25 block, and **ban on World ID nullifier** for verified violations (HMAC retained even after account deletion, so the human can't re-signup).
- Free tier is indefinite **only while in good standing**; documented in ToS.

---

## 12. Non-Functional Requirements

- **Provisioning latency:** target ≤ 3 min from wizard submit to SSH-ready (job-based; the HTTP submit itself returns immediately).
- **Availability:** best-effort for MVP; single host = single point of failure acknowledged. Multi-host-ready control plane mitigates later.
- **Dashboard latency:** p95 < 300 ms for reads (D1-backed).
- **Secret confidentiality:** all tokens and LLM keys encrypted at rest; sealed to the destination host's key in transit (mTLS is defense-in-depth, not the sole protection); decrypted only in-memory inside the host daemon; in-container copies owned by `dev`, mode 0600; host ZFS pool encrypted; credential values never in job rows, logs, or alerts.
- **SSH auth:** public-key only; password auth disabled.
- **Egress:** bandwidth- and connection-rate-limited per container; outbound 25 blocked.
- **Resource isolation:** cgroup hard caps for RAM, soft-with-ceiling for CPU; ZFS hard quota for disk.
- **Consistency:** replay nonces and session revocations in strongly-consistent storage (D1), never KV.
- **Convergence:** reconciler ensures every container reaches a terminal or steady state without depending on user action or webhook delivery; stuck jobs time out to `error`.
- **Scalability:** control plane and daemon multi-host-ready; capacity capped by host count in v1 (waitlist when full).
- **Operability:** per-host daemon exposes `health` and `stats`; dashboard surfaces container status; provisioning failures alert ops.
- **Maintainability:** LLM providers and coding agents each behind a small shim interface so the lists can grow without core changes. Agent installers re-run idempotently on rebuild; agent-version updates are an image-bake cadence decision (monthly rebake target).

---

## 13. Security & Privacy

- **Identity:** internal UUID is the identity; the **World ID nullifier** is stored once, `UNIQUE`, never used as a key. We do not store World App / wallet data beyond what the protocol requires. Email optional while free, required when paid.
- **Server-side encryption** of all tokens and LLM keys at rest in D1 (credential master key in Cloudflare Secrets). Delivery to hosts is **sealed to the destination daemon's X25519 key** (§10), so decryption happens only in-memory inside the per-host daemon; keys are not written to host disk in plaintext beyond the container's own agent config — and the host ZFS pool itself is encrypted, so even those files are never plaintext on raw disk. The GitHub **refresh token never leaves the control plane** (§9/§10); hosts hold only short-lived tokens. Credential values never appear in job rows, logs, or alerts (§10 secrets hygiene).
- **Per-host daemon** reachable only over mTLS from the Worker (client cert in a Workers mTLS binding; daemon server cert pinned) with signed, nonce-protected requests; credential payloads sealed on top of the tunnel.
- **SSH pubkey auth only**; password auth disabled. No-key accounts have **zero** authorized keys until enrollment (fail-closed).
- **Credential blast radius (stated honestly):** everything injected into the container — GitHub token, Cloudflare token, LLM keys — is readable by any code the user's agent runs, including malicious dependencies (`npm install`, cloned repos). Mitigations: tokens scoped as narrowly as each provider allows (GitHub App repo-scoped short-lived tokens; user-scoped CF token); config files over process-wide env vars where agents permit; short GitHub token lifetime limits the value of a one-time exfiltration. Users are told this trade-off exists; it is inherent to giving an autonomous agent credentials.
- **Shared egress IP:** all tenants exit via the host IPv4; one abuser can get the IP blacklisted or trigger a Hetzner abuse lock affecting every tenant. Mitigations: port-25 block, connection-rate limits, telemetry-driven bans (§11); per-container IPv6 in 1.2.
- **Egress limits** applied per container on the host.
- Users retain root-ish control of their container (passwordless `sudo`); they accept responsibility for what runs.
- Stripe handles PCI scope; we never see card numbers.
- **GDPR / data protection** (EU host, Falkenstein — GDPR squarely applies):
  - **Account deletion (U8, in MVP):** self-serve; destroys the container and disk, purges all credentials/keys/SSH keys, deletes the user row. Hard to retrofit, so in v1.
  - **Ban retention:** for banned accounts only, a keyed **HMAC of the nullifier** is retained post-deletion (lawful basis: legitimate interest in abuse prevention; documented in the privacy policy). Non-banned deletions retain nothing.
  - **Retention schedule:** grace-period disks 7 days; operational logs 30 days; Stripe retains billing records per its own obligations.
  - **Monitoring disclosure:** resource-pattern telemetry (not content inspection) is disclosed in the privacy policy; SSH-session activity metrics (§14) come from auth-log counters, also disclosed.
- **Known limitation (MVP):** a dead host = lost data, because backups are v1.1. Communicated in ToS.

---

## 14. Analytics & Success Metrics

- **Activation:** World ID-signup → provisioning-completed rate; **median time from signup to first successful SSH** (the north-star for onboarding simplicity); wizard skip-rates per step (which credential steps cause drop-off).
- **Adoption:** # active free containers; # SSH sessions in trailing 7d (counted from container auth logs by the daemon — count + timestamp only, no session content; disclosed in privacy policy).
- **Conversion:** free → paid upgrade rate; paid churn rate.
- **Financial:** paid MRR; ARPU; CAC vs. LTV.
- **Utilization:** free-tier host density (# containers per host vs. capacity); average container RAM/CPU idle headroom (from daemon `stats`).
- **Risk:** abuse/ban rate (nullifier-bans per 1k tenants); egress-limit and connection-rate-limit hit rates.
- **Reliability:** provisioning success rate; job failure/timeout rate; host-up percentage; reconciler drift-corrections per day.

### Free-tier unit economics (sustainability note)
A Hetzner dedicated host (~64 GB / 8-16 vCPU, Falkenstein) splits into ~24-28 free containers once host/Incus headroom **and the 25 % upgrade reserve** are accounted for. At roughly €40-60/month per host, free-tier unit cost is in the **€1.7-2.3 / tenant / month** range — *always-on, indefinite, zero direct revenue*. That line item is funded up to the operator's acquisition budget.

**Density upside (deliberately unbanked in v1):** these figures assume zero RAM overcommit, yet idle agent boxes use a fraction of their 2 GB hard cap. Modest overcommit (roadmap 1.9) could plausibly 2× free-tier density and halve acquisition cost; v1 schedules against hard caps to keep the failure mode simple.

**Rough break-even:** with free tenants costing ~€2/month each, and the paid tier net of Stripe fees ≈ $4.55 (~€4.20), each paying user covers ~2 free users' run-rate. **Sustainability requires healthy free→paid conversion** — the dashboard's primary job is to nudge users toward the $5 upgrade; the abuse/ban posture prevents the free tier being a pure cost sink. Free-tier capacity is capped by host availability (waitlisted when full), hard-stopping tail risk.

(These figures are illustrative planning numbers at the spec stage; real values depend on host auction pricing and actual free/paid mix.)

---

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Shared egress IP poisoned** (spam/scanning → blacklist or Hetzner abuse-lock of the whole host) | Medium | **High — affects every tenant** | Port-25 block; per-container connection-rate limits; telemetry-driven bans; per-container IPv6 in 1.2 |
| **Credential exfiltration from inside a container** (malicious dep run by the agent steals GitHub/CF/LLM keys) | Medium | High for that user | Narrow token scopes; short-lived GitHub tokens; 0600 config files over env vars; disclosed trade-off |
| Free-tier abuse (mining/proxy/exit-node on 2 GB) | Medium | High burn + reputation | Sustained-CPU ceiling; egress + connection-rate limits; World ID nullifier-ban (survives deletion); ToS |
| Always-on free cost sinks | High (structural) | Medium | Capacity cap via host count → waitlist; caps; upgrade nudges |
| Host death = data loss (no backups in v1) | Low/Med | High for those users | Document as best-effort in ToS; backups in v1.1 |
| Upgrade blocked on full host (no live migration) | Low | Medium (paid-flow friction) | 25 % headroom reserve; `upgrade_pending` + ops alert as fallback |
| Agent install/maintenance matrix (4 agents) | Medium | Medium (support load) | "Fixed at creation, manual if you switch"; idempotent installers; monthly image rebake |
| World ID signup friction | Medium | Medium (activation drop) | Only one required wizard step (agent pick); all credentials deferrable to MOTD checklist; no-key enrollment path |
| Incus/system-container isolation weak vs. KVM | Low | Medium | AppArmor profile, drop capabilities, audit per agent needs |
| GitHub token refresh loop fails (tokens expire in ~8 h) | Low | Medium (broken `gh` in-container) | Reconciler owns the refresh (control-plane-side) and monitors `github_expires_at`; alert + dashboard "re-authorize" prompt on refresh failure |
| IPv4/NAT port exhaustion at scale | Low | Low | One port per container, ~60k available minus 30-day quarantine; plenty for MVP/host |

---

## 16. Milestones & Launch Plan

| Milestone | Contents |
|---|---|
| **M0 — Control plane skeleton** | Pages+Workers dashboard; World ID verify + SIWO sessions; D1 schema (incl. jobs, nonces, stripe_events); KV sessions + D1 revocation; one mTLS/signed-RPC host daemon stubbed with `health`; host bootstrap runbook v0 (incl. encrypted ZFS pool + daemon X25519 keypair) |
| **M1 — Provision path** | Async job model + Cron reconciler; daemon implements `provision`/`start`/`stop`/`destroy`/`rebuild`; Debian 13 base image with tools; ZFS quota + cgroup limits (incl. sustained-CPU ceiling); NAT SSH port assignment + quarantine; boot.autostart + reboot resync; `error`-state + retry UX |
| **M2 — Credentials & agents** | GitHub App flow + reconciler token-refresh loop; sealed-to-host credential delivery; Cloudflare token paste + validation; LLM key / subscription-token paste/encrypt/inject; `refresh-credentials`/`sync-keys` live re-injection; secrets-hygiene checks (no credential material in job rows/logs); MOTD credential checklist; enrollment-token no-key path; agent install shims (idempotent) for Pi, Claude Code, Codex, OpenCode; wizard end-to-end (agent-first, all credentials skippable) |
| **M3 — Billing** | Stripe Checkout (email capture); webhook idempotency; in-place upgrade + headroom reserve + `upgrade_pending`; Customer Portal; dunning→suspend→7-day-grace→destroy via reconciler; cancellation export window; transactional email integration (SPF/DKIM, lifecycle notice templates) |
| **M4 — Abuse, privacy & ops** | Egress + connection-rate limits; port-25 block; abuse telemetry + ban runbook (nullifier-HMAC bans); account deletion (GDPR); ToS + privacy policy (monitoring disclosure, retention schedule); dashboard status & key management |
| **M5 — Public MVP** | Hardening, monitoring/alerting (job failures, refresh-loop health, host telemetry), docs; launch on 1 host, multi-host-ready |

---

## 17. Acceptance Criteria (MVP)

A build is releasable when it satisfies **all** of the following. Each criterion is backed by automated tests where possible (traceability table in §18); the few genuinely manual checks are called out there explicitly.

1. **World ID gating.** A new human can sign up with World ID verify; the same nullifier cannot sign up twice; a banned nullifier (HMAC match) cannot sign up; the nullifier is stored uniquely in D1; the user can log out and log back in via Sign in with World ID.
2. **Setup wizard.** A user can complete the wizard end-to-end: pick one of four agents (the only required step), optionally add agent auth (API key or supported subscription token), SSH pubkey (or skip via the enrollment-token path), GitHub App authorization, and Cloudflare token (validated live) — and receive an immediate "provisioning started" response with a pollable job. **A user who skips every optional step still reaches a running container**, and every skipped step is completable afterward from the dashboard, applying live.
3. **Provisioning.** Within ≤ 3 minutes the user sees a running container with an assigned SSH port; can `ssh -p <port> dev@<host>` in with their pubkey and land in a Debian 13 shell as `dev` with passwordless sudo. A deliberately failed provision surfaces an `error` state with a working retry — no stuck spinner.
4. **Tools preinstalled.** `git`, `gh`, `build-essential`, `python3`, `uv`, `node` (via nvm), `curl`, `zsh`, `tmux`, `ripgrep`, `fd-find`, `jq`, `unzip`, `sqlite3` are present; the chosen agent is installed to its default location and runnable as `dev`. The first-login MOTD checklist accurately reflects which credentials are connected and updates after a `refresh-credentials` job.
5. **Credentials live and stay live.** For a user who connected credentials (in the wizard or later from the dashboard): after boot, `gh auth status` shows the user's GitHub identity **and still does 24 h later** (refresh loop verified); the Cloudflare token is usable from the agent context; pasted LLM keys are available to the agent. Rotating an LLM key in the dashboard updates the running container **without a restart**. No credential value appears in `jobs` rows, daemon logs, or Worker logs for any of these operations (verified by grepping logs after the test run).
6. **Free limits enforced.** Free container is hard-capped at 2048 MB RAM and 8 GB disk; CPU bursts to 1 vCPU but sustained 100 % usage is throttled per the ceiling; outbound port 25 is blocked; egress and connection-rate limits are measurable.
7. **Upgrade is in-place.** After Stripe payment (email captured), the existing container's limits are raised to 2 vCPU / 4096 MB / 32 GB; **home directory preserved**; container UUID unchanged; host disk/RAM accounting updated.
8. **Payment failure.** A simulated failed invoice suspends the container (state `suspended`, distinguishable from user-stopped) within the dunning outcome, emails the user, and the reconciler destroys it 7 days after `suspended_at` — with no manual intervention.
9. **No-key path works.** A user who skips the SSH pubkey receives an enrollment token; a scripted client can generate a keypair, register the pubkey via the enrollment endpoint (single-use, expiring token), and SSH in. Before enrollment, the container refuses all SSH auth.
10. **One-way paid tier.** No "downgrade" UI path exists; cancelling runs to period end, then grace; the 48-hour export window is requestable during grace and actually allows data copy-off.
11. **Account deletion.** A user can delete their account: container destroyed, credentials/keys purged, user row removed; a banned user's deletion retains only the nullifier HMAC.
12. **Multi-host-ready.** Adding a second host is the documented bootstrap runbook + a `hosts` row (no dashboard or daemon code changes), even though MVP launches with one host.
13. **Abuse posture present.** Rate limits enforced per container; ToS + privacy policy live (incl. telemetry disclosure and retention schedule); ban-on-nullifier runbook documented and the HMAC ban table enforced at signup; password SSH auth disabled.
14. **Resilience basics.** Host reboot → containers autostart, port forwards and limits re-applied, daemon resyncs state to D1. Stripe webhooks replayed twice process once (idempotency verified).

---

## 18. Test Suite

### Principles

1. **The AC list (§17) is the release gate; the test suite is how it's checked** — every acceptance criterion maps to automated tests (traceability below) or is explicitly designated manual. No release rides on an unscripted regression pass.
2. **Time never passes in tests.** Grace expiry, token refresh, port quarantine, sustained-CPU windows, and dunning are all driven by injected clocks, forced expiries, or Stripe **test clocks** — a 7-day grace test runs in seconds. The reconciler takes its clock as a parameter for exactly this reason.
3. **Two execution tiers.** A fast tier (unit + integration, everything in-process or in Miniflare) runs on every PR in under ~5 minutes; the full-stack tier (real Incus + ZFS on the dev box, §20) runs nightly and pre-release. Nothing in the fast tier needs network access to World ID, GitHub, Stripe, or a host.
4. **Secrets hygiene is an executable test, not a review rule.** Test runs inject distinctive **canary credentials** (e.g. `CANARY-github-token-…`); after the credential-lifecycle E2E, the suite greps D1 `jobs` rows, daemon logs, Worker logs, and alert output for any canary value and fails on a hit (AC5).
5. **Both sides of every wire protocol test against shared fixtures** (contract tests) so the control-plane Worker and the host daemon cannot drift apart silently. Both are Hono/TypeScript, so the RPC/crypto types, validators, and the auth **middleware itself** live in a **shared workspace package** mounted on both the Worker and the daemon — but the golden fixtures are still asserted independently on each side, guarding against one side's runtime (Workers vs. Node) diverging from the shared contract.

### Layers

| # | Layer | Scope | Tooling | Runs |
|---|---|---|---|---|
| L1 | Unit — control plane | Pure logic in Workers/TS | Vitest + `@cloudflare/vitest-pool-workers` (Miniflare D1/KV/Cron) | Every PR |
| L2 | Unit — daemon | Pure logic in Node/TS | Vitest (Node), faked `child_process` for Incus/nftables | Every PR |
| L3 | Contract — Worker↔daemon | Shared RPC/crypto fixtures | Golden files consumed by both the Workers and Node Vitest suites | Every PR |
| L4 | Integration — control plane | Full API flows against real D1 schema, mocked externals | `wrangler dev`/Miniflare; World ID simulator; GitHub App mock; Stripe CLI fixtures | Every PR |
| L5 | E2E — full stack | Real daemon + Incus + file-backed ZFS on the dev box | Test harness driving the public API + SSH client | Nightly + pre-release |
| L6 | Security & abuse | Firewall, limits, replay, hygiene | Runs inside L5 environment | Nightly + pre-release |
| L7 | Non-functional | Latency budgets | Runs inside L5 environment | Pre-release |

### L1 — Control-plane unit tests (Vitest, Miniflare-backed D1/KV)

- **World ID gate:** nullifier stored `UNIQUE`; duplicate nullifier rejected with the correct error; banned-nullifier HMAC match rejected at signup; nullifier never used as a key (schema assertion); SIWO `sub` bound at signup and matched at login.
- **Sessions:** KV session issuance/expiry; **revocation checked against D1** on sensitive operations (a revoked-in-D1 session with a still-live KV entry must be refused).
- **Container state machine:** every legal transition (`waitlisted → provisioning → running ↔ stopped`, `running → suspended → destroying`, `→ upgrade_pending`, `→ error → retry`) accepted; every illegal transition rejected; `suspended` and user-`stopped` remain distinguishable.
- **Scheduler:** placement picks the host with most unallocated *non-reserved* RAM; the 25 % `ram_reserve_mb` is untouchable for new placements but spendable for upgrades; reserve exhaustion yields `upgrade_pending`; `disk_allocated_gb` overflow refuses placement; capacity-exceeded yields `waitlisted`.
- **Port lifecycle:** `UNIQUE(host_id, ssh_port)` allocation; released ports enter `port_quarantine`; a quarantined port is not reused before 30 days (injected clock) and is reusable after.
- **Enrollment tokens:** only the hash is stored; single-use enforced; 1-hour TTL enforced; re-mint invalidates nothing it shouldn't.
- **Stripe webhooks:** duplicate `event_id` processed once; out-of-order delivery (e.g. `invoice.paid` after `customer.subscription.deleted`) converges on the state keyed by subscription status, not arrival order.
- **Jobs:** queue transitions (`queued → running → succeeded|failed`); stuck-job timeout → `error`; **schema-level assertion that `jobs` has no payload column** and job writers reject credential material.
- **Crypto:** credential master-key encrypt/decrypt round-trip; X25519 sealed-box **test vectors** (fixed keypair + plaintext → expected ciphertext behavior, tamper → open fails); nullifier-HMAC vectors.
- **Reconciler (logic level, injected clock):** `suspended_at` + 7 days → destroy job enqueued; export-window expiry; GitHub refresh triggered before `github_expires_at`; waitlist admission; D1↔`stats` drift produces corrective jobs.

### L2 — Daemon unit tests (Node/TS, Vitest)

- **Request auth:** valid signature accepted; bad signature, expired timestamp, and **replayed nonce** rejected (nonce check against the store interface, faked).
- **Sealed payloads:** decrypts the shared test vectors (L3); tampered ciphertext and wrong-key ciphertext fail closed; plaintext exists only in memory (no temp-file writes — asserted via a faked `fs`).
- **Incus/nftables command construction:** given a job, the exact CLI/API calls are asserted against a faked `child_process` — provision, resize (cgroup + ZFS quota values for both tiers), rebuild (home dataset preserved and re-attached), destroy, NAT port forward, egress/connection-rate rules, port-25 block.
- **Credential file writes:** correct per-agent paths for all four agents, mode `0600`, owner `dev`; `refresh-credentials` rewrites without restart; removal on credential deletion.
- **MOTD rendering:** checklist reflects exactly the connected/missing credential set; updates after a `refresh-credentials`/`sync-keys` job.
- **Boot resync:** given a fake Incus state diverging from expected state, the daemon reports the diff the reconciler needs; port forwards and limits re-application is idempotent.
- **Log hygiene:** error paths log credential *kinds*, never values (unit-level canary assertion).

### L3 — Contract tests (shared golden fixtures)

- A signed RPC request generated by the Worker code **verifies in the daemon code**, and vice-versa for responses; a sealed credential payload produced on the control-plane side **opens on the daemon side**. Because both run on the shared contract package, these tests primarily guard against the two runtimes (Workers vs. Node) diverging — e.g. Web Crypto vs. Node `crypto` — and against unintended edits to the shared package. Fixtures are committed golden files; a change on either side that breaks the wire format fails CI on both sides.
- JSON schemas for every job `op` payload and `stats`/`health` responses, validated by both suites.

### L4 — Control-plane integration tests (Miniflare, mocked externals)

- **Signup → wizard → provision-submit** end-to-end against the real D1 schema, with the **World ID simulator** (staging app) for verify/nullifier flows and an OIDC stub for SIWO.
- **GitHub App mock server:** authorization-code exchange, token mint with **forced short expiry**, refresh exchange — proving the reconciler refresh loop end-to-end and that the refresh token is never included in any daemon-bound payload (canary assertion).
- **Stripe:** recorded fixtures + `stripe` CLI webhook replay for checkout-completed, invoice-failed (dunning), subscription-canceled; **each webhook delivered twice, processed once** (AC14).
- **Reconciler cron invoked directly** with an injected clock against seeded D1 states: grace expiry, export-window expiry, stuck jobs, waitlist admission, refresh loop, drift correction — each produces exactly the expected job rows and emails (email provider faked behind the send interface, §9).
- **Daemon-down handling:** RPC target unreachable → job retries then fails to `error`; no state stuck in `provisioning` forever.

### L5 — End-to-end suite (dev box: real daemon, Incus, file-backed ZFS)

Runs the M0–M4 stack (§20) via the public API plus a real SSH client; asserts from the user's point of view:

1. **Provision → SSH (AC2, AC3):** wizard submit returns immediately; job completes; `ssh -p <port> dev@<host>` with the registered pubkey lands in a Debian 13 shell as `dev` with passwordless sudo; host-key fingerprints shown in the dashboard match the container's.
2. **All-skips path (AC2):** a user who skips every optional step reaches a running container; MOTD shows everything as missing; each step is then completable from the dashboard and applies live.
3. **Toolchain (AC4):** every §10 base-image tool present; the chosen agent runnable as `dev` — parameterized over all four agents.
4. **Credential lifecycle (AC5):** canary GitHub/Cloudflare/LLM credentials injected at boot; `gh auth status` works; forced token expiry + reconciler pass proves refresh (compressing the "24 h later" check); LLM-key rotation from the dashboard updates the file in the running container **without restart**; post-run canary grep over D1/daemon/Worker logs.
5. **Limits (AC6):** RAM hard cap enforced (allocation beyond 2048 MB fails inside the container); ZFS quota blocks writes past 8 GB; sustained-CPU throttle engages (test-config shortened window); outbound port 25 refused; egress and connection-rate limits measurable.
6. **Rebuild:** file written to `/home/dev` survives; agent reinstalled idempotently; system state reset.
7. **Upgrade in place (AC7):** simulated paid checkout → limits raised to 2 vCPU / 4096 MB / 32 GB live; marker file and container UUID unchanged; host accounting updated; reserve-exhausted case yields `upgrade_pending`.
8. **Suspension & grace (AC8):** simulated failed invoice (Stripe test clock) → `suspended` (distinct from user-stopped); clock advance → reconciler destroys after 7 days; notice emails fired at each stage (faked sender records them).
9. **Cancellation & export (AC10):** cancel → period end → grace; export window request starts the container for 48 h and data can be copied off; no downgrade path exists in the API (negative test).
10. **No-key enrollment (AC9):** pre-enrollment SSH refused entirely (fail-closed); scripted client generates a keypair, redeems the token, SSHes in; token re-use and expired-token redemption rejected.
11. **Account deletion (AC11):** container gone, credential and key rows purged, user row deleted; banned-user deletion leaves only the nullifier HMAC.
12. **Failure & recovery (AC3, AC14):** injected provision failure (fault flag in the daemon) → `error` + working retry, never a stuck spinner; daemon restart mid-job → job times out or completes, state converges; **host reboot** → containers autostart, port forwards and limits re-applied, D1 resynced.

### L6 — Security & abuse tests

- Password SSH auth refused; only pubkey offered works (AC13).
- Replayed signed daemon request rejected (real daemon, captured request re-sent); tampered sealed payload rejected.
- Signup with a banned nullifier HMAC blocked end-to-end.
- A leaked-Worker-cert simulation: a client with the mTLS cert but no valid signature/nonce gets nothing; a valid request without a sealed payload cannot extract credentials.
- Canary secrets-hygiene sweep (see L5.4) is the enforcement of the §10 code-review rule.

### L7 — Non-functional tests

- Provisioning latency: wizard submit → SSH-ready measured on the E2E run; budget ≤ 3 min (AC-adjacent; the dev box gets a documented budget of its own since it isn't the launch host).
- Dashboard read p95 smoke against the seeded dataset (< 300 ms target, §12).

### Fakes & fixtures inventory

| Dependency | Fast tier (L1–L4) | Full-stack tier (L5–L7) |
|---|---|---|
| World ID | Simulator (staging app) / OIDC stub | Simulator; one real Orb verify pre-launch (manual) |
| GitHub | GitHub App mock server (short-expiry tokens) | Mock server; real App smoke pre-launch (manual) |
| Stripe | CLI fixtures + webhook replay | Test mode + **test clocks** for dunning/grace |
| Email | Recording fake behind the send interface | Same fake; one real SPF/DKIM send pre-launch (manual) |
| Incus/ZFS/nftables | Fake `exec` (L2) | Real, on the dev box |
| Time | Injected clock everywhere | Injected clock + Stripe test clocks |
| Credentials | Canary values only — never real secrets in any tier | Canary values only |

### CI pipeline

| Stage | Contents | Trigger | Budget |
|---|---|---|---|
| PR gate | L1 + L2 + L3 + L4, lint, typecheck (both packages) | Every PR | ≤ 5 min |
| Nightly | L5 + L6 on the dev box (fresh daemon deploy via the bootstrap role — which regression-tests the runbook itself) | Nightly | ≤ 45 min |
| Pre-release | Full L1–L7 + manual checklist (real Orb verify, real GitHub App smoke, real email send, AC12 host bootstrap) | Before each release | — |

### AC traceability

| AC | Covered by | Manual residue |
|---|---|---|
| 1 World ID gating | L1, L4 (simulator) | One real Orb verify pre-launch |
| 2 Wizard incl. all-skips | L4, L5.1–2 | — |
| 3 Provisioning + error/retry | L5.1, L5.12, L7 | — |
| 4 Tools + MOTD | L2 (MOTD), L5.3 | — |
| 5 Credentials live + hygiene | L1, L4, L5.4, L6 canary sweep | — |
| 6 Free limits | L5.5 | — |
| 7 In-place upgrade | L1 (scheduler), L5.7 | — |
| 8 Payment failure | L4 (webhooks), L5.8 | — |
| 9 No-key path | L1 (tokens), L5.10 | — |
| 10 One-way paid + export | L5.9 | — |
| 11 Account deletion | L5.11 | — |
| 12 Multi-host-ready | Nightly bootstrap-role deploy | Standing up the real M5 host **is** the test |
| 13 Abuse posture | L5.5, L6 | ToS/privacy-policy publication |
| 14 Resilience basics | L4 (webhook replay), L5.12 | — |

Testing is not a milestone of its own: each milestone M0–M4 (§16) lands with its layer of this suite (M0 brings the CI skeleton and L3 contract harness; M1 the first L5 runs), and the pre-release stage gates M5.

---

## 19. Open / Noted Assumptions (labeled)

- **1 host at MVP**, Falkenstein, ~64 GB / 8-16 vCPU dedicated. Architecture is multi-host-ready.
- **Non-root `dev` user** with **passwordless sudo** per container.
- **Multiple SSH pubkeys** may be registered and managed via the dashboard; a container is reachable only once at least one key is registered or enrolled (fail-closed on the no-key path).
- **Capacity-exceeded → waitlist**, manually admitted; no autoscaling for v1. Because free-tier email is optional, the waitlist join screen asks for an (optional, strongly encouraged) email for the admission notice; users who decline are only reachable via dashboard polling — accepted for v1.
- **Email optional while free; required at paid checkout** (captured from Stripe) — grace-period notices must be deliverable.
- **Backups are v1.1.** A dead host loses its containers' disks in MVP.
- **Cloudflare token paste** assumes users can follow a guided token-creation flow; if drop-off is high, revisit (e.g., deep-link templates). *(Replaced the original "Cloudflare OAuth" assumption, which was unbuildable — no public third-party OAuth program.)*
- **GitHub App** approval/setup is on the operator; the token refresh loop is **control-plane-side** (reconciler) so the refresh token never leaves the control plane — hosts receive only short-lived tokens via `refresh-credentials` jobs.
- **Upgrade headroom reserve at 25 %** is a starting value; tune against real free/paid mix.
- **Each LLM provider and each coding agent is a swappable "shim"** behind a small interface; the provider list (OpenAI, Anthropic, Gemini, OpenRouter) and agent list (Pi, Claude Code, Codex, OpenCode) are both designed to grow with no core changes.
- **Pricing/zone numbers** (€/host, free unit cost, host-count) are planning-stage estimates.

---

## 20. Development Environment & Prerequisites

Everything through M4 is developable on free/test tiers plus one cheap Linux box; the dedicated launch host and Stripe live mode are M5 decisions.

### Accounts & registrations (before M0)

| Service | What to set up | Notes / gotchas |
|---|---|---|
| **Cloudflare** | Account + Workers/Pages/D1/KV/Cron/Secrets; product **domain** on Cloudflare DNS | Free tier + `wrangler dev` (Miniflare runs D1/KV locally) covers development. **Verify mTLS certificate bindings are available on the chosen plan before M0** — the daemon security model depends on them. Domain needed for OIDC redirects, GitHub callback, Stripe webhooks, email DKIM. |
| **World ID** (Worldcoin Developer Portal) | App + incognito action `signup`; enable Sign in with World ID (OIDC) | Use a **staging app** in development — it works with the Worldcoin **simulator**, so verify/nullifier/duplicate-rejection flows are testable without an Orb-verified phone. Keep at least one real Orb-verified World App for pre-launch production-mode testing. |
| **GitHub** | Register the **GitHub App** | Callback URL on the product domain; **user-to-server token expiry enabled** (the short-lived-token model depends on it); repo-scoped permissions only. |
| **Stripe** | Account in **test mode**; $5/mo product + price | Stripe CLI forwards webhooks to localhost and simulates failed invoices/dunning (drives AC8 end-to-end in dev). Live mode is an M5 switch. |
| **Email provider** | Transactional sender (§9) + SPF/DKIM on the domain | Needed by M3 (dunning/grace notices). |
| **Hetzner** | Account only | **Do not rent the dedicated host until M5** — see dev host below. |

### Dev stand-in for the Hetzner host

The daemon + Incus + ZFS layer needs a Linux environment, not a dedicated server:

- **One cheap box** — a Hetzner Cloud VPS (~€5-8/mo) or any local Linux machine/VM — running Debian with **Incus** and a **file-backed ZFS pool** (loopback file zpool: quotas, datasets, and native encryption behave identically to real disks). Incus *system containers* run fine inside a VM; nothing in v1 needs nested KVM.
- This one box serves all of M0-M4: daemon development, Ansible bootstrap-role testing, provision/rebuild/resize jobs, nftables egress rules + port-25 block, NAT port forwarding — and it is the execution environment for the nightly full-stack test tier (L5-L7, §18).
- The real Falkenstein host enters at M5 and **must** be brought up by the bootstrap runbook alone — standing it up is itself the AC12 test.

### Local toolchain

- **Node + wrangler** (Workers/Pages/D1), **Hono-on-Node** (host daemon — same framework as the control-plane Worker; long-running under systemd on the host), **Ansible** (bootstrap role), **Stripe CLI**.
- **Tunnel** (`cloudflared` or similar) so World ID redirects, GitHub App callbacks, and Stripe webhooks reach the dev machine.
- **Internal dev CA** (mkcert or scripted openssl) for the daemon server cert + Worker client cert during development; production certs are issued by the bootstrap runbook. The X25519 sealed-box layer is a library concern (libsodium-style), not infrastructure — cover it with test vectors.

### Dev-phase cost profile

Domain ~$10/yr + ~€5-8/mo dev VPS (or €0 on an existing Linux box); all else free/test tier. First real spend — dedicated host (~€40-60/mo) and Stripe live — lands at M5.
