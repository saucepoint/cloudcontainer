# Production Stripe deployment

This runbook takes usebench.dev from a gated billing deployment to production
Stripe sales. Follow the steps in order. Do not set `BILLING_ENABLED=1` until
every preflight and canary prerequisite below passes.

The integration uses Stripe-hosted Checkout and Customer Portal, a Cloudflare
Worker webhook, a Cloudflare Queue, and D1 billing state. No Stripe publishable
key is required by this application.

## 1. Required access and approvals

The developer performing this release needs:

- Node.js 22 and the repository dependencies installed with `npm ci`;
- Wrangler access to the production Worker, D1 database, Queues, and Worker
  secrets;
- Stripe Dashboard access to live-mode Products, API keys, Workbench, event
  destinations, Billing settings, Customer Portal, and account settings;
- the production `FLEET_ADMIN_SECRET`, supplied interactively or through the
  developer's local environment, for `hostctl` read-only checks;
- SSH/fleet release access for the coordinated daemon rollout; and
- an identified production on-call owner who can inspect Stripe deliveries,
  Worker errors, Queue retries/DLQ, and fleet capacity during the canary.

Do not put Stripe keys, webhook signing secrets, `FLEET_ADMIN_SECRET`, or any
other credential in this file, Git, shell history, chat, tickets, or command
arguments.

Before configuration begins, obtain explicit approval for all of these values:

```text
Monthly amount:                 ____________________
Currency (uppercase ISO code): ____________________
Countries sold into:           ____________________
Payment methods:               ____________________
Stripe Tax enabled:            0 / 1
Failed-renewal grace days:     ____________________
Checkout lifetime minutes:     60 (or 31-1440)
Automatic export/destruction:  disabled / _____ days
Refund/dispute policy owner:   ____________________
Cancellation policy URL:       ____________________
Privacy policy URL:            ____________________
Terms URL:                     https://usebench.dev/terms
Production on-call owner:      ____________________
```

The current sandbox offer is USD 6/month with a seven-day trial. That is not
automatically the production offer. The production amount and currency must be
approved and must exactly match the live Stripe Price.

Stop if Privacy, refund, cancellation, retention, tax, or support policy is
unresolved. Do not invent policy values in application configuration.

## 2. Confirm the checkout contract

The production Stripe configuration must match these application invariants:

- one active Product and one active recurring monthly Price;
- `billing_scheme=per_unit`, `usage_type=licensed`, interval `month`, interval
  count `1`, and Checkout quantity `1`;
- a fixed seven-day trial only for the account's first self-service
  subscription;
- payment method collection during Checkout;
- flexible subscription billing mode with itemized proration discounts;
- cancellation and payment-method management through Stripe Customer Portal;
- automatic tax disabled unless the tax launch checklist is complete; and
- API version `2026-07-29.dahlia` on API requests, the live account, and the
  webhook event destination.

The Worker validates the live Price before creating every Checkout Session.
An amount, currency, mode, interval, quantity model, Product status, or tax
metadata mismatch fails closed.

## 3. Activate and configure the live Stripe account

In the Stripe Dashboard, switch out of sandbox/test mode and complete live-mode
activation:

1. Verify the legal business and representative details.
2. Configure the bank account and payouts.
3. Review the public business name, business URL, support email/phone/address,
   and statement descriptor.
4. Configure production branding used by Checkout, Portal, receipts, and
   Stripe-hosted recovery pages.
5. Add the approved Terms, Privacy, refund, and cancellation policy URLs.
6. Confirm the countries and payment methods that the business will support.
7. Complete tax registrations and nexus review before enabling Stripe Tax.

Do not continue if Stripe shows that live charges or payouts are restricted.

## 4. Set the live API version

Open Stripe Workbench in live mode and upgrade the account API version to:

```text
2026-07-29.dahlia
```

Review the Dashboard's upgrade diff before confirming. The Worker sends the
same `Stripe-Version` header on every API request and rejects retrieved Events
whose immutable `api_version` differs.

Changing only the event destination version is insufficient. Stripe Event
snapshots are created using the account API version and are not reshaped when
retrieved later.

## 5. Create the live Product and Price

In live mode:

1. Create the Paid/Premium Product and keep it active.
2. Create one recurring Price with the approved monthly amount and currency.
3. Set recurring interval to monthly and use a per-unit, licensed quantity
   model.
4. Do not add tiers, usage-based pricing, multiple quantities, or alternate
   plans for this v1 integration.
5. If `STRIPE_TAX_ENABLED=1`, assign the correct Product tax code and set the
   Price tax behavior explicitly to `exclusive` or `inclusive`.
6. Copy the live `price_...` ID. Do not reuse the sandbox Price ID.

Record only these non-secret values for the repository change:

```text
STRIPE_PRICE_PAID_MONTHLY=price_...
PAID_PLAN_MONTHLY_PRICE=<exact decimal amount>
PAID_PLAN_CURRENCY=<uppercase ISO code>
```

## 6. Create a restricted live API key

Create a dedicated live restricted API key, preferably named
`usebench-production-worker`. Grant only the operations used by the Worker:

| Stripe resource | Permission needed |
| --- | --- |
| Customers | Write, including create and retrieve |
| Checkout Sessions | Write/create |
| Billing Portal Sessions | Write/create |
| Events | Read |
| Prices | Read |
| Products | Read |
| Subscriptions | Read/list |
| Invoices | Read |
| Charges | Read |

The resulting credential must begin with `rk_live_`. An unrestricted
`sk_live_` key is supported but is not preferred. Organization-level
`sk_org_` keys are not accepted because this integration is account-scoped.

Save the credential directly into an approved secret manager. Stripe might
show it only once. Do not temporarily save it in the repository or a `.dev.vars`
file.

## 7. Configure the live Customer Portal and Billing recovery

Stripe keeps sandbox and live Portal configurations separate. Configure the
live Portal with:

- payment-method management enabled;
- invoice history enabled;
- subscription cancellation enabled at the end of the current period;
- cancellation reversal/retention enabled where Stripe offers it;
- arbitrary product switching disabled;
- arbitrary Price switching disabled;
- quantity changes disabled;
- the Portal login link enabled;
- return/public policy URLs set to production URLs.

Separately, enable Checkout's redirect for Customers who already have an
active subscription.

Preview the configuration and verify that a scheduled cancellation can be
reversed. The application supports both classic `cancel_at_period_end` and
flexible-billing `cancel_at` state.

Under live Billing subscription/recovery settings:

1. Enable failed-payment emails with a payment-method update link.
2. Enable payment-confirmation and payment-action-required/3DS notices.
3. Enable the trial-ending reminder and confirm the seven-day trial disclosure.
4. Enable the Stripe-hosted manage-subscription link.
5. Configure Smart Retries/dunning to the approved recovery policy.
6. Configure the approved cancellation-policy URL.
7. Confirm receipt and invoice branding/support details.

The application never assumes a specific Stripe retry schedule; access is
derived from canonical subscription and paid-through state.

## 8. Create the live webhook event destination

Create an account-level HTTPS webhook/event destination in live mode. Use v1
snapshot Events, not an organization destination or a thin-events destination.

```text
Endpoint URL: https://usebench.dev/api/stripe/webhook
API version:  2026-07-29.dahlia
Mode:         live
```

Subscribe only to these events:

```text
checkout.session.completed
checkout.session.expired
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
customer.subscription.trial_will_end
invoice.paid
invoice.payment_failed
invoice.payment_action_required
invoice.finalization_failed
charge.refunded
charge.dispute.created
```

Reveal the signing secret for this exact live endpoint and save it in the
approved secret manager. It is separate from the API key and normally begins
with `whsec_`. Never use the Stripe CLI listener secret or a sandbox endpoint
secret in production.

At the Cloudflare edge, restrict this path to Stripe's currently published
webhook source IP ranges while retaining Worker HMAC verification:

```text
/api/stripe/webhook
```

Do not hard-code an old IP list from this document; use Stripe's current
published list and assign an owner to maintain the rule.

## 9. Configure non-secret Worker variables

Edit the production `vars` block in `apps/worker/wrangler.jsonc`. Keep these
values in checked-in configuration so a later Wrangler deployment does not
silently replace Dashboard-only values.

Use this shape with the approved values:

```jsonc
"BILLING_ENABLED": "0",
"STRIPE_LIVE_MODE": "1",
"STRIPE_PRICE_PAID_MONTHLY": "price_LIVE_VALUE",
"PAID_PLAN_MONTHLY_PRICE": "APPROVED_DECIMAL",
"PAID_PLAN_CURRENCY": "APPROVED_ISO_CURRENCY",
"STRIPE_TAX_ENABLED": "0",
"BILLING_GRACE_DAYS": "0",
"BILLING_CHECKOUT_SESSION_MINUTES": "60"
```

Policy notes:

- Keep `STRIPE_TAX_ENABLED=0` until registrations, Product tax code, Price tax
  behavior, address collection, and jurisdiction tests are approved.
- Omitting `BILLING_GRACE_DAYS` is equivalent to zero, but an explicit approved
  value is clearer for production.
- `BILLING_CHECKOUT_SESSION_MINUTES` must be an integer from 31 through 1440;
  omission defaults to 60.
- Omit `BILLING_EXPORT_WINDOW_DAYS` to disable automatic billing-related
  destruction. Set it only after destructive retention/export policy approval.
- Keep `BILLING_ENABLED=0` through migration, daemon rollout, and the
  gate-closed readiness probe.
- `BASE_URL=https://usebench.dev`, `STRIPE_LIVE_MODE=1`, and the production
  Queue bindings are already declared.

Do not add production values to the staging block.

## 10. Verify the Cloudflare Queues

The following production Queues were created on 2026-08-12 and their bindings
are declared in `apps/worker/wrangler.jsonc`:

```text
usebench-billing-events
usebench-billing-events-dlq
```

Verify them before deployment:

```sh
cd apps/worker
npx wrangler queues list
cd ../..
```

Only if a Queue is genuinely absent, create it once:

```sh
cd apps/worker
npx wrangler queues create usebench-billing-events
npx wrangler queues create usebench-billing-events-dlq
cd ../..
```

Do not recreate or rename an existing production Queue during launch.

## 11. Install the Worker secrets

From the repository root, enter each value interactively. This prevents the
secret from appearing in process arguments or shell history:

```sh
cd apps/worker
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret list
cd ../..
```

The list must contain both secret names. It must not print their values. Confirm
that these were installed in the top-level production Worker, not
`--env staging`.

Do not set `STRIPE_PUBLISHABLE_KEY`; the application does not use one.

## 12. Run local release gates

Before touching production, record successful sandbox acceptance against the
isolated staging Worker, D1 database, Queue/DLQ, Stripe sandbox, webhook secret,
and daemon trust domain. Cover at least:

- signup and paid verification bypass;
- double-click and concurrent Checkout idempotency;
- abandoned Checkout expiry;
- first-subscription-only trial and attempted resubscription;
- zero-value opening Invoice and canonical trial entitlement;
- failed first charge and failed renewal;
- scheduled cancellation, reversal, and final expiry;
- Portal payment-method and invoice management;
- duplicate, delayed, and out-of-order webhook delivery;
- transient Queue retry and controlled DLQ replay;
- refund/dispute correlation;
- automatic-tax address behavior if tax will be enabled; and
- Free-to-Paid in-place resize, no-capacity retry, and Paid-to-Free downgrade.

The staging Stripe account/event destination must use API version
`2026-07-29.dahlia` and sandbox-only objects. Save sanitized evidence and the
tester/date; never copy sandbox credentials or object IDs into production.

Use a clean Node.js 22 checkout with the production configuration committed:

```sh
npm ci
npm run build:client -w apps/worker
npm run typecheck
npm run lint
npm test
npm audit --omit=dev --audit-level=high
npm run deploy:dry-run -- --skip-install
git diff --check
git status --short
```

Expected results:

- build, typecheck, lint, tests, audit, and dry run all exit zero;
- the audit reports no production vulnerabilities at the chosen threshold;
- the dry run says it would migrate D1, deploy the Worker, and request
  `https://usebench.dev/`;
- Wrangler reports `BILLING_EVENTS`, `BILLING_ENABLED=0`, and
  `STRIPE_LIVE_MODE=1`; and
- the real release checkout is clean. Do not use `--allow-dirty` for the
  production release.

Review pending production migrations before mutating D1:

```sh
cd apps/worker
npx wrangler d1 migrations list workbench --remote
cd ../..
```

This launch requires migrations through `0023_paid_upgrade_opt_in.sql`. D1
migrations are expand-first and do not automatically roll back. As of
2026-08-12, production reported migrations `0019` through `0023` as pending;
always trust the fresh command output rather than this historical snapshot.

## 13. Deploy the gated Worker and migrations

Schedule a coordinated release window. Confirm again that
`BILLING_ENABLED=0`, then run the normal production release:

```sh
npm run deploy
```

Review the prompt before approving it. The release script applies pending
remote D1 migrations, deploys the Worker, and smoke-tests
`https://usebench.dev/`.

After deployment:

```sh
cd apps/worker
npx wrangler d1 migrations list workbench --remote
cd ../..
curl --fail --show-error --silent https://usebench.dev/ >/dev/null
```

Require no pending migrations and a successful public smoke request. Verify an
authenticated account can open `/api/billing/status`. Checkout should remain
hidden/unavailable because the new-sales gate is closed; Portal and webhook
routes must remain operational for any existing billing records.

## 14. Roll out the compatible daemon fleet

Migration `0019` introduces mixed-tier shared-host state. The migration and
compatible gated Worker must be deployed before the daemon fleet. Read
`infra/RUNBOOK.md` before this step.

Load the fleet administrator secret without passing it on the command line:

```sh
read -rs FLEET_ADMIN_SECRET && export FLEET_ADMIN_SECRET
echo
npm run hostctl -- list
npm run hostctl -- deploy --all --dry-run
```

Review the host list, active jobs, release identities, capacity, and dry-run
output. `hostctl deploy` sequentially drains each selected host, waits for
active jobs, backs up and installs the release, audits and probes it, then
reactivates only hosts that were active before deployment. A failed deployment
remains draining; existing Incus tenants remain assigned.

When the maintenance window and dry run are approved:

```sh
npm run hostctl -- deploy --all
```

After deployment, run `npm run hostctl -- list`. Each shared host that is active
must report the intended release. For extra recorded evidence, substitute the
real host ID and run:

```sh
npm run hostctl -- audit HOST_ID
npm run hostctl -- probe HOST_ID
```

Require the probe to report the intended release, signed CPU hardware, tenancy
mode, and `mixed-tier-shared-v1` capability. If registered capacity does not
match canonical capacity, reconcile it deliberately:

```sh
npm run hostctl -- capacity HOST_ID
```

If a host remains draining, diagnose the failed deployment first. Only after
audit, probe, capacity, and Paid headroom are correct may it be activated:

```sh
npm run hostctl -- state HOST_ID active
```

Confirm at least one full reconciler interval and a real non-destructive job in
every affected host class. As of 2026-08-12, the active production shared host
reported legacy/null tenancy capability data; require the fresh probe to show
the new capability before enabling sales. Do not activate a legacy or
failed-probe host.

## 15. Run the gate-closed billing preflight

With production secrets installed, the gated Worker deployed, and the daemon
fleet compatible:

```sh
read -rs FLEET_ADMIN_SECRET && export FLEET_ADMIN_SECRET
echo
npm run hostctl -- billing-config
```

The redacted result must contain all of the following:

```json
{
  "availability": { "configured": false },
  "readiness": {
    "ready": true,
    "salesEnabled": false,
    "stripeApiConfigured": true,
    "expectedLiveMode": true,
    "missing": []
  },
  "stripePrice": {
    "valid": true,
    "mismatches": [],
    "actual": { "liveMode": true }
  }
}
```

Also manually compare the returned expected/actual amount, currency, interval,
Product, Price, usage type, and tax metadata with the approved offer.

Stop if readiness is null/false, `missing` is non-empty, the Stripe API reports
an error, `expectedLiveMode` is false, the Price is not live, or any mismatch is
reported. Do not solve a mismatch by changing the public display away from the
approved offer; correct the erroneous Stripe object or configuration.

## 16. Establish monitoring before the canary

The production on-call owner must be able to inspect and alert on:

- Stripe webhook delivery failures and retry age;
- webhook signature, live-mode, and API-version rejections;
- Cloudflare Queue age, retries, and the billing DLQ;
- failed or long-running `stripe_billing_events` rows;
- unsupported Prices and duplicate live subscriptions;
- stale canonical subscription reconciliation;
- failed/stale container plan transitions; and
- free and Paid CPU, RAM, disk, and tenant headroom.

At minimum, verify access to Stripe event deliveries, Cloudflare Worker logs,
Queue metrics, D1 read-only support queries, and fleet status. Assign an owner
and escalation path for each alert. Do not open sales if the DLQ cannot be
inspected and replayed safely.

## 17. Open a controlled live canary

`BILLING_ENABLED` is a global switch. Schedule a low-traffic window and be
prepared to close it immediately.

1. Change only the production value in `apps/worker/wrangler.jsonc`:

   ```jsonc
   "BILLING_ENABLED": "1"
   ```

