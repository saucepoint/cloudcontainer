# Monetization and Stripe subscription plan

**Status:** Implemented behind launch gate; production configuration and acceptance pending · **Last updated:** 2026-08-11

This document defines paid onboarding, billing, entitlement, container upgrades,
and mixed-tier host placement for usebench.dev.

`SPEC.md` is the normative runtime contract. This document retains the design
rationale and, in §17, the ordered production launch checklist.

---

## 1. Goals and scope

### 1.1 Required outcomes

The first billing release must:

- offer one self-service paid tier through Stripe Checkout;
- let an authenticated user pay without World ID or an invite;
- let an already verified free user upgrade from the dashboard;
- upgrade an existing free container without deleting user data;
- keep full paid service until a scheduled cancellation takes effect;
- use the Stripe Customer Portal for payment and cancellation management;
- tolerate duplicate, delayed, missing, and out-of-order webhooks; and
- place free and paid containers together on shared hosts.

Dedicated service remains operator-managed in v1. It can use the same
entitlement model later, but it is not exposed as a Stripe price until its
capacity and price are approved.

### 1.2 Non-goals for v1

The following are deferred:

- usage-based billing and Stripe Billing Meters;
- annual billing, credits, coupons, and seat quantities;
- multiple containers per account;
- automatic cross-host storage migration; and
- self-service dedicated-host purchase.

### 1.3 Decisions that still need commercial approval

Engineering must not invent these values:

- paid price and currency;
- tax registrations and countries served;
- failed-renewal grace duration;
- export-window duration;
- refund and dispute policy; and
- whether a verified user keeps oversized paid storage after downgrade.

Commercial policy periods must be configuration with tests. The seven-day Paid
trial is an explicit product requirement and a single exported constant.

---

## 2. Review findings in the previous plan

The previous plan had useful inventory and security guidance, but several
assumptions were incorrect or incomplete.

| Finding | Correction in this plan |
|---|---|
| Free and paid hosts were treated as permanently separate pools. | Shared hosts accept both tiers; only dedicated placement remains exclusive. |
| Paid checkout required prior World ID or invite verification. | A valid paid entitlement is an alternative eligibility path. Authentication is still required. |
| Cancellation and non-payment were conflated. | Scheduled cancellation preserves paid service through the paid-through time; failed renewal follows a separate dunning policy. |
| `checkout.session.completed` was treated as proof of payment. | Grant trial access only from canonical `trialing` state and paid-through service only when `invoice.paid` accompanies canonical `active` subscription state. Delayed methods can complete Checkout before settlement. |
| Webhooks were acknowledged before durable processing without a queue. | Verify, durably enqueue, then acknowledge. The consumer is idempotent and order-independent. |
| The draft stored a subscription-level `current_period_end`. | Pin a Stripe API version and read period bounds from the subscription item for current Stripe API versions. |
| Stripe retry counts and timing were hard-coded. | Stripe recovery settings are operator configuration; local policy uses timestamps received from Stripe. |
| Existing free-container upgrades were described only as resize or destructive rehome. | Reserve the resource delta and resize in place. Never destroy data merely to apply a paid plan. |
| `verified_at` was going to represent paid eligibility. | Keep permanent free eligibility separate from revocable paid entitlement. |
| A new daemon suspend API was assumed necessary. | The daemon already supports stop/start. Add billing-specific control-plane semantics before adding redundant wire operations. |
| Price IDs were described as secrets. | Price IDs are non-secret configuration. Secret keys and webhook secrets remain Worker secrets. |
| Checkout combined `customer_creation: "always"` with an existing customer. | Create or retrieve the Customer first, then pass its ID to Checkout. |
| A cron intended to repair missed webhooks was underspecified. | Reconciliation compares canonical Stripe state with D1 and drives time-based expiry. |
| Immediate suspension on disputes was proposed without a product policy. | Disputes alert operators; service changes follow the approved refund and fraud policy. |
| Cloudflare Email Sending was treated as generally available. | It is currently beta and requires a Workers Paid plan; Stripe email is the launch fallback. |

---

## 3. Current architecture

Today:

- `users.subscription_status` is `free | paid | dedicated`;
- `SERVICE_PLANS` maps those values to a resource tier and tenancy mode;
- `budget` and `regular` are legacy labels on shared hosts, and either host can
  accept Free or Paid containers;
- `dedicated` hosts accept one assigned account;
- new placements use exact per-container reservations and the host with the
  greatest post-placement availability;
- CPU placement targets are fixed at 4x online vCPUs and RAM targets at 1.25x
  non-reserved memory;
- a shared daemon accepts either resource tier;
- `resize` can change Incus CPU, RAM, swap, root disk, and home volume size;
- operator rehome destroys the old instance before reprovisioning; and
- Stripe Checkout, subscriptions, and webhooks remain behind the launch gate.

The current rehome path is explicitly destructive. It is not an acceptable
paid-upgrade mechanism.

The current `resize` state transition also assumes success means `running`.
Paid work must preserve whether the container was running or stopped.

---

## 4. Product plans and eligibility

### 4.1 Plan model

| Product plan | Resource tier | Placement mode | Billing source |
|---|---|---|---|
| Free | `free` | `shared` | none |
| Paid | `paid` | `shared` | Stripe or operator |
| Dedicated | `paid` | `dedicated` | operator in v1 |

Free and Paid differ in container resources, not in shared-host hardware type.
A host can run any safe combination that fits its resource budget.

### 4.2 Authentication is always required

Payment does not replace authentication. Checkout requires a valid Better Auth
session and binds the Stripe Customer to the internal user ID.

An unauthenticated visitor must sign in or create an account before Checkout.
No browser-supplied email or Stripe metadata is trusted as an account binding.

### 4.3 Two independent eligibility paths

Permanent free eligibility remains:

```text
verified_at != null
AND verification_method in (world_id, invite, development)
```

Paid eligibility is time-bound by either a canonical trial or collected service:

```text
(stripe status is trialing AND trial_end > now AND trial is not canceled)
OR (stripe entitlement is active AND service_until > now)
```

Do not set `verified_at` merely because a user paid. Otherwise a user could pay
once, cancel, and retain free service without satisfying the free-tier gate.

Authorization becomes:

```ts
function effectiveEntitlement(account, billing, now) {
  if (billing.manualPlan) return billing.manualPlan;

  if (billing.plan === "paid" && billing.accessUntil > now) {
    return { eligible: true, plan: "paid", source: "stripe" };
  }

  if (account.verifiedAt) {
    return { eligible: true, plan: "free", source: account.verificationMethod };
  }

  return { eligible: false, plan: null, source: null };
}
```

Replace route assumptions such as “verified means authorized” with a shared
`requireEligibleAccount` middleware. Update `postLoginPath` and every onboarding,
dashboard, CLI, credential, and container route to use the same projection.

### 4.4 User journeys

**Unverified authenticated user:**

1. The `/verify` page offers World ID, invite, or “Continue with Paid.”
2. Paid starts Checkout through an endpoint guarded by `requireAccount`.
3. The success page shows “activating trial” until canonical Stripe state is processed.
4. A valid seven-day trial routes the user to onboarding or the dashboard.

**Verified free user without a container:**

1. The dashboard or account page offers Upgrade.
2. After the trial is confirmed, onboarding provisions directly with the paid tier.

**Verified free user with a container:**

1. The dashboard offers Upgrade.
2. Paid resources start when the trial is confirmed.
3. A plan-transition job upgrades the existing container in place.
4. The UI shows `upgrade_pending` until the desired resources are applied.

---

## 5. Entitlement and billing state

### 5.1 Separate facts from projections

Stripe objects are billing facts. Effective entitlement is a local projection.
Container state is an asynchronous realization of that entitlement.

```text
Stripe Customer + Subscription + paid Invoice
                    |
                    v
D1 billing facts: status, price, cancel flag, trial_end, service_until
                    |
                    v
Effective entitlement: none | free | paid | dedicated
                    |
                    v
Desired container tier and placement mode
                    |
                    v
Actual Incus limits and D1 host reservations
```

Do not use `users.subscription_status` as the complete billing state. During a
rolling migration it can remain a compatibility projection.

### 5.2 Recommended state fields

Use explicit timestamps rather than inferring access from labels:

- `service_until`: exclusive end of paid access;
- `trial_end`: exclusive end of the fixed seven-day free trial;
- `cancel_at`: when a scheduled cancellation becomes effective;
- `grace_until`: optional failed-renewal grace deadline;
- `last_paid_invoice_id`: prevents an old event extending access twice;
- `stripe_status`: Stripe's raw subscription status; and
- `entitlement_state`: local display and workflow state.

Suggested local entitlement states:

```text
pending | trialing | active | cancel_scheduled | past_due | grace | expired | manual
```

`past_due` does not itself answer whether access is allowed. Access is allowed
while an uncanceled `trial_until`, `service_until`, or approved `grace_until`
is in the future.

### 5.3 Stripe status projection

| Stripe state | Local action |
|---|---|
| `incomplete` | No paid access; show payment action required. |
| `incomplete_expired` | No paid access; allow a fresh Checkout attempt. |
| `trialing` | Paid resources through `trial_end`; cancellation revokes trial access immediately. |
| `active` with paid invoice | Paid access through the stored service deadline. |
| `past_due` | Keep access only through `service_until`, then optional grace. |
| `unpaid` | Do not extend access; expire at the local deadline. |
| `paused` | Do not extend access; apply the approved pause policy. |
| `canceled` | Terminal; expire when the stored paid-through deadline is reached. |

The local projection must be a pure function with table-driven tests.

---

## 6. Scheduled cancellation and service expiry

### 6.1 Paid-through service is mandatory

Customer Portal cancellation must default to period-end cancellation, not
immediate cancellation.

When Stripe sets `cancel_at_period_end=true`:

- record `cancel_at` and display “Paid until DATE”;
- stop future renewal, but keep the Paid entitlement;
- keep paid CPU, RAM, disk, and normal lifecycle controls;
- allow the customer to reverse cancellation before it takes effect; and
- do not enqueue resize, downgrade, stop, or destroy work.

That paid-through rule applies after money has been collected. During the free
trial, `cancel_at_period_end` or a terminal cancellation revokes Paid trial
access immediately and triggers Free fallback or paid-bypass suspension.

For the one-price v1 subscription, derive the service deadline from the single
subscription item's `current_period_end` under the pinned Stripe API version.

Do not advance `service_until` merely because a subscription update arrived.
Advance it after a paid invoice is validated against the expected customer,
subscription, and price.

```ts
if (event.type === "invoice.paid" && subscription.status === "active") {
  const subscription = await fetchCanonicalSubscription(event);
  assertSupportedSinglePrice(subscription);

  serviceUntil = max(
    stored.serviceUntil,
    subscription.items.data[0].current_period_end * 1000,
  );
}
```

At the deadline, Stripe normally emits `customer.subscription.deleted`.
The local reconciler must also enforce the timestamp in case that event is
late or missing.

### 6.2 Failed renewal is different from cancellation

A failed first charge after the free trial has no paid-through deadline, so it
ends trial access immediately. The renewal rules below apply after a positive
payment established `service_until`.

On `invoice.payment_failed`:

1. Record `past_due` and notify the user.
2. Keep service through the already paid `service_until` time.
3. Let Stripe apply the configured recovery policy.
4. If approved, apply a local grace period after `service_until`.
5. Never extend `service_until` for an unpaid invoice.

Do not hard-code a retry count or assume a fixed Stripe retry schedule. Smart
Retries and terminal status behavior are Stripe Dashboard configuration.

### 6.3 Behavior after paid access ends

If the account has permanent free eligibility:

- project the Free plan;
- apply free CPU, RAM, and swap limits without deleting data;
- mark oversized paid storage as grandfathered actual allocation; and
- show that a future rebuild may be required to return to standard free disk.

Incus/ZFS volumes cannot be safely shrunk in place. Automatic destructive
rebuild is forbidden.

If commercial policy rejects grandfathered storage, ship an explicit export
and rebuild flow before enabling downgrade. Do not silently delete data.

The current contract ties disk size to `tier`. Grandfathering therefore needs a
separate actual-storage field or a contract that permits legacy disk limits. Do
not emit an invalid Free `ContainerSpec` with paid disk values.

If the account used the paid bypass and lacks permanent free eligibility:

- stop the container after paid access and any approved grace end;
- mark the entitlement expired and the container billing-suspended;
- offer resubscribe, World ID/invite verification, and export help; and
- destroy only after the published export deadline and required notices.

A stopped container and a billing-suspended container need different
control-plane reasons even if both use the daemon's existing stop operation.

### 6.4 Immediate cancellation, refunds, and disputes

Immediate cancellation is an operator exception, not the default portal flow.
Its service deadline follows the approved refund or fraud policy.

A dispute webhook must alert an operator and record the dispute. It must not
silently destroy or suspend service unless the approved policy says to do so.

---

## 7. Mixed-tier shared-host refactor

This refactor is the implemented foundation for paid self-service. Billing is
not coupled to `budget` versus `regular` host pools.

### 7.1 Replace host class with tenancy mode

Current model:

```ts
type TenancyMode = "shared" | "dedicated";

const SERVICE_PLANS = {
  free: { tier: "free", tenancyMode: "shared" },
  paid: { tier: "paid", tenancyMode: "shared" },
  dedicated: { tier: "paid", tenancyMode: "dedicated" },
};
```

The expand-first migration sequence is:

1. Add `hosts.tenancy_mode` and `containers.placement_mode`.
2. Backfill `budget` and `regular` as `shared`.
3. Backfill `dedicated` as `dedicated`.
4. Roll out shared-daemon support while retaining legacy compatibility state.
5. Remove shared class checks and introduce canonical live availability.
6. Drop or rename legacy columns only in a later contract migration.

### 7.2 Per-container resource admission

A shared host must be evaluated against the requested container's actual
reservation, not a host-wide tier shape.

Admission requires all of:

```text
host is active and healthy
host tenancy_mode is shared
allocated CPU + requested CPU <= allocatable CPU budget
allocated RAM + requested RAM <= allocatable RAM budget
allocated disk + requested disk <= allocatable disk budget
tenant count + 1 <= max_tenants
an SSH port is available
```

The same predicates must appear in host selection and the transactional write.
The D1 write remains authoritative against races.

Replace tier-rounded host ceilings with additive resource budgets. Keep
`max_tenants` as a separate isolation and operational safety limit.

Placement prefers the viable host with the greatest normalized
post-placement availability while avoiding a single-resource hotspot. The
score is deterministic and tested with mixed Free and Paid requests.

### 7.3 Daemon and contract changes

Daemon validation now ensures:

- a shared daemon accepts both `free` and `paid` specs;
- a dedicated daemon accepts only its assigned account and paid spec;
- the Worker still validates plan and account binding; and
- daemon stats report tenancy mode.

The daemon does not receive Stripe IDs or billing state. It receives only the
container operation and desired resource spec.

### 7.4 Waitlist behavior

Free and paid no longer have independent shared pools. Use one FIFO queue with
an explicit scheduling policy.

Strict FIFO can cause head-of-line blocking when the oldest paid request does
not fit but later free requests do. Use bounded backfill:

1. Try the oldest request first.
2. If it cannot fit, inspect a bounded number of later requests.
3. Admit a smaller request only if the oldest keeps its timestamp and priority.
4. Record skips and cap them to prevent starvation.
5. Keep dedicated accounts in account-bound pools.

The policy and fairness bound must be visible in tests and operations docs.

### 7.5 Capacity and rollout risk

Mixed placement improves average density but increases fragmentation risk.
Track free and paid reservations separately and aggregate by host.

Before enabling paid Checkout, prove that the fleet has room for both new paid
containers and in-place upgrades. Checkout may be disabled when paid headroom
falls below an operator-defined reserve.

---

## 8. Upgrading an existing free container

### 8.1 Required invariant

A canonical trial or successful payment grants a Paid entitlement immediately,
but applying the larger container shape is asynchronous.

The old container must remain usable at its existing free shape until the
upgrade succeeds. Never destroy it merely because its current host lacks the
resource delta.

### 8.2 Desired and actual state

Add desired-plan fields or a plan-transition table. Do not overwrite actual
resource fields before the transition has durably claimed capacity.

