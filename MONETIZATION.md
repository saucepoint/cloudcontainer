# MONETIZATION.md — Paid-User Readiness & Stripe Onboarding Plan

**Status:** Planning · **Branch:** `docs/monetization-plan` · **Last updated:** 2026-08-03

This document identifies everything required to begin supporting paid users on
usebench.dev and lays out the implementation plan for self-service onboarding
via **Stripe Billing**. It is grounded in the current codebase
(`apps/worker`, `apps/daemon`, `packages/contract`), the release contract
(`SPEC.md`), and current Stripe/Cloudflare guidance.

---

## 1. Current state (what exists today)

The system already has a **placement-ready paid architecture** with no billing
attached. `users.subscription_status` is `free | paid | dedicated` and is set
exclusively by operators through the fleet controller; the browser cannot
self-assert a paid class (`SPEC.md` §4.1: *"Public signup is free and needs no
credit card. Paid and dedicated service are operator-entitled until billing
exists"*).

| Concern | Where it lives today |
|---|---|
| Plan shapes | `TIERS` in `packages/contract/src/types.ts` (free: 1 vCPU/1536 MiB/1 GiB swap/5+5 GiB; paid: 2 vCPU/4096 MiB/no swap/8+8 GiB) |
| Plan → placement mapping | `SERVICE_PLANS` (free→budget, paid→regular, dedicated→dedicated) in `packages/contract/src/types.ts` |
| Entitlement gate | `servicePlanForSubscription()` in `apps/worker/src/placement.ts`; throws `ProvisioningNotAllowedError` for unknown statuses |
| Placement capacity math | `pickHost()` in `apps/worker/src/capacity.ts`; transactional INSERT guard in `startProvision()` |
| Waitlist admission | `apps/worker/src/reconciler.ts` (cron `*/5 * * * *`) re-checks tier CPU/RAM/disk reservations per host |
| Operator entitlement UI/API | `apps/worker/src/fleet-admin.ts` (assigns `subscription_status`, re-homes containers, applies service plan) |
| User row | `apps/worker/src/auth-schema.ts` (Drizzle) + `apps/worker/src/types.ts` `UserRow` |
| Reserved states | `suspended` (no billing UI drives it) and `upgrade_pending` ("Reserved for a future paid upgrade flow") in `CONTAINER_STATUSES` |
| Billing | **None.** No Stripe keys, no billing tables, no email, no webhooks. `SPEC.md` §"Explicitly not in the current release" |

Deliberate design points that make monetization cheap:

- Placement is already **class-segregated** (budget hosts accept only free
  accounts, regular hosts only paid, dedicated hosts one assigned paid
  account), so a paid entitlement *automatically* places on the right pool.
- Host accounting uses **provisioned** reservations (1 free / 3 paid vCPU)
  independent of public labels (`cpuReservation()`).
- `SERVICE_PLANS` keeps billing separate from placement
  ("A dedicated subscription is still a paid account").
- One container per account ⇒ one subscription per account: a **flat monthly
  plan is the natural billing unit** — no per-seat complexity.

---

## 2. Target monetization model (recommendation)

### 2.1 Plans

| Plan | Stripe Product/Price | Entitlement | Host class | Notes |
|---|---|---|---|---|
| Free | no price (signup) | `free` | budget | unchanged |
| **Pro** | monthly recurring, e.g. $12/mo (recommended starting point) | `paid` | regular | 2 vCPU / 4 GiB / 8+8 GiB |
| **Dedicated** | monthly recurring, e.g. $49/mo | `dedicated` | dedicated host | one tenant slot, exactly the current dedicated semantics |

Recommendations grounded in market research:

- **Flat monthly, not metered, for v1.** Peer products split between flat
  (Gitpod flat/usage hybrids) and pay-as-you-go (GitHub Codespaces is
  usage-based). A homogeneous one-container-per-account product with host-cost
  ceilings (`TIERS`) is easiest to price flat; per-minute metering adds
  Billing Meter complexity without v1 upside.
- **Annual plans later** via Stripe's built-in price switching
  (`customer.subscription.updated`), not v1.
- **Dedicated as a second product**, not a `price` on the Pro product, so
  plan/price → `SERVICE_PLANS` mapping stays 1:1.
- **Stripe Tax enabled from day one** for digital services (see §8.7); the
  worker already knows each account's locale via Better Auth signup, and
  Stripe collects the rest.

### 2.2 Entitlement model (source of truth)

**Stripe is the source of truth; D1 is an authorization cache.** Webhooks
write entitlement state into D1; the cron reconciler sweeps for drift (missed
webhooks, stale sync). All existing placement/reconciler code keeps reading
`users.subscription_status` + `containers.tier/placement_class` — the same
columns operators write today — so **no placement math changes**.

The only new concept is *how* the status is derived:

```
Stripe Customer ──subscription──▶ Stripe Subscription (status: trialing|active|past_due|canceled|…)
                                      │  webhooks + cron sweep
                                      ▼
                        D1: customers + subscriptions + billing_events (cache)
                                      │  entitlement projection
                                      ▼
              users.subscription_status  →  SERVICE_PLANS  →  placement
```

---

## 3. Required refactors (pre-requisite code changes)

These are **non-breaking** cleanups that must land before any Stripe code.

### R1. Extract an entitlement layer (`apps/worker/src/billing/entitlements.ts`)

Today `servicePlanForSubscription()` (placement.ts:52) is the only
entitlement gate, and fleet-admin re-implements plan math inline
(fleet-admin.ts:256–284). Create one module that:

- maps `{ billing mode, stripe subscription status, plan } → subscription_status`;
- is the **single call site** for `users.subscription_status` writes
  (webhook handler, cron sweep, fleet-admin legacy path);
- exposes `entitlementFor(user) → { plan, tier, hostType }` used by
  placement, reconciler, and the dashboard.

### R2. Add billing tables + migration (see §5.1, migration `0017`)

New D1 tables `stripe_customers`, `stripe_subscriptions`, `stripe_billing_events`.
Expand-first per repo convention: additive only; nothing existing is dropped.

### R3. Introduce `billing_mode` on users (migration `0017`)

`billing_mode TEXT NOT NULL DEFAULT 'manual'` — distinguishes
operator-entitled accounts (`manual`, the current fleet-admin path) from
Stripe-managed accounts (`stripe`). This is the seam that lets existing
paid/dedicated users keep service during the rollout without fabricating
Stripe subscriptions.

### R4. Route registration for a public webhook (`apps/worker/src/index.tsx`)

Add `app.post("/api/stripe/webhook", ...)` (or `billingRoutes` module mounted
alongside `subscriptionRoutes` at index.tsx:103). The custom domain
(`usebench.dev`) is already a public route; the webhook endpoint must be
public HTTPS with **no auth middleware** (signature verification replaces
session auth).

### R5. Billing status in the dashboard model

`dashboard-model.ts` already renders `upgrade_pending`; add `past_due` and
`billing_mode`-aware display so the UI never shows a "paid" state the billing
system doesn't confirm.

### R6. Encrypted at-rest conventions for Stripe IDs

No card data ever enters D1 (PCI scope stays with Stripe). Customer IDs and
subscription IDs are not secrets, but keep them out of job rows/logs anyway
(consistent with `SPEC.md` §10 credential hygiene).

---

## 4. Required breaking changes

These change existing behavior or contracts and need coordinated
Worker/daemon/contract releases per `AGENTS.md` (expand-first, runbook).

### B1. `subscription_status` semantics narrow (contract + fleet-admin)

`SERVICE_PLANS` and `servicePlanForSubscription()` accept exactly
`free|paid|dedicated`. Stripe subscriptions introduce transient states
(`trialing`, `past_due`, `canceled`, `unpaid`) that **must not** leak into
`users.subscription_status`. Projection rule (keeps the enum closed):

| Stripe subscription status | projected `subscription_status` |
|---|---|
| `trialing`, `active` | plan (`paid` / `dedicated`) |
| `past_due`, `unpaid` | plan but `billing_status='past_due'` column (new) |
| `canceled` | `free` after grace/export window (see §8.4) |
| `incomplete` / `incomplete_expired` | `free` |

**Breaking:** fleet-admin SQL that enumerates `IN ('free','paid','dedicated')`
(still valid), and any code that treats `subscription_status` as the full
billing truth (it becomes entitlement-only). Audit: placement.ts:52,
fleet-admin.ts:97–284, reconciler.ts:296, auth-schema.ts:10.

### B2. Provision guard changes (behavior, expand-first)

`startProvision()` must refuse **free** provisioning for a `stripe`-mode user
whose subscription is `past_due` beyond the grace window (currently any
`free` status can provision). The reconciler must gain a matching guard so a
downgraded user's waitlisted container cannot sneak onto a paid host.

### B3. `ContainerSpecSchema.tier` stays `free|paid` — no change needed

Dedicated uses the paid shape (SPEC §8), so **no daemon contract change** for
plans. Daemon never learns about Stripe. This is a deliberate non-change; the
only daemon-side addition is a **suspend** capability (see B4).

### B4. Daemon: suspend/resume lifecycle (breaking for daemon API)

The container statuses `suspended`/`upgrade_pending` exist in
`CONTAINER_STATUSES` but no daemon op drives them (`JOB_OPS` has no
`suspend`). Dunning needs a hard stop that preserves data. Add:

- `JOB_OPS` += `suspend` (Incus `instance stop` + keep rootfs) and `resume`;
- Worker-side `suspend`/`resume` API paths and reconciler handling for
  `suspended` containers;
- daemon `apps/daemon/src/jobs.ts` op handlers + tests.

**Breaking:** new op values flow Worker→daemon; older daemons must reject
unknown ops gracefully (they already validate `JobRequestSchema`, which is
strict — ship daemon first, then Worker, per runbook).

### B5. Better Auth schema column (auth-schema.ts)

`subscriptionStatus` stays; add `billingMode` to the Drizzle table definition
to match migration `0017`. Drizzle is not the migration driver here (raw SQL
migrations are), so keep the two in sync manually with a test assertion
(migrations.test.ts pattern).

---

## 5. Required upgrades (infrastructure & dependencies)

### 5.1 D1 migration `0017_billing.sql` (draft)

```sql
-- Stripe billing: Stripe is the source of truth; D1 is the authz cache.
CREATE TABLE stripe_customers (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL
);

CREATE TABLE stripe_subscriptions (
  id                   TEXT PRIMARY KEY,          -- stripe subscription id
  user_id              TEXT NOT NULL REFERENCES users(id),
  stripe_customer_id   TEXT NOT NULL,
  price_id             TEXT NOT NULL,
  plan                 TEXT NOT NULL,             -- 'paid' | 'dedicated'
  status               TEXT NOT NULL,             -- Stripe raw status
  current_period_end   INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_user ON stripe_subscriptions(user_id);

-- Idempotency ledger for webhook events (dedupe replays).
CREATE TABLE stripe_billing_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  processed_at INTEGER NOT NULL
);

-- Projection columns for Stripe-managed users (expand-first).
ALTER TABLE users ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE users ADD COLUMN billing_status TEXT;  -- NULL | 'past_due' | 'grace' | 'export_window'
```

### 5.2 Worker secrets (wrangler secret put)

| Secret | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` locally / `sk_live_…` in prod; never a var |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the dashboard endpoint config |
| `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_DEDICATED_MONTHLY` | price IDs (could be vars; secrets keep them out of git) |

### 5.3 Dependency + runtime

- Add `stripe` npm package to `apps/worker` (pure-fetch HTTP client; works
  under Workers' `nodejs_compat`). Pin exact version; the SDK's Node-only
  helpers (e.g. `stripe.webhooks.constructEvent`) need Node `crypto` — under
  Workers use the **manual verification path** (§6.3) with Web Crypto.
- `nodejs_compat` is already enabled (wrangler.jsonc) — no wrangler config
  change for the SDK itself.
- `wrangler.jsonc` vars: nothing new required; `BASE_URL` already exists for
  success/cancel URLs.

### 5.4 Developer tooling

- Stripe CLI (`stripe listen --forward-to localhost:8787/api/stripe/webhook`)
  for local webhook replay and `stripe trigger` fixtures.
- Test-mode API keys in `.dev.vars` (never committed; `.gitignore` already
  excludes it).
- CI: add a `STRIPE_WEBHOOK_SECRET`-derived fixture so webhook signature
  tests run in Vitest without network (see §9).

### 5.5 Email (needed for receipts & dunning — SPEC roadmap item)

`SPEC.md` lists "Stripe, email, and a documented grace/export policy" as the
roadmap. Options:

1. **Cloudflare Email Service (Email Routing + Workers binding)** — stays on
   the platform, no new vendor. Recommended: transactional sends from the
   Worker (receipts, dunning warnings, export-window notices).
2. Resend/Postmark via `fetch`.

v1 minimal: Stripe **hosted invoices** already email receipts *when Stripe
customer email + receipt settings are enabled* — the app can ship without its
own email and add it in the dunning phase.

---

## 6. Stripe onboarding — implementation plan (phases)

### Phase 0 — Refactor & readiness (1–2 weeks, no Stripe dependency)

1. Land R1–R6, B1–B5, migration `0017` (§3–§5).
2. Freeze `subscription_status` enum semantics; add `billing_mode`/`billing_status` projection.
3. Add daemon `suspend`/`resume` ops (B4) with tests; deploy daemons fleet-wide first.
4. Define and document the grace/export policy constants in `packages/contract`:

   ```ts
   export const BILLING_POLICY = {
     dunningRetries: 3,            // Stripe Smart Retries (default)
     gracePeriodDays: 7,           // keep service after final failure
     exportWindowDays: 30,         // suspended, data retrievable
     destroyAfterDays: 30,         // after export window closes
   } as const;
   ```

   **Gate:** typecheck + lint + full Vitest suite green; `deploy:dry-run` passes.

### Phase 1 — Stripe account & catalog (1–2 days, operator task)

1. Create Stripe account; enable **Billing**, **Customer Portal**, **Stripe Tax**, **Smart Retries** (dashboard: Settings → Billing → automatic collection / revenue recovery).
2. Create products/prices in **test mode** first:
   - `prod_pro` — recurring monthly price (e.g. $12.00); metadata `plan=paid`.
   - `prod_dedicated` — recurring monthly price (e.g. $49.00); metadata `plan=dedicated`.
3. Add head-office address + tax registrations for Stripe Tax (digital services; registrations vary by jurisdiction).
4. Register the webhook endpoint `https://usebench.dev/api/stripe/webhook` with events:
   `checkout.session.completed`, `customer.subscription.created/updated/deleted/paused/resumed`,
   `invoice.paid`, `invoice.payment_failed`, `invoice.finalization_failed`, `charge.dispute.created`.
5. Record the `whsec_…` signing secret; `wrangler secret put STRIPE_WEBHOOK_SECRET`.

### Phase 2 — Checkout (self-service upgrade) (~1 week)

New module `apps/worker/src/billing.ts` (Hono router, mirroring
`subscriptions.ts` style), mounted in `index.tsx`.

**Endpoint: `POST /api/billing/checkout`** (session-authenticated)

1. Look up/create Stripe `Customer` (`customer_creation: "always"`, `email`,
   `metadata: { userId }`, `client_reference_id: userId`).
2. Create `Checkout Session`:
   ```ts
   stripe.checkout.sessions.create({
     mode: "subscription",
     customer: customer.id,
     client_reference_id: user.id,
     line_items: [{ price: PRICE_ID, quantity: 1 }],
     subscription_data: { metadata: { userId: user.id } },
     automatic_tax: { enabled: true },
     allow_promotion_codes: true,
     success_url: `${BASE_URL}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
     cancel_url: `${BASE_URL}/account?checkout=cancelled`,
   });
   ```
3. Store nothing yet — the webhook is the write path. Return `{ url }`; the
   client redirects (dashboard "Upgrade" button → this endpoint).

**Guard rails:** refuse checkout for already-active Stripe subscriptions
(redirect to portal instead); require `verified_at` (World ID/invite) so
billing can't attach to unverified accounts; never accept a plan argument from
the client — the server derives `price_id` from a server-side map.

**Endpoint: `GET /api/billing/portal`** → create
`billing_portal.sessions.create({ customer, return_url: BASE_URL + "/account" })`
and redirect. This gives self-service card updates, plan switch (if
configured), and cancellation — zero custom UI for payment methods.

### Phase 3 — Webhooks & entitlement sync (~1 week, the critical path)

**Endpoint: `POST /api/stripe/webhook`** (no session auth, public)

1. **Read the raw body first** (`await c.req.text()`). Verify the
   `stripe-signature` header against the **exact raw bytes** with the
   `whsec_` secret — never `JSON.stringify`/re-serialize before verifying
   (Stripe signs the raw payload; this is the #1 Workers integration bug).
   Workers have no Node `crypto` in the Stripe SDK path, so implement HMAC
   verification with Web Crypto:
   - parse `t=<ts>,v1=<sig>` from the header;
   - reject if `|now − t| > 300s` (tolerance per Stripe docs);
   - `HMAC-SHA256(whsec, `${t}.${rawBody}`)` via `crypto.subtle.importKey` +
     `crypto.subtle.sign`; constant-time compare of hex digests.
2. Return `200` fast; enqueue/process the event. Because D1 writes are
   cheap and Workers have no queue binding today, process inline but **make
   every handler idempotent** via the `stripe_billing_events` ledger
   (INSERT OR IGNORE by `event.id`; skip if already processed).
3. Event handling table (from Stripe's "Using webhooks with subscriptions"
   guide):

   | Event | Handler action |
   |---|---|
   | `checkout.session.completed` | Insert/update `stripe_customers`; create `stripe_subscriptions`; project entitlement; set `billing_mode='stripe'`; if account has no container, leave onboarding to resume; if container exists at `free`, **enqueue upgrade** (`upgrade_pending` → resize/re-provision per plan) |
   | `customer.subscription.created` | Same as above (idempotent; covers async creation) |
   | `customer.subscription.updated` | Sync status/period/price; **plan change** → enqueue resize/rehome to new `placement_class`; `cancel_at_period_end` → leave entitlement until period end |
   | `customer.subscription.deleted` | End of service: begin **grace → export window** (§8.4) |
   | `customer.subscription.paused` / `.resumed` | Mirror status; pause entitlement only after grace policy |
   | `invoice.paid` | Clear `billing_status`; confirm entitlement stays active |
   | `invoice.payment_failed` | Set `billing_status='past_due'`; email warning (Phase 5); Stripe Smart Retries continues automatically |
   | `invoice.finalization_failed` | Log + alert operator (usually Stripe Tax location issue: `automatic_tax[status]=requires_location_inputs` → ask customer for location) |
   | `charge.dispute.created` | Alert operator; suspend entitlement pending resolution (fraud policy) |

4. **Cron reconciliation** (extend the existing `*/5 * * * *` handler in
   `reconciler.ts`): for `billing_mode='stripe'` users, refresh
   `customer.subscriptions.list({ customer })` when `last_synced_at` is stale
   (> 15 min) or on webhook-verify failures; apply the same projection. This
   makes webhook delivery failure self-healing.

### Phase 4 — Lifecycle: dunning, downgrade, export (1 week)

Implementation of the policy from §8.4:

1. `invoice.payment_failed` → `billing_status='past_due'`; UI banner + email;
   Stripe Smart Retries runs (typically 4 attempts over ~2 weeks).
2. After final failure / `subscription.deleted` → **grace period**
   (`BILLING_POLICY.gracePeriodDays`, entitlement retained, `billing_status='grace'`).
3. Grace expiry → **suspend container** (new daemon `suspend` op, B4);
   status `suspended` (finally driven by billing!); `billing_status='export_window'`.
4. Export window: dashboard shows read-only data-access instructions (SSH
   key access to `suspended` instance is not possible — provide documented
   export path: operator-assisted snapshot or resume-then-export; simplest v1:
   allow the user to re-subscribe → auto-resume, or request a 48h export
   resume via support).
5. `destroyAfterDays` → `destroy` job; container + host accounting released.
6. **Re-subscribe path**: new Checkout Session for an existing customer
   resumes/creates a subscription; webhook `checkout.session.completed` →
   `resume` container if it still exists.

### Phase 5 — UI, tax, email, observability (1 week)

1. **Landing/account UI** (`apps/worker/src/pages/views.tsx`, `account.ts`):
   - Account page "Plan" card: current plan, price, renews-on date,
     `past_due` warning, buttons: Upgrade (checkout), Manage (portal).
   - Dashboard banner when `billing_status` is `past_due`/`grace`/`export_window`.
2. **Stripe Tax**: verify `automatic_tax` on Checkout; handle
   `requires_location_inputs` (`invoice.finalization_failed` handler asks the
   customer for a billing address via portal).
3. **Email** (Cloudflare Email Service): receipt fallback, dunning warnings,
   export-window expiry notice, dispute notice.
4. **Observability**: log webhook event counts, sync lag, entitlement
   projection failures; alert on `invoice.finalization_failed` and
   `charge.dispute.created`; add billing section to the existing
   fleet-admin dashboard for operator visibility of Stripe-managed users.
5. **Fleet capacity planning**: track paid-host occupancy; since placement is
   class-segregated, growth of paid users consumes regular-host capacity —
   add a capacity forecast note to `infra/` ops docs.

### Phase 6 — Launch checklist

- [ ] Test-mode end-to-end: signup → upgrade → provision on regular host → invoice.paid → portal card update → cancel → grace → suspend → destroy.
- [ ] `stripe listen` replay of every subscribed event against local Worker; idempotency verified by double-replay.
- [ ] Stripe CLI `stripe trigger customer.subscription.updated` etc. against Vitest + local.
- [ ] Migrate existing operator-entitled paid/dedicated users: set `billing_mode='manual'` (grandfathered, no forced re-buy) — decision documented in §10.2.
- [ ] Switch secrets to live keys; register live webhook endpoint; run with `billing_mode` default `manual` so **nothing changes for existing users**.
- [ ] Flip onboarding/dashboard to expose Upgrade only after smoke tests pass.
- [ ] Update `SPEC.md` "Explicitly not in the current release" and README feature list; note the grace/export policy publicly (SPEC requires "a documented grace/export policy").

---

## 7. Security & compliance requirements

1. **PCI**: no card data in code, D1, or logs. Stripe.js/Checkout is fully
   hosted; we only ever handle `customer_id`/`subscription_id`.
2. **Webhook authn**: signature verification is mandatory and is the *only*
   authn on the endpoint. Replay protection = timestamp tolerance + event
   ledger. Do not accept unverified events from any other source.
3. **Secrets**: `sk_live`/`whsec` only as Worker secrets; test keys only in
   `.dev.vars`; never in `wrangler.jsonc` vars (the current file documents
   every var in plaintext — price IDs may live there, keys must not).
4. **Idempotency**: every webhook handler is INSERT-OR-IGNORE by event ID;
   every Stripe API mutation from the Worker uses Stripe idempotency keys
   (`Idempotency-Key: op:userId:nonce`) because Workers can retry.
5. **Least privilege**: Stripe secret key should be restricted via Stripe
   API-key restrictions (IP allowlist to Cloudflare egress, restricted keys
   scoped to billing resources) where the plan allows.
6. **PII/GDPR**: account deletion already exists; extend it to delete
   `stripe_customers`/`stripe_subscriptions` rows and (asynchronously)
   `customer.delete` + subscription cancel in Stripe.
7. **Abuse**: free tier is human-verified (World ID/invite) and one
   container/account; paid signup adds a billing identity — keep the World ID
   gate for all signups (SPEC §4.1) to avoid paid-churn abuse.

---

## 8. Key product decisions to make (with recommendations)

1. **Price points** — recommend $12 Pro / $49 Dedicated monthly; validate
   against host cost per slot before locking.
2. **Free-tier future** — current free tier (1 vCPU/1.5 GiB/5+5 GiB) is
   generous vs paid; consider tightening free or adding a timeout so paid
   conversion has headroom. **Not required for v1** (SPEC freezes free tier).
3. **Trials** — recommend a 7-day paid trial (Stripe `trial_period_days`)
   after checkout v1 ships; `customer.subscription.updated` handles
   `trialing→active`.
4. **Plan switching** — v1: upgrade Pro↔Dedicated via portal/checkout; the
   placement classes already make this a rehome (`fleet-admin.ts` rehome
   path is the template). Downgrades take effect at period end (Stripe
   proration off by default, on if desired).
5. **Refunds/disputes** — standard Stripe dispute flow; suspend entitlement
   on `charge.dispute.created` pending resolution.
6. **Grandfathering** — existing operator-entitled paid/dedicated users keep
   service with `billing_mode='manual'`; migration script sets this
   explicitly so Stripe never sees them (no double-charging).

---

## 9. Testing strategy

Follow repo conventions (Vitest, in-memory D1, `stubFetch` — no real
network/Stripe):

| Test area | Approach |
|---|---|
| Checkout endpoint | `stubFetch` a fake Stripe API (`api.stripe.com` routes): assert session creation payload, customer metadata, auth requirement, unverified-user rejection |
| Webhook signature | Fixture: known `whsec_`, `t=`, `v1=` generated locally with the same HMAC (test-only helper); assert accept/400 on tampered body, stale timestamp (>300s), wrong key |
| Event handlers | Replay captured event JSON per event type; assert D1 rows + `users.subscription_status` projection; **double-replay asserts no-op** (idempotency ledger) |
| Entitlement projection | Table-driven: every Stripe status × plan → expected `subscription_status`/`billing_status` (B1 table) |
| Lifecycle | `invoice.payment_failed` → grace → suspend op enqueued (daemon op asserted via `jobs`), export window, destroy |
| Reconciler sweep | Missed-webhook simulation: stale `last_synced_at` → refresh from stub API → projection applied |
| Daemon ops | `suspend`/`resume` handlers with injected Incus command execution (existing daemon test pattern) |
| Migration | `migrations.test.ts` pattern: `0017` applies cleanly on a fresh + populated DB |
| CI | Same pipeline (build client → typecheck → lint → test); add a billing test file `apps/worker/test/billing.test.ts` |

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Webhook mis-verification (raw body re-serialization) | Read `c.req.text()` once; verify HMAC over exact bytes; integration test with tampered payloads |
| Missed/delayed webhooks → wrong entitlement | Cron sweep every 5 min; `last_synced_at` staleness check; projection is pure so replay is safe |
| Double-charge grandfathered users | `billing_mode='manual'` default; explicit migration; fleet-admin untouched |
| Daemon op mismatch during rollout | Ship daemon `suspend`/`resume` first; `JobRequestSchema` strict rejection makes older daemons fail loudly, not silently |
| Paid-host capacity exhaustion | Class-segregated placement means paid growth only fills regular pool; monitor occupancy in fleet-admin; price per slot covers acquisition (runbook note) |
| Tax finalization failures | Stripe Tax from day one; `invoice.finalization_failed` handler prompts for location; operator alert |
| Chargebacks/fraud | World ID gate retained; dispute webhook → entitlement hold + alert |
| Scope creep (metered billing, annual plans) | Explicitly deferred; document as follow-ups (§11) |

---

## 11. Follow-ups (explicitly out of v1)

- Usage-based pricing via **Stripe Billing Meters** (the daemon already
  reports `uptimeSec` per container in `StatsResponseSchema` — metering data
  exists; only the billing model is missing).
- Annual/prepaid plans, coupons in the portal, referral credits.
- Automatic invoice email branding (Stripe hosted invoices suffice first).
- Multi-environment (multi-container) paid plans — would break the
  one-container-per-account invariant and the `UNIQUE user_id` container
  constraint; needs a contract change.

---

## 12. Source references

- Stripe — Receive events in your webhook endpoint: raw-body verification,
  `whsec_` signing secret, `stripe listen` local forwarding:
  https://docs.stripe.com/webhooks
- Stripe — Using webhooks with subscriptions (event table, payment-failure
  handling, Smart Retries, `invoice.finalization_failed` tax behavior):
  https://docs.stripe.com/billing/subscriptions/webhooks
- Stripe — Checkout Sessions API (`mode=subscription`, `automatic_tax`,
  `client_reference_id`): https://docs.stripe.com/api/checkout/sessions
- Stripe — Customer Portal integration:
  https://docs.stripe.com/customer-management/integrate-customer-portal
- Stripe — Usage-based billing / Billing Meters (future metered model):
  https://docs.stripe.com/billing/subscriptions/usage-based
- Stripe — Tax setup (head office, registrations, automatic tax):
  https://docs.stripe.com/tax/set-up
- Cloudflare — Workers runtime: `nodejs_compat` is not full Node; use Web
  Crypto (`crypto.subtle`) for HMAC in Workers:
  https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Cloudflare — Workers best practices (floating promises, fetch-based
  external calls): https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- Market pricing context — GitHub Codespaces (usage-based) vs flat monthly
  models: https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces
