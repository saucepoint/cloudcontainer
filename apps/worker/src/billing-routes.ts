import { Hono } from "hono";
import { bearerToken, secretMatches } from "./admin-auth.js";
import { requireAccount } from "./auth.js";
import {
  billingAvailability,
  configuredCheckoutSessionMinutes,
  inspectPaidStripePrice,
  validatePaidStripePrice,
} from "./billing-config.js";
import { BillingEventError } from "./billing-errors.js";
import {
  accountAccess,
  accountEntitlement,
  effectiveEntitlementForUser,
  projectStripeEntitlement,
} from "./entitlements.js";
import { requestPlanTransition } from "./plan-transitions.js";
import {
  createStripeCheckoutSession,
  createStripeCustomer,
  createStripePortalSession,
  listStripeSubscriptions,
  stripeEntityId,
  StripeApiError,
  StripeConfigurationError,
  StripeWebhookError,
  verifyStripeEvent,
} from "./stripe.js";
import type {
  AppContext,
  Bindings,
  ContainerPlanTransitionRow,
  StripeCustomerRow,
  StripeSubscriptionRow,
  UserRow,
} from "./types.js";

interface StripeCheckoutAttemptRow {
  id: string;
  user_id: string;
  stripe_checkout_session_id: string | null;
  status: "creating" | "open" | "complete" | "expired" | "failed";
  expires_at: number;
  created_at: number;
  updated_at: number;
}

async function stripeCustomerForUser(
  env: Bindings,
  user: UserRow,
): Promise<StripeCustomerRow> {
  const existing = await env.DB.prepare("SELECT * FROM stripe_customers WHERE user_id = ?")
    .bind(user.id)
    .first<StripeCustomerRow>();
  if (existing) return existing;

  const customer = await createStripeCustomer(env, { userId: user.id, email: user.email });
  if (customer.deleted) throw new BillingEventError("invalid_customer_response");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO stripe_customers
       (user_id, stripe_customer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(user.id, customer.id, now, now).run();
  const row = await env.DB.prepare("SELECT * FROM stripe_customers WHERE user_id = ?")
    .bind(user.id)
    .first<StripeCustomerRow>();
  if (!row || row.stripe_customer_id !== customer.id) {
    throw new BillingEventError("customer_mapping_conflict");
  }
  return row;
}

async function claimCheckoutAttempt(
  env: Bindings,
  userId: string,
  now = Date.now(),
): Promise<{ attempt: StripeCheckoutAttemptRow; created: boolean }> {
  const candidateId = `checkout:${crypto.randomUUID()}`;
  const expiresAt = now + configuredCheckoutSessionMinutes(env) * 60_000;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE stripe_checkout_attempts
       SET status = 'expired', updated_at = ?
       WHERE user_id = ? AND status IN ('creating','open') AND expires_at <= ?`,
    ).bind(now, userId, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO stripe_checkout_attempts
         (id, user_id, status, expires_at, created_at, updated_at)
       VALUES (?, ?, 'creating', ?, ?, ?)`,
    ).bind(candidateId, userId, expiresAt, now, now),
  ]);
  const attempt = await env.DB.prepare(
    `SELECT * FROM stripe_checkout_attempts
     WHERE user_id = ? AND status IN ('creating','open')
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(userId).first<StripeCheckoutAttemptRow>();
  if (!attempt) throw new BillingEventError("checkout_attempt_conflict");
  return { attempt, created: attempt.id === candidateId };
}

async function markCheckoutAttemptFailed(env: Bindings, attemptId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE stripe_checkout_attempts SET status = 'failed', updated_at = ?
     WHERE id = ? AND status IN ('creating','open')`,
  ).bind(Date.now(), attemptId).run();
}

async function checkoutTrialEligible(
  env: Bindings,
  customer: StripeCustomerRow,
): Promise<boolean> {
  if (customer.trial_used_at !== null) return false;
  const priorTrial = await env.DB.prepare(
    `SELECT 1 FROM stripe_subscriptions
     WHERE user_id = ? AND trial_start IS NOT NULL LIMIT 1`,
  ).bind(customer.user_id).first();
  return priorTrial === null;
}

export async function billingStatusForUser(env: Bindings, user: UserRow, now = Date.now()) {
  const [entitlement, subscription, customer] = await Promise.all([
    accountEntitlement(env, user.id),
    env.DB.prepare(
      `SELECT * FROM stripe_subscriptions
       WHERE user_id = ?
       ORDER BY CASE WHEN stripe_status NOT IN ('canceled','incomplete_expired')
         THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    ).bind(user.id).first<StripeSubscriptionRow>(),
    env.DB.prepare("SELECT * FROM stripe_customers WHERE user_id = ?")
      .bind(user.id).first<StripeCustomerRow>(),
  ]);
  const effective = await effectiveEntitlementForUser(env, user, now);
  const trialEligible = customer === null
    ? true
    : await checkoutTrialEligible(env, customer);
  const displayedBillingState = entitlement?.source === "stripe" && subscription
    ? projectStripeEntitlement({
        stripeStatus: subscription.stripe_status,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        cancelAt: subscription.cancel_at,
        trialEnd: subscription.trial_end,
        serviceUntil: subscription.service_until,
        graceUntil: subscription.grace_until,
      }, now).state
    : entitlement?.state;
  const billing = billingAvailability(env);
  return {
    configured: billing.configured,
    paidPlan: billing.paidPlan,
    trialEligible,
    entitlement: effective,
    account: accountAccess(user, effective),
    billing: entitlement
      ? {
          plan: entitlement.plan,
          source: entitlement.source,
          state: displayedBillingState ?? entitlement.state,
          trialUntil: entitlement.trial_until,
          serviceUntil: entitlement.service_until,
          graceUntil: entitlement.grace_until,
        }
      : null,
    subscription: subscription
      ? {
          status: subscription.stripe_status,
          cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
          cancelAt: subscription.cancel_at,
          trialStart: subscription.trial_start,
          trialEnd: subscription.trial_end,
          serviceUntil: subscription.service_until,
          graceUntil: subscription.grace_until,
        }
      : null,
  };
}

function routeError(c: Parameters<typeof requireAccount>[0], error: unknown) {
  if (error instanceof StripeConfigurationError) {
    return c.json({ error: "Paid billing is not available yet." }, 503);
  }
  if (error instanceof StripeApiError) {
    return c.json({ error: "Stripe is temporarily unavailable. Try again shortly." }, 502);
  }
  if (error instanceof BillingEventError && error.code === "stripe_subscription_pending") {
    return c.json({
      error: "A Stripe subscription already exists and is still syncing. Try again shortly.",
    }, 409);
  }
  throw error;
}

async function billingAdminFailure(
  c: Parameters<typeof requireAccount>[0],
): Promise<Response | null> {
  if (!c.env.FLEET_ADMIN_SECRET) return c.notFound();
  const provided = bearerToken(c.req.header("authorization"));
  if (!(await secretMatches(provided, c.env.FLEET_ADMIN_SECRET))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return null;
}

export const billingRoutes = new Hono<AppContext>()
  .get("/api/billing/status", requireAccount, async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await billingStatusForUser(c.env, c.get("user")));
  })
  .post("/api/billing/checkout", requireAccount, async (c) => {
    try {
      if (!billingAvailability(c.env).configured) {
        return c.json({ error: "Paid billing is not available yet." }, 503);
      }
      const user = c.get("user");
      const live = await c.env.DB.prepare(
        `SELECT stripe_subscription_id FROM stripe_subscriptions
         WHERE user_id = ? AND stripe_status NOT IN ('canceled','incomplete_expired')
         LIMIT 1`,
      ).bind(user.id).first();
      if (live) {
        const customer = await c.env.DB.prepare(
          "SELECT * FROM stripe_customers WHERE user_id = ?",
        ).bind(user.id).first<StripeCustomerRow>();
        if (!customer) throw new BillingEventError("live_subscription_missing_customer");
        const portal = await createStripePortalSession(c.env, customer.stripe_customer_id);
        return c.json({ url: portal.url }, 200);
      }
      await validatePaidStripePrice(c.env);
      const customer = await stripeCustomerForUser(c.env, user);
      const remoteSubscriptions = await listStripeSubscriptions(
        c.env,
        customer.stripe_customer_id,
      );
      if (remoteSubscriptions.data.some((subscription) =>
        !["canceled", "incomplete_expired"].includes(subscription.status)
      )) {
        throw new BillingEventError("stripe_subscription_pending");
      }
      const remoteTrialUsed = remoteSubscriptions.has_more ||
        remoteSubscriptions.data.some((subscription) => subscription.trial_start != null);
      const { attempt, created } = await claimCheckoutAttempt(c.env, user.id);
      try {
        const session = await createStripeCheckoutSession(c.env, {
          userId: user.id,
          customerId: customer.stripe_customer_id,
          attemptId: attempt.id,
          expiresAt: Math.floor(attempt.expires_at / 1000),
          trialEligible: !remoteTrialUsed && await checkoutTrialEligible(c.env, customer),
        });
        if (stripeEntityId(session.customer) !== customer.stripe_customer_id) {
          await markCheckoutAttemptFailed(c.env, attempt.id);
          throw new BillingEventError("checkout_customer_mismatch");
        }
        const updated = await c.env.DB.prepare(
          `UPDATE stripe_checkout_attempts
           SET stripe_checkout_session_id = ?, status = 'open', updated_at = ?
           WHERE id = ? AND user_id = ? AND status IN ('creating','open')`,
        ).bind(session.id, Date.now(), attempt.id, user.id).run();
        if (!updated.meta.changes) throw new BillingEventError("checkout_attempt_lost");
        return c.json({ url: session.url }, created ? 201 : 200);
      } catch (error) {
        if (
          error instanceof StripeConfigurationError ||
          (error instanceof StripeApiError && error.status >= 400 && error.status < 500)
        ) {
          await markCheckoutAttemptFailed(c.env, attempt.id);
        }
        return routeError(c, error);
      }
    } catch (error) {
      return routeError(c, error);
    }
  })
  .post("/api/billing/portal", requireAccount, async (c) => {
    const customer = await c.env.DB.prepare("SELECT * FROM stripe_customers WHERE user_id = ?")
      .bind(c.get("user").id)
      .first<StripeCustomerRow>();
    if (!customer) return c.json({ error: "No billing account exists yet." }, 404);
    try {
      const session = await createStripePortalSession(c.env, customer.stripe_customer_id);
      return c.json({ url: session.url }, 201);
    } catch (error) {
      return routeError(c, error);
    }
  })
  .post("/api/stripe/webhook", async (c) => {
    const rawBody = await c.req.text();
    let event;
    try {
      event = await verifyStripeEvent(
        rawBody,
        c.req.header("stripe-signature"),
        c.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (error) {
      if (error instanceof StripeConfigurationError) {
        return c.json({ error: "webhook unavailable" }, 503);
      }
      if (error instanceof StripeWebhookError) {
        return c.json({ error: "invalid webhook" }, 400);
      }
      throw error;
    }
    if (!c.env.BILLING_EVENTS) return c.json({ error: "billing queue unavailable" }, 503);
    try {
      await c.env.BILLING_EVENTS.send({
        eventId: event.id,
        eventType: event.type,
        eventCreated: event.created,
      });
    } catch {
      return c.json({ error: "billing queue unavailable" }, 503);
    }
    return c.body(null, 204);
  })
  .get("/api/admin/billing-configuration", async (c) => {
    const failure = await billingAdminFailure(c);
    if (failure) return failure;
    try {
      const availability = billingAvailability(c.env);
      if (!availability.configured) {
        return c.json({ availability, stripePrice: null });
      }
      try {
        return c.json({ availability, stripePrice: await inspectPaidStripePrice(c.env) });
      } catch (error) {
        if (error instanceof StripeApiError) {
          return c.json({
            availability,
            stripePrice: {
              valid: false,
              error: { type: "stripe_api", status: error.status, code: error.code },
            },
          });
        }
        if (error instanceof StripeConfigurationError) {
          return c.json({
            availability,
            stripePrice: {
              valid: false,
              error: { type: "configuration", message: error.message },
            },
          });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof StripeConfigurationError) {
        return c.json({
          availability: { configured: false, paidPlan: null },
          stripePrice: {
            valid: false,
            error: { type: "configuration", message: error.message },
          },
        });
      }
      throw error;
    }
  })
  .get("/api/admin/billing/:userId", async (c) => {
    const failure = await billingAdminFailure(c);
    if (failure) return failure;
    const userId = c.req.param("userId");
    const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(userId).first<UserRow>();
    if (!user) return c.json({ error: "unknown account" }, 404);
    const [entitlement, customer, subscription, container, transition] = await Promise.all([
      accountEntitlement(c.env, userId),
      c.env.DB.prepare("SELECT * FROM stripe_customers WHERE user_id = ?")
        .bind(userId).first<StripeCustomerRow>(),
      c.env.DB.prepare(
        `SELECT * FROM stripe_subscriptions WHERE user_id = ?
         ORDER BY CASE WHEN stripe_status NOT IN ('canceled','incomplete_expired')
           THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1`,
      ).bind(userId).first<StripeSubscriptionRow>(),
      c.env.DB.prepare(
        `SELECT id, tier, placement_mode, status, suspension_reason, destroy_after
         FROM containers WHERE user_id = ?`,
      ).bind(userId).first(),
      c.env.DB.prepare(
        `SELECT t.* FROM container_plan_transitions t
         JOIN containers c ON c.id = t.container_id WHERE c.user_id = ?`,
      ).bind(userId).first<ContainerPlanTransitionRow>(),
    ]);
    const latestEvent = subscription
      ? await c.env.DB.prepare(
          `SELECT event_id, event_type, status, attempt_count, received_at,
                  processed_at, last_error_code
           FROM stripe_billing_events WHERE subscription_id = ?
           ORDER BY received_at DESC LIMIT 1`,
        ).bind(subscription.stripe_subscription_id).first()
      : null;
    return c.json({
      account: {
        id: user.id,
        status: user.status,
        verifiedAt: user.verified_at,
        verificationMethod: user.verification_method,
      },
      effectiveEntitlement: await effectiveEntitlementForUser(c.env, user),
      entitlement,
      stripeCustomerId: customer?.stripe_customer_id ?? null,
      subscription,
      latestEvent,
      container,
      transition,
    });
  })
  .post("/api/admin/billing/:userId/retry-transition", async (c) => {
    const failure = await billingAdminFailure(c);
    if (failure) return failure;
    const userId = c.req.param("userId");
    const transition = await c.env.DB.prepare(
      `SELECT t.* FROM container_plan_transitions t
       JOIN containers c ON c.id = t.container_id WHERE c.user_id = ?`,
    ).bind(userId).first<ContainerPlanTransitionRow>();
    if (!transition) return c.json({ error: "no plan transition" }, 404);
    const result = await requestPlanTransition(c.env, userId, transition.to_tier);
    return c.json({ result }, result === "resizing" ? 202 : 200);
  });