Suggested transition states:

```text
requested -> reserving -> resizing -> complete
                         -> waiting_capacity
                         -> failed_retryable
```

Store the prior lifecycle state so a stopped container remains stopped after
resize.

### 8.3 In-place upgrade algorithm

```ts
async function requestPaidUpgrade(userId) {
  const entitlement = await effectiveEntitlementFor(userId);
  assert(entitlement.plan === "paid");

  const container = await getContainer(userId);
  if (!container) return; // onboarding will use paid desired state
  if (container.tier === "paid") return; // idempotent

  const delta = resources("paid") - actualReservation(container);

  const claimed = await reserveDeltaAndCreateTransition({
    container,
    delta,
    desiredTier: "paid",
    expectedActualTier: "free",
  });

  await enqueueIdempotentResize(container.id, "paid");
}
```

The D1 transaction must:

- confirm the entitlement is still Paid;
- confirm no lifecycle job or plan transition is active;
- recheck host health and shared tenancy;
- reserve only the CPU, RAM, and disk delta;
- create one transition keyed by container and desired tier; and
- set `upgrade_pending` without losing the prior state.

On success, commit the actual tier and resource fields, clear the transition,
and restore `running` or `stopped` as appropriate.

On retryable failure, keep the delta reserved if the daemon might have applied
part of the resize. Reconciliation should resend the idempotent desired spec.
An operator-only repair path handles irreconcilable partial changes.

### 8.4 When the upgrade exceeds the host target

Reserve the delta and resize in place. Availability may become negative; this
is operational pressure, not a failed upgrade. Keep the host active but exclude
it from new placement until downgrades or destroys restore enough headroom.

Do not use the current destructive rehome flow. Cross-host upgrade requires a
separate snapshot/copy/verify/cutover design with rollback. Until that exists,
in-place upgrade or operator-assisted migration are the only safe paths.

### 8.5 Upgrade concurrency cases

The implementation must define:

- cancellation while upgrade is waiting;
- refund while resize is active;
- container stop, rebuild, or destroy during a transition;
- duplicate paid webhooks;
- host drain or failure during resize; and
- a renewal or expiry event during recovery.

User lifecycle controls that conflict with a transition return `409` with a
clear retry message. Destroy remains available through an explicit transition
cancellation path.

---

## 9. Stripe integration

### 9.1 Catalog and API version

Create one v1 Paid product with one recurring monthly Price. Store its Price ID
as non-secret Worker configuration.

Pin the Stripe API version in code and on the webhook destination. Upgrade it
in the live account's Stripe Workbench settings as well. Upgrade only with
fixture regeneration and contract tests because queued processing retrieves
the immutable Event snapshot by ID.

The integration currently pins `2026-07-29.dahlia`. Stripe Billing and Dahlia
are not competing products: Billing manages subscriptions, while Dahlia names
the versioned API schema. Current API versions place billing period fields on
subscription items, not at the top level of a Subscription. New subscriptions
explicitly use Stripe's recommended flexible billing mode.

### 9.2 Configuration

| Binding or setting | Storage |
|---|---|
| `STRIPE_SECRET_KEY` | Worker secret |
| `STRIPE_WEBHOOK_SECRET` | Worker secret |
| `STRIPE_PRICE_PAID_MONTHLY` | Non-secret Worker var |
| `STRIPE_LIVE_MODE` | `1` in production; `0` only in a Stripe sandbox |
| `STRIPE_TAX_ENABLED` | Non-secret var enabled only after tax readiness |
| `BILLING_EVENTS` | Cloudflare Queue producer and consumer |
| `BASE_URL` | Existing non-secret Worker var |

Use a restricted Stripe key if its permissions support every required Billing
operation. Do not assume Cloudflare egress has stable IPs for a Stripe key IP
allowlist.

### 9.3 Create Checkout

`POST /api/billing/checkout` uses `requireAccount`, not `requireUser`, so an
unverified account can choose the paid path.

The endpoint must:

1. Load or create exactly one Stripe Customer for the internal user.
2. Use `customer:${user.id}` as the stable Customer idempotency key.
3. Persist the Customer mapping before creating Checkout.
4. Reject or redirect if a non-terminal subscription already exists.
5. Select the Price from a server-side allowlist.
6. Claim one unexpired local Checkout attempt and use its ID as the stable
   Session idempotency key across retries.
7. Include the seven-day trial only when the Customer has no prior trial.
8. Create a hosted subscription Checkout Session and persist its correlation.
9. Return the Stripe URL.

```ts
const customer = await findOrCreateStripeCustomer(user);

const session = await stripe.checkout.sessions.create(
  {
    mode: "subscription",
    customer: customer.stripeCustomerId,
    payment_method_collection: "always",
    client_reference_id: user.id,
    line_items: [{ price: env.STRIPE_PRICE_PAID_MONTHLY, quantity: 1 }],
    subscription_data: {
      metadata: { userId: user.id, plan: "paid" },
      billing_mode: {
        type: "flexible",
        flexible: { proration_discounts: "itemized" },
      },
      trial_period_days: 7,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    },
    automatic_tax: { enabled: env.STRIPE_TAX_ENABLED === "1" },
    success_url: `${env.BASE_URL}/account?checkout=success`,
    cancel_url: `${env.BASE_URL}/account?checkout=cancelled`,
  },
  { idempotencyKey: checkoutAttempt.id },
);
```

The server validates Customer, subscription metadata, and Price. Metadata is a
correlation aid, not authorization by itself.