2. Commit the change and run the release gates/dry run again.
3. Deploy the Worker. No new migration should be pending:

   ```sh
   npm run deploy
   ```

4. Run `npm run hostctl -- billing-config` again. Require
   `availability.configured=true`, `readiness.ready=true`,
   `readiness.salesEnabled=true`, and `stripePrice.valid=true`.
5. Use a dedicated real production account and a real payment method. Never use
   Stripe test payment methods in live mode.
6. Confirm Checkout shows the exact amount, currency, monthly renewal, taxes,
   seven-day trial, cancellation terms, and first-charge date before submission.
7. Confirm exactly one live Customer, Checkout Session, Subscription, and
   zero-value opening Invoice are created and correlated to the canary account.
8. Confirm the success redirect alone does not grant access; canonical
   `trialing` state received through the webhook Queue does.
9. Confirm the Stripe delivery receives `2xx`, the Queue drains, the D1 event is
   processed once, and duplicate/redelivered Events are harmless.
10. Open Customer Portal and verify invoice/payment-method management,
    cancellation at period end, cancellation reversal, and return navigation.
11. Explicitly request the Premium container upgrade and verify the in-place
    resize completes without rebuild, re-home, or data loss.
12. If the approved canary plan includes a real charge, end the trial through
    the Stripe Dashboard after the trial flow is verified. Confirm a settled
    `invoice.paid` and canonical active Subscription advance paid-through
    service. Do not fabricate an application entitlement.
13. Cancel and, if approved, refund the canary according to the published
    policy. Verify webhook, notification, entitlement, and container behavior.

After collecting evidence, set `BILLING_ENABLED=0` and redeploy while the team
reviews the canary. This prevents accidental broad sales during the go/no-go
review without interrupting webhook processing or Customer Portal access.

## 18. Go/no-go and broad availability

Review all canary evidence with the product, support, finance/tax, infrastructure,
and on-call owners. The go decision requires:

- approved offer and effective public policies;
- unrestricted live charges/payouts;
- exact live Product/Price validation;
- live account and event API version alignment;
- successful webhook-to-Queue-to-D1 processing, including duplicate safety;
- functional Portal cancellation and recovery;
- successful entitlement and in-place resource transition;
- empty/understood Queue backlog and DLQ;
- sufficient Paid fleet capacity; and
- tested stop-sales and operational ownership.

For broad availability, set the committed production value to
`BILLING_ENABLED=1`, run the complete release gates, deploy, and immediately
repeat the readiness and monitoring checks.

## 19. Emergency stop and rollback

### Stop new sales

The fastest safe application rollback is:

1. Set `BILLING_ENABLED=0` in the production Wrangler configuration.
2. Commit, build, and deploy that change.
3. Confirm `/api/billing/status` no longer offers Checkout.
4. Keep the live webhook, Queue consumer, secrets, and Portal operational so
   existing subscriptions continue to converge and customers can manage them.

Do not delete the Price, webhook destination, Queue, D1 billing rows, or Stripe
Customers/Subscriptions as an emergency stop mechanism.

### Worker or schema issue

- Deploy the last compatible Worker release with `BILLING_ENABLED=0`.
- D1 migrations do not roll back automatically; do not attempt ad hoc reverse
  SQL.
- Preserve Queue messages and Stripe retries while correcting the consumer.
- Follow `infra/RUNBOOK.md` for daemon rollback. Daemon rollback does not undo
  Worker state or capacity reservations.

### Credential exposure

1. Close new sales.
2. Rotate the affected Stripe API key or webhook endpoint secret in live mode.
3. Replace the corresponding Wrangler secret interactively.
4. Deploy/verify, inspect Stripe request and delivery logs, then revoke the old
   credential after the replacement is confirmed.
5. Follow the incident process for any suspected unauthorized access.

## 20. Source references

- [Stripe go-live checklist](https://docs.stripe.com/get-started/checklist/go-live)
- [Stripe API keys and live/sandbox separation](https://docs.stripe.com/keys)
- [Stripe webhook security, retries, duplicates, and ordering](https://docs.stripe.com/webhooks)
- [Stripe Customer Portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal)
- [Stripe Billing customer emails](https://docs.stripe.com/billing/revenue-recovery/customer-emails)
- Repository billing contract: `MONETIZATION.md`
- Control-plane and fleet release procedure: `infra/RUNBOOK.md`
- Architecture and acceptance contract: `SPEC.md`