Restrict v1 payment methods to those whose activation behavior is supported.
If delayed methods are enabled, wait for settlement before granting service.

The success redirect is never an entitlement signal. It may poll a local
billing-status endpoint until webhook processing completes.

### 9.4 Customer Portal

`POST /api/billing/portal` requires an authenticated owner and creates a
short-lived Portal Session for the stored Stripe Customer.

Configure the Portal to:

- update payment methods;
- view invoices;
- cancel at the end of the current period; and
- reverse a scheduled cancellation when Stripe supports the action.

Do not enable arbitrary product switching until every Price maps to a supported
plan and transition policy.

In Stripe's subscription email settings, enable trial-ending reminders,
failed-payment emails, and the Stripe-hosted customer-management link. Set the
cancellation-policy URL for each environment. Those operator settings supply
the card-network trial messaging that application notifications alone do not.

### 9.5 Webhook ingress

`POST /api/stripe/webhook` is public HTTPS and exempt from session and CSRF
middleware. Stripe signature verification is its authentication.

```ts
const rawBody = await c.req.text();
const signature = c.req.header("stripe-signature");

const event = await verifyStripeEventAsync(
  rawBody,
  signature,
  c.env.STRIPE_WEBHOOK_SECRET,
);

await c.env.BILLING_EVENTS.send({
  eventId: event.id,
  eventType: event.type,
  eventCreated: event.created,
});
return c.body(null, 204);
```

Use the Stripe SDK's async verification path when supported by the pinned
version, or a tested Web Crypto verifier. Verification must use the exact raw
body and a timestamp tolerance.

At the Cloudflare edge, restrict the webhook route to Stripe's published
webhook-delivery IP ranges and keep that rule current. IP filtering supplements
signature verification; it never replaces it.

Return `2xx` only after durable Queue publication. If verification or Queue
publication fails, return an error so Stripe retries.

### 9.6 Queue consumer and idempotency

Queues are at-least-once. The consumer must safely process duplicates and must
not assume event order.

For each event:

1. Insert or claim its event ID in `stripe_billing_events`.
2. If already processed, acknowledge it.
3. Retrieve the Event by ID, then fetch canonical objects when state may be stale.
4. Validate Customer, user, Price, and one-subscription invariants.
5. Apply billing facts and entitlement projection in one D1 batch.
6. Create any plan-transition intent idempotently.
7. Mark the event processed.
8. Retry transient failures; dead-letter or alert permanent failures.

Do not mark an event processed before all required D1 effects commit.

Use both event ID deduplication and monotonic state. An older event must never
shorten a later paid-through deadline or reverse a newer subscription state.

### 9.7 Events to subscribe to

| Event | Purpose |
|---|---|
| `checkout.session.completed` | Correlate Checkout; do not grant access without valid billing state. |
| `checkout.session.expired` | Expire the correlated local attempt so a new Checkout can start. |
| `customer.subscription.created` | Sync canonical subscription and Price. |
| `customer.subscription.updated` | Sync status, cancellation, Price, and period changes. |
| `customer.subscription.deleted` | Revoke an unpaid trial immediately; otherwise enforce the stored paid-through deadline. |
| `customer.subscription.paused` | Record a true paused subscription. |
| `customer.subscription.resumed` | Resync after a true paused subscription resumes. |
| `customer.subscription.trial_will_end` | Warn the owner three days before Stripe attempts the first charge. |
| `invoice.paid` | Advance `service_until` only with canonical `active` subscription state; the zero-value trial-opening invoice does not, while a settled renewal covered by credits can. |
| `invoice.payment_failed` | End unpaid trial access or mark a renewal past due; never extend service. |
| `invoice.payment_action_required` | Direct the customer to resolve authentication. |
| `invoice.finalization_failed` | Alert and request missing tax/location data when applicable. |
| `charge.refunded` | Correlate the Charge through Invoice and Subscription, notify the owner, and alert an operator without inventing an access policy. |
| `charge.dispute.created` | Alert and apply the approved fraud policy. |

Pause-payment collection is not the same as a subscription status of `paused`.
Do not model those as one event.

### 9.8 Reconciliation

Extend scheduled reconciliation with bounded billing work, or use a dedicated
scheduled handler.

It must:

- refresh stale non-terminal Stripe subscriptions;
- repair events missed during webhook outages;
- enforce `trial_end`, `service_until`, `grace_until`, and export deadlines;
- retry pending upgrades when capacity changes;
- detect multiple active subscriptions for one user;
- compare local Price IDs with the allowlist; and
- alert on drift instead of guessing.

Do not call Stripe for every user every five minutes. Use stale timestamps,
pagination, bounded batches, and backoff.

---

## 10. D1 model and migration outline

The next migration number must be chosen from the repository state at
implementation time. Do not hard-code `0017` in planning.

Suggested additive tables:

```sql
CREATE TABLE account_entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  plan TEXT CHECK (plan IN ('paid', 'dedicated')),
  source TEXT CHECK (source IN ('stripe', 'manual')),
  state TEXT NOT NULL,
  trial_until INTEGER,
  service_until INTEGER,
  grace_until INTEGER,
  source_ref TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE stripe_customers (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE stripe_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stripe_customer_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('paid')),
  stripe_status TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancel_at INTEGER,
  trial_start INTEGER,
  trial_end INTEGER,
  service_until INTEGER,
  grace_until INTEGER,
  ended_at INTEGER,
  last_paid_invoice_id TEXT,
  last_event_created INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_stripe_subscriptions_user
  ON stripe_subscriptions(user_id);

CREATE TABLE stripe_checkout_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  stripe_checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE stripe_billing_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  object_id TEXT,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  last_error_code TEXT
);

CREATE TABLE container_plan_transitions (
  container_id TEXT PRIMARY KEY REFERENCES containers(id),
  from_tier TEXT NOT NULL,
  to_tier TEXT NOT NULL,
  prior_status TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error_code TEXT
);
```

Also add the mixed-host columns from §7.1. Add check constraints and indexes in
the final migration after confirming D1's deployed schema and query plans.

Subscription history permits multiple terminal rows per user. Application logic
must enforce at most one current non-terminal subscription and alert if Stripe
disagrees.

Do not store card data, payment-method details, invoice PDFs, or unrestricted
webhook payloads in D1 or Queue messages. Keep only the facts and object IDs
needed for authorization, support, reconciliation, and audit.

Manual operator entitlements need an explicit source and optional expiry. They
must not be fabricated as Stripe subscriptions or overwritten by Stripe sync.

---

## 11. UI and support requirements

### 11.1 Account and dashboard

Show:

- current effective plan;
- actual container tier and pending desired tier;
- price and currency from server configuration;
- next renewal date or “Paid until” date;
- past-due, grace, and expired notices;
- Upgrade, Manage billing, and Undo cancellation actions; and
- upgrade capacity progress without promising an unsafe completion time.

Never show “Paid” based only on a Checkout redirect query parameter.

### 11.2 Required notifications

Send transactional notices for:

- trial start, end date, and cancellation;
- payment confirmation;
- scheduled cancellation and paid-through date;
- upcoming service expiry;
- payment failure and required action;
- grace start and end;
- billing suspension;
- export deadline; and
- impending destruction.

Stripe-hosted emails can cover invoices and payment recovery at launch.
Application-specific suspension and export notices still need a delivery path.

Cloudflare Email Sending is a possible Worker binding, but it is currently beta
and requires a Workers Paid plan. Confirm availability and onboard the sending
domain before making it a launch dependency.

Every critical notice must also appear in the authenticated UI. Email delivery
alone is not proof that the user was informed.

### 11.3 Support visibility

Operators need a view containing:

- internal user ID and non-secret Stripe object IDs;
- effective plan and entitlement source;
- Stripe status, Price, service deadline, and cancel deadline;
- latest billing event and sync time;
- container actual and desired tier;
- transition state and safe retry action; and
- alerts for duplicate subscriptions or unsupported Prices.

Logs must not contain customer email, addresses, card data, webhook bodies, or
secret values.

---

## 12. Security, tax, and compliance

1. Use Stripe-hosted Checkout and Portal. Card data must never enter the Worker,
   D1, logs, or support tools.
2. Bind Checkout to the authenticated internal user and stored Customer.
3. Verify webhook signatures over the exact raw body.
4. Keep secret keys in Worker secrets and rotate webhook secrets safely.
5. Use idempotency keys for Stripe mutations and event IDs for webhook dedupe.
6. Treat all client plan, Price, Customer, and subscription IDs as untrusted.
7. Rate-limit Checkout creation and prevent concurrent attempts.
8. Enable Stripe Tax only after registrations and product tax codes are set.
9. Define retention and deletion rules with legal review before deleting Stripe
   Customers or billing records.
10. Account deletion must handle active subscriptions and statutory billing
    retention; it cannot simply erase all billing evidence.

Paid bypass and free trials raise abuse risks because a card is not proof of
unique humanity. Mitigate with payment risk controls, account limits, velocity
checks, and no free fallback unless permanent free eligibility was completed.

---

## 13. Delivery sequence

### Phase A — Mixed-host foundation

1. Add tenancy-mode and placement-mode columns.
2. Refactor capacity accounting for mixed resource requests.
3. Update daemon validation and tenancy-mode stats.
4. Deploy daemon support fleet-wide.
5. Dual-read and dual-write from the Worker.
6. Prove mixed free/paid placement, waitlist fairness, and rollback.

### Phase B — Entitlement foundation

1. Add billing and plan-transition tables.
2. Extract pure entitlement projection.
3. Add paid-bypass authorization middleware.
4. Separate permanent free verification from paid eligibility.
5. Add time-based expiry and manual entitlement source.

### Phase C — Stripe sandbox

1. Create the Paid Product and Price in a Stripe sandbox.
2. Pin the API and webhook versions.
3. Add Checkout, Portal, webhook, Queue, and consumer paths.
4. Configure the fixed seven-day trial and period-end Portal cancellation.
5. Test trial cancellation, first-charge failure, tax, and supported payment methods.

### Phase D — Existing-container upgrades

1. Add delta reservation and transition state.
2. Make resize preserve prior running or stopped state.
3. Retry in-place upgrades without destructive rehome.
4. Add downgrade and grandfathered-storage behavior.
5. Add operator recovery tooling.

### Phase E — Lifecycle, support, and launch

1. Add billing UI and notifications.
2. Add support visibility and alerts.
3. Exercise failed renewal, cancellation, expiry, and resubscription.
4. Update `SPEC.md`, `README.md`, and `infra/RUNBOOK.md`.
5. Launch behind an operator-controlled feature flag and capacity gate.

---

## 14. Test and acceptance strategy

### 14.1 Entitlement and eligibility

- Every Stripe status and deadline combination is table-tested.
- Paid users can bypass World ID/invite only while paid access is valid.
- Trial access ends at `trial_end`, on cancellation, or on first-charge failure.
- Paid-bypass users do not become free-eligible after expiry.
- Verified users fall back to Free after paid expiry.
- Manual entitlements are not overwritten by Stripe reconciliation.

### 14.2 Checkout and Portal

- Checkout requires authentication but not free verification.
- Customer creation is idempotent under concurrent requests.
- An existing active subscription redirects to Portal.
- Client-supplied Price and Customer IDs are ignored or rejected.
- Checkout success without a webhook grants no access.
- The first subscription creates a seven-day trial and Checkout collects a
  payment method for the first post-trial charge; later subscriptions do not
  repeat the trial.
- Portal cancellation is configured for period end.

### 14.3 Webhooks

- Valid raw-body signatures pass; tampered, stale, or wrong-secret payloads fail.
- Queue failure returns non-2xx so Stripe retries.
- Duplicate events are no-ops after the first successful commit.
- Out-of-order events cannot regress service deadlines or state.
- Unsupported Prices and duplicate subscriptions alert and fail closed.
- Dead-letter replay is safe.

### 14.4 Paid-through service

- Scheduling cancellation changes the label, not resources or controls.
- Service remains Paid immediately before `service_until`.
- Expiry occurs at or after the deadline without requiring a deletion webhook.
- Undoing cancellation before expiry retains uninterrupted service.
- Payment failure never extends `service_until`.
- A zero-value trial invoice never establishes `service_until`.

### 14.5 Mixed placement

- One shared host can admit free and paid containers concurrently.
- CPU, RAM, disk, tenant, health, and port checks are transactional.
- Selection remains deterministic under fragmented capacity.
- Bounded backfill cannot starve the oldest request.
- Dedicated account isolation remains unchanged.
- Old and new daemon versions fail safely during rollout.

### 14.6 Existing container upgrade

- Free-to-paid resize reserves only the delta.
- Running containers return to running; stopped containers remain stopped.
- No-capacity upgrades preserve the usable free container.
- Duplicate upgrade events create one transition and one active resize.
- Partial daemon failure converges by idempotent retry.
- No automated paid upgrade invokes destructive rehome.
- Cancellation during a pending upgrade follows a deterministic policy.

### 14.7 Release gates

Run focused Worker, daemon, and contract tests, then:

```text
npm run build:client -w apps/worker
npm run typecheck
npm run lint
npm test
npm run deploy:dry-run
```

Sandbox acceptance must cover signup, paid bypass, verified-user upgrade,
in-place resize, trial activation, zero-value opening invoice, trial
cancellation, first-charge failure, renewal failure, paid-period cancellation,
undo, expiry, free fallback, suspension, and resubscription.

---

## 15. Operational metrics and alerts

Track:

- Checkout attempts, completions, and abandoned attempts;
- trialing, active, scheduled-cancel, past-due, grace, and expired subscriptions;
- webhook verification failures, Queue lag, retries, and dead letters;
- billing reconciliation age and drift repairs;
- pending upgrade age and reason;
- free and paid reservations per shared host;
- capacity fragmentation and paid headroom; and
- suspension and destruction deadlines.

Alert on unsupported Prices, multiple live subscriptions per user, negative or
inconsistent host accounting, stale billing sync, dead letters, and upgrades
blocked beyond the support target.

---

## 16. Repository readiness completed

The merge candidate now resolves the application-side launch blockers that do
not require production credentials or commercial decisions:

- [x] single-flight Checkout attempts with stable Session idempotency keys and
  Stripe-driven expiry cleanup;
- [x] a canonical Stripe Customer-subscription preflight that blocks duplicates
  and repeat trials even when a prior webhook has not reached D1;
- [x] first-subscription-only trials, including migration of historical trial
  use to Customer-level state;
- [x] fail-closed validation of the active Stripe Product and recurring Price
  against the server-rendered amount and currency before Checkout;
- [x] explicit live/sandbox separation for API keys, Prices, and webhook Events;
- [x] a redacted readiness probe that validates the Price while the new-sales
  gate remains closed;
- [x] one configured price disclosure across landing, account, and dashboard;
- [x] automatic-tax Checkout address collection and Customer address updates;
- [x] strict Customer, required metadata, Price, quantity, trial, and API-version
  validation in the event consumer;
- [x] correlated refund/dispute owner notices and operator alerts without an
  unapproved entitlement mutation;
- [x] event support for `checkout.session.expired` and `charge.refunded`;
- [x] `BILLING_CHECKOUT_SESSION_MINUTES` runtime support and migration `0022`;
  and
- [x] focused regression coverage for these paths.

## 17. Ordered production launch checklist

These items intentionally remain developer/operator-owned because they mutate
Stripe, Cloudflare, production data, or commercial policy. Keep
`BILLING_ENABLED=0` until item 12.

### P0 — required before enabling production sales

- [ ] **1. Approve the offer and policies.** Record the exact monthly amount and
  currency, countries served, supported payment methods, tax treatment,
  failed-renewal grace, refunds/disputes, cancellation, export/retention, and
  account-deletion support workflow. Publish effective Terms, Privacy, refund,
  and cancellation URLs; do not invent these values in code.
- [ ] **2. Finish Stripe account live-mode activation.** Verify the legal
  business, bank/payout, public business details, support contact, statement
  descriptor, branding, and required tax registrations in Stripe.
- [ ] **3. Create and approve the live Product and Price.** Use one active,
  per-unit, licensed, monthly recurring Price with quantity one. Its amount and
  currency must exactly match `PAID_PLAN_MONTHLY_PRICE` and
  `PAID_PLAN_CURRENCY`. If Tax is enabled, set explicit Price tax behavior and
  a Product tax code.
- [ ] **4. Create least-privilege live API credentials.** The Worker needs the
  Stripe operations used by this code: Customers create/read, Checkout Sessions
  create, Billing Portal Sessions create, and Events, Prices, Subscriptions,
  Products, Invoices, and Charges read. Store the live key only as
  `STRIPE_SECRET_KEY`; never copy sandbox keys into production.
- [ ] **5. Create the production Queue and DLQ.** Bind `BILLING_EVENTS` as both
  producer and consumer using the retry/DLQ shape in `README.md`. Confirm the
  on-call team can inspect Queue lag, retries, and dead letters.
- [ ] **6. Create the live webhook event destination.** Point it to
  `https://usebench.dev/api/stripe/webhook`, upgrade the live account and pin
  the destination to API version `2026-07-29.dahlia`, and subscribe to every
  event in §9.7. Store its live signing secret as `STRIPE_WEBHOOK_SECRET`.
- [ ] **7. Configure the live Customer Portal.** Enable payment-method and
  invoice management plus cancellation at period end. Disable arbitrary plan
  switching and quantity changes. Keep the Portal login link enabled and turn
  on Checkout's redirect for Customers that already have an active
  subscription. Verify scheduled cancellation can be reversed.
- [ ] **8. Configure live subscription recovery and notices.** Enable the
  approved trial-ending and failed-payment emails, customer-management link,
  cancellation-policy URL, and Smart Retry/dunning behavior. Confirm the
  seven-day trial wording and first-charge date are visible in Checkout and
  receipts.
- [ ] **9. Configure tax deliberately.** Keep `STRIPE_TAX_ENABLED=0` unless the
  approved registrations, nexus/market scope, Product tax code, Price tax
  behavior, and address collection have been reviewed. Test the result for each
  supported jurisdiction before setting it to `1`.
- [ ] **10. Install production vars and secrets with the sales gate closed.**
  Configure `STRIPE_LIVE_MODE=1`, `STRIPE_PRICE_PAID_MONTHLY`, display
  amount/currency, Checkout lifetime, grace/export policy, Queue binding, and
  live secrets. Explicitly keep `BILLING_ENABLED=0` for the migration and
  initial Worker deployment.
- [ ] **11. Record sandbox acceptance evidence.** Exercise the full matrix in
  §14.7, including double-click/concurrent Checkout, abandoned Session expiry,
  first-trial-only resubscription, tax address behavior, zero-value renewal,
  refund/dispute correlation, Queue retry/DLQ replay, and rollback.
- [ ] **12. Merge and deploy the gated release.** Require a clean worktree and
  passing client build, type-check, lint, full tests, dependency audit, deploy
  dry-run, remote migration review, migration through `0023`, and post-deploy
  smoke checks. Confirm existing subscribers can still reach Portal/webhooks
  even while new sales are disabled.

### P1 — required to open live sales

- [ ] **13. Establish monitoring and paging.** Alert on webhook delivery
  failures, verification failures, Queue age/retries/DLQ, failed billing events,
  unsupported Price, duplicate live subscription, stale canonical sync,
  transition age, and paid capacity headroom. Verify the alerts reach the
  production on-call owner.
- [ ] **14. Run a controlled live canary.** Confirm `/api/billing/status` first,
  then run `npm run hostctl -- billing-config` with the gate closed and require
  a ready, live, valid Price report. Set `BILLING_ENABLED=1` only for a limited
  production canary. Use a real
  payment method and live Product/Price, verify Customer/Subscription/Invoice,
  webhook-to-Queue processing, Portal access, in-app notices, entitlement, and
  container resize. Refund/cancel the canary according to the approved policy.
- [ ] **15. Make the go/no-go decision.** Review canary evidence, Stripe event
  delivery, Queue/DLQ, capacity, logs for PII/secrets, support readiness, and
  rollback ownership before broad availability.

### P2 — immediate post-launch controls

- [ ] **16. Observe the first renewal and first trial conversion.** Reconcile
  Stripe and D1 deadlines manually and verify that a settled active renewal,
  including a legitimate zero-value credited renewal, advances service while a
  trial-opening invoice does not.
- [ ] **17. Exercise the kill switch.** Confirm setting `BILLING_ENABLED=0`
  stops new Checkout without disabling Portal, webhooks, Queue consumption, or
  reconciliation for existing subscribers.
- [ ] **18. Schedule key/webhook rotation and evidence review.** Document
  owners, cadence, overlapping webhook-secret rotation steps, DLQ replay
  authority, retention, and the date for the first post-launch audit.

## 18. Source references

- [Stripe go-live checklist](https://docs.stripe.com/get-started/checklist/go-live)
- [Stripe API key security](https://docs.stripe.com/keys)
- [Stripe Checkout subscriptions](https://docs.stripe.com/payments/checkout/build-subscriptions)
- [Limit a Customer to one subscription](https://docs.stripe.com/payments/checkout/limit-subscriptions)
- [Stripe Tax with Checkout](https://docs.stripe.com/tax/checkout)
- [Stripe trial and promotion requirements](https://docs.stripe.com/billing/subscriptions/trials)
- [Stripe subscription webhooks and statuses](https://docs.stripe.com/billing/subscriptions/webhooks)
- [Stripe cancellation and period-end service](https://docs.stripe.com/billing/subscriptions/cancel)
- [Stripe webhook security and delivery](https://docs.stripe.com/webhooks)
- [Stripe item-level billing periods](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
- [Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
