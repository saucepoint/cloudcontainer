import { Hono } from "hono";
import { SERVICE_PLANS, TIERS } from "@workbench/contract";
import { bearerToken, secretMatches } from "./admin-auth.js";
import { requireAccount } from "./auth.js";
import {
  accountAccess,
  accountEntitlement,
  effectiveEntitlementForUser,
  hasPermanentFreeEligibility,
  projectStripeEntitlement,
} from "./entitlements.js";
import {
  cancelUnreservedPlanTransition,
  requestPaidUpgrade,
  requestPlanTransition,
} from "./plan-transitions.js";
import {
  enqueueJob,
  getContainerForUser,
  getHost,
  HostJobAdmissionError,
  LifecycleJobConflictError,
} from "./jobs.js";
import { createUserNotification } from "./notifications.js";
import {
  createStripeCheckoutSession,
  createStripeCustomer,
  createStripePortalSession,
  listStripeSubscriptions,
  paidPriceId,
  retrieveStripeCharge,
  retrieveStripeEvent,
  retrieveStripeInvoice,
  retrieveStripePrice,
  retrieveStripeSubscription,
  PAID_TRIAL_DAYS,
  STRIPE_API_VERSION,
  StripeApiError,
  StripeConfigurationError,
  type StripeCheckoutSession,
  type StripeCharge,
  type StripeInvoice,
  type StripePrice,
  type StripeSubscription,
  verifyStripeEvent,
} from "./stripe.js";
import type {
  AppContext,
  BillingEventMessage,
  Bindings,
  ContainerPlanTransitionRow,
  StripeCustomerRow,
  StripeSubscriptionRow,
  UserRow,
} from "./types.js";

const SUPPORTED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
  "charge.refunded",
  "charge.dispute.created",
]);
const BILLING_EVENT_LEASE_MS = 5 * 60_000;
const DEFAULT_CHECKOUT_SESSION_MINUTES = 60;
const MIN_CHECKOUT_SESSION_MINUTES = 31;
const MAX_CHECKOUT_SESSION_MINUTES = 24 * 60;
const DECIMAL_PRICE_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;
const ISO_CURRENCY_RE = /^[A-Z]{3}$/;

interface StripeCheckoutAttemptRow {
  id: string;
  user_id: string;
  stripe_checkout_session_id: string | null;
  status: "creating" | "open" | "complete" | "expired" | "failed";
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface BillingQueueMessage {
  body: BillingEventMessage;
  ack(): void;
  retry(): void;
}

export interface BillingQueueBatch {
  messages: BillingQueueMessage[];
}

export class BillingEventError extends Error {
  constructor(readonly code: string) {
    super(`Billing event failed (${code})`);
    this.name = "BillingEventError";
  }
}

function customerId(value: StripeSubscription["customer"] | StripeInvoice["customer"]): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

function objectId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : null;
}

function relatedSubscriptionId(eventType: string, object: Record<string, unknown>): string | null {
  if (eventType.startsWith("customer.subscription.")) return objectId(object);
  if (eventType === "checkout.session.completed") {
    const subscription = (object as unknown as StripeCheckoutSession).subscription;
    return typeof subscription === "string" ? subscription : subscription?.id ?? null;
  }
  if (eventType.startsWith("invoice.")) {
    const invoice = object as unknown as StripeInvoice;
    const parentSubscription = invoice.parent?.type === "subscription_details"
      ? invoice.parent.subscription_details?.subscription
      : null;
    const subscription = parentSubscription ?? invoice.subscription;
    return typeof subscription === "string" ? subscription : subscription?.id ?? null;
  }
  return null;
}

function configuredGraceMs(env: Bindings): number {
  const raw = env.BILLING_GRACE_DAYS?.trim();
  if (!raw) return 0;
  const days = Number(raw);
  return Number.isFinite(days) && days >= 0 ? Math.floor(days * 86_400_000) : 0;
}

function configuredCheckoutSessionMinutes(env: Bindings): number {
  const raw = env.BILLING_CHECKOUT_SESSION_MINUTES?.trim();
  if (!raw) return DEFAULT_CHECKOUT_SESSION_MINUTES;
  const minutes = Number(raw);
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_CHECKOUT_SESSION_MINUTES || minutes > MAX_CHECKOUT_SESSION_MINUTES
  ) {
    throw new StripeConfigurationError("Checkout Session lifetime is invalid");
  }
  return minutes;
}

export function billingConfigured(env: Bindings): boolean {
  const price = env.PAID_PLAN_MONTHLY_PRICE?.trim();
  const currency = env.PAID_PLAN_CURRENCY?.trim().toUpperCase();
  let policyValid = true;
  try {
    configuredUnitAmount(env);
    configuredCheckoutSessionMinutes(env);
  } catch {
    policyValid = false;
  }
  return Boolean(
    env.BILLING_ENABLED === "1" &&
    env.STRIPE_SECRET_KEY?.trim() &&
    env.STRIPE_WEBHOOK_SECRET?.trim() &&
    env.STRIPE_PRICE_PAID_MONTHLY?.trim() &&
    price && DECIMAL_PRICE_RE.test(price) &&
    currency && ISO_CURRENCY_RE.test(currency) &&
    policyValid &&
    (!env.STRIPE_TAX_ENABLED || ["0", "1"].includes(env.STRIPE_TAX_ENABLED.trim())) &&
    env.BILLING_EVENTS,
  );
}

export function paidPlanDisplay(env: Bindings) {
  const price = env.PAID_PLAN_MONTHLY_PRICE?.trim() ?? null;
  const currency = env.PAID_PLAN_CURRENCY?.trim().toUpperCase() ?? null;
  if (!price || !currency || !DECIMAL_PRICE_RE.test(price) || !ISO_CURRENCY_RE.test(currency)) {
    return null;
  }
  try {
    configuredUnitAmount(env);
  } catch {
    return null;
  }
  return {
    price,
    currency,
    interval: "month" as const,
    trialDays: PAID_TRIAL_DAYS,
    display: `${PAID_TRIAL_DAYS}-day free trial, then ${currency} ${price}/month`,
  };
}

function currencyMinorUnits(currency: string): number {
  try {
    const units = new Intl.NumberFormat("en", { style: "currency", currency })
      .resolvedOptions().maximumFractionDigits;
    if (units === undefined) throw new Error("missing currency precision");
    return units;
  } catch {
    throw new StripeConfigurationError("Paid plan currency is invalid");
  }
}

function configuredUnitAmount(env: Bindings): number {
  const price = env.PAID_PLAN_MONTHLY_PRICE?.trim();
  const currency = env.PAID_PLAN_CURRENCY?.trim().toUpperCase();
  if (!price || !currency || !DECIMAL_PRICE_RE.test(price) || !ISO_CURRENCY_RE.test(currency)) {
    throw new StripeConfigurationError("Paid plan disclosure is invalid");
  }
  const minorUnits = currencyMinorUnits(currency);
  const [whole, fraction = ""] = price.split(".");
  if (fraction.length > minorUnits) {
    throw new StripeConfigurationError("Paid plan amount has too many decimal places");
  }
  const amount = Number(whole) * (10 ** minorUnits) + Number(fraction.padEnd(minorUnits, "0") || "0");
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new StripeConfigurationError("Paid plan amount is invalid");
  }
  return amount;
}

function productTaxCode(product: StripePrice["product"]): string | null {
  if (typeof product === "string") return null;
  if (typeof product.tax_code === "string") return product.tax_code;
  return product.tax_code?.id ?? null;
}

/** Fail closed before Checkout if the charged Stripe Price can differ from the UI disclosure. */
export async function validatePaidStripePrice(env: Bindings): Promise<StripePrice> {
  const expectedId = paidPriceId(env);
  const expectedCurrency = env.PAID_PLAN_CURRENCY?.trim().toLowerCase();
  const price = await retrieveStripePrice(env, expectedId);
  const productActive = typeof price.product === "object" && price.product !== null &&
    price.product.active === true;
  if (
    price.id !== expectedId || !price.active || !productActive ||
    price.type !== "recurring" || price.billing_scheme !== "per_unit" ||
    price.unit_amount !== configuredUnitAmount(env) ||
    typeof price.currency !== "string" || price.currency.toLowerCase() !== expectedCurrency ||
    price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed"
  ) {
    throw new StripeConfigurationError("Paid Stripe Price does not match the published plan");
  }
  if (env.STRIPE_TAX_ENABLED === "1" && (
    !["exclusive", "inclusive"].includes(price.tax_behavior ?? "") ||
    productTaxCode(price.product) === null
  )) {
    throw new StripeConfigurationError("Stripe Tax requires Price tax behavior and a Product tax code");
  }
  return price;
}

function deadlineLabel(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function billingNoticeStatement(
  env: Bindings,
  input: {
    id: string;
    userId: string;
    title: string;
    message: string;
    severity: "info" | "warning" | "critical";
    createdAt: number;
  },
) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO notifications
       (id, user_id, title, message, severity, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    input.id,
    input.userId,
    input.title,
    input.message,
    input.severity,
    input.createdAt,
  );
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
  if (!customer.id || customer.deleted) throw new BillingEventError("invalid_customer_response");
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

async function markCheckoutAttemptFailed(
  env: Bindings,
  attemptId: string,
): Promise<void> {
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
  return {
    configured: billingConfigured(env),
    paidPlan: paidPlanDisplay(env),
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
    if (!billingConfigured(c.env)) {
      return c.json({ error: "Paid billing is not available yet." }, 503);
    }
    const user = c.get("user");
    try {
      paidPriceId(c.env);
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
        if (!portal.url) throw new BillingEventError("invalid_portal_response");
        return c.json({ url: portal.url }, 200);
      }
      await validatePaidStripePrice(c.env);
      const customer = await stripeCustomerForUser(c.env, user);
      const remoteSubscriptions = await listStripeSubscriptions(
        c.env,
        customer.stripe_customer_id,
      );
      if (!Array.isArray(remoteSubscriptions.data)) {
        throw new BillingEventError("invalid_subscription_list");
      }
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
        if (!session.id || !session.url || customerId(session.customer) !== customer.stripe_customer_id) {
          await markCheckoutAttemptFailed(c.env, attempt.id);
          throw new BillingEventError("invalid_checkout_response");
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
      if (!session.url) throw new BillingEventError("invalid_portal_response");
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
      return c.json({ error: "invalid webhook" }, 400);
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

async function claimBillingEvent(
  env: Bindings,
  message: BillingEventMessage,
): Promise<"claimed" | "processed" | "busy"> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO stripe_billing_events
       (event_id, event_type, event_created, status, received_at)
     VALUES (?, ?, ?, 'received', ?)`,
  ).bind(message.eventId, message.eventType, message.eventCreated, now).run();
  const claimed = await env.DB.prepare(
    `UPDATE stripe_billing_events
     SET status = 'processing', attempt_count = attempt_count + 1,
         processing_started_at = ?,
         last_error_code = NULL
     WHERE event_id = ? AND event_type = ? AND event_created = ?
       AND (status IN ('received','failed') OR
         (status = 'processing' AND processing_started_at <= ?))`,
  ).bind(
    now,
    message.eventId,
    message.eventType,
    message.eventCreated,
    now - BILLING_EVENT_LEASE_MS,
  ).run();
  if (claimed.meta.changes) return "claimed";
  const row = await env.DB.prepare(
    "SELECT status FROM stripe_billing_events WHERE event_id = ?",
  ).bind(message.eventId).first<{ status: string }>();
  return row?.status === "processed" ? "processed" : "busy";
}

async function markEventFailed(env: Bindings, eventId: string, error: unknown): Promise<void> {
  const code = error instanceof BillingEventError
    ? error.code
    : error instanceof StripeApiError
    ? `stripe_${error.status}_${error.code}`
    : "processing_error";
  await env.DB.prepare(
    `UPDATE stripe_billing_events
     SET status = 'failed', last_error_code = ?
     WHERE event_id = ? AND status = 'processing'`,
  ).bind(code.slice(0, 128), eventId).run();
}

async function markNonSubscriptionEvent(
  env: Bindings,
  eventId: string,
  object: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE stripe_billing_events
     SET status = 'processed', object_id = ?, processed_at = ?
     WHERE event_id = ? AND status = 'processing'`,
  ).bind(objectId(object), Date.now(), eventId).run();
}

function riskEventChargeId(eventType: string, object: Record<string, unknown>): string | null {
  if (eventType === "charge.refunded") return objectId(object);
  if (eventType === "charge.dispute.created") {
    const charge = object.charge;
    return typeof charge === "string" ? charge : objectId(charge);
  }
  return null;
}

async function processBillingRiskEvent(
  env: Bindings,
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
): Promise<void> {
  const chargeId = riskEventChargeId(event.type, event.data.object);
  if (!chargeId) throw new BillingEventError("risk_event_missing_charge");
  const charge: StripeCharge = await retrieveStripeCharge(env, chargeId);
  if (charge.id !== chargeId) throw new BillingEventError("charge_id_mismatch");
  const invoiceId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id ?? null;
  if (!invoiceId) {
    console.warn(JSON.stringify({ event: "billing_operator_alert", type: event.type, eventId: event.id }));
    await markNonSubscriptionEvent(env, event.id, event.data.object);
    return;
  }
  const invoice = await retrieveStripeInvoice(env, invoiceId);
  const subscriptionId = relatedSubscriptionId("invoice.paid", invoice as unknown as Record<string, unknown>);
  if (!subscriptionId) throw new BillingEventError("risk_event_missing_subscription");
  const subscription = await retrieveStripeSubscription(env, subscriptionId);
  const customer = await validatedSubscriptionOwner(env, subscription);
  const stripeCustomerId = customerId(charge.customer);
  if (
    stripeCustomerId !== customer.stripe_customer_id ||
    customerId(invoice.customer) !== customer.stripe_customer_id
  ) {
    throw new BillingEventError("risk_event_customer_mismatch");
  }
  const now = Date.now();
  const title = event.type === "charge.dispute.created" ? "Payment disputed" : "Payment refunded";
  const message = event.type === "charge.dispute.created"
    ? "A payment dispute was opened for your Premium subscription. Contact support if you do not recognize it. Access changes require operator review."
    : "A payment for your Premium subscription was refunded. Any access change follows the published refund policy and operator review.";
  await env.DB.batch([
    billingNoticeStatement(env, {
      id: `billing:${event.id}`,
      userId: customer.user_id,
      title,
      message,
      severity: "critical",
      createdAt: now,
    }),
    env.DB.prepare(
      `UPDATE stripe_billing_events
       SET status = 'processed', object_id = ?, subscription_id = ?, processed_at = ?
       WHERE event_id = ? AND status = 'processing'`,
    ).bind(objectId(event.data.object), subscriptionId, now, event.id),
  ]);
  console.warn(JSON.stringify({
    event: "billing_operator_alert",
    type: event.type,
    eventId: event.id,
    subscriptionId,
    userId: customer.user_id,
  }));
}

async function validatedSubscriptionOwner(
  env: Bindings,
  subscription: StripeSubscription,
): Promise<StripeCustomerRow> {
  const stripeCustomerId = customerId(subscription.customer);
  if (!stripeCustomerId) throw new BillingEventError("subscription_missing_customer");
  const customer = await env.DB.prepare(
    "SELECT * FROM stripe_customers WHERE stripe_customer_id = ?",
  ).bind(stripeCustomerId).first<StripeCustomerRow>();
  if (!customer) throw new BillingEventError("unknown_customer");
  if (subscription.metadata.userId !== customer.user_id) {
    throw new BillingEventError("subscription_user_mismatch");
  }
  if (subscription.metadata.plan !== "paid") {
    throw new BillingEventError("unsupported_plan");
  }
  if (subscription.items.has_more || subscription.items.data.length !== 1) {
    throw new BillingEventError("unsupported_subscription_items");
  }
  const item = subscription.items.data[0];
  if (!item || item.price.id !== paidPriceId(env) || (item.quantity ?? 1) !== 1) {
    throw new BillingEventError("unsupported_price");
  }
  if (!Number.isInteger(item.current_period_end) || item.current_period_end <= 0) {
    throw new BillingEventError("invalid_billing_period");
  }
  const trialStart = subscription.trial_start ?? null;
  const trialEnd = subscription.trial_end ?? null;
  if ((trialStart === null) !== (trialEnd === null)) {
    throw new BillingEventError("invalid_trial_period");
  }
  if (subscription.status === "trialing" && (trialStart === null || trialEnd === null)) {
    throw new BillingEventError("invalid_trial_period");
  }
  if (trialStart !== null && trialEnd !== null && (
    !Number.isInteger(trialStart) || !Number.isInteger(trialEnd) ||
    trialEnd <= trialStart || trialEnd - trialStart > PAID_TRIAL_DAYS * 86_400
  )) {
    throw new BillingEventError("invalid_trial_period");
  }
  return customer;
}

async function applyCanonicalSubscription(
  env: Bindings,
  input: {
    eventId: string | null;
    eventType: string;
    eventCreated: number;
    object: Record<string, unknown>;
    subscription: StripeSubscription;
  },
): Promise<string> {
  const customer = await validatedSubscriptionOwner(env, input.subscription);
  const stripeCustomerId = customer.stripe_customer_id;
  const existing = await env.DB.prepare(
    "SELECT * FROM stripe_subscriptions WHERE stripe_subscription_id = ?",
  ).bind(input.subscription.id).first<StripeSubscriptionRow>();
  if (existing && existing.user_id !== customer.user_id) {
    throw new BillingEventError("subscription_owner_conflict");
  }
  const existingEntitlement = await accountEntitlement(env, customer.user_id);

  const invoice = input.eventType.startsWith("invoice.")
    ? input.object as unknown as StripeInvoice
    : null;
  if (invoice && customerId(invoice.customer) !== stripeCustomerId) {
    throw new BillingEventError("invoice_customer_mismatch");
  }
  if (invoice?.id === undefined && input.eventType.startsWith("invoice.")) {
    throw new BillingEventError("invoice_missing_id");
  }
  if (input.eventType === "invoice.paid" && invoice?.paid !== true && invoice?.status !== "paid") {
    throw new BillingEventError("invoice_not_paid");
  }
  const otherLiveSubscription = await env.DB.prepare(
    `SELECT stripe_subscription_id FROM stripe_subscriptions
     WHERE user_id = ? AND stripe_subscription_id <> ?
       AND stripe_status NOT IN ('canceled','incomplete_expired')
     LIMIT 1`,
  ).bind(customer.user_id, input.subscription.id).first<{ stripe_subscription_id: string }>();
  const incomingIsLive = !["canceled", "incomplete_expired"].includes(input.subscription.status);
  if (incomingIsLive && otherLiveSubscription) {
    throw new BillingEventError("duplicate_live_subscriptions");
  }
  // A delayed terminal event for subscription history must not replace a
  // newer live subscription as the account's authoritative entitlement.
  const authoritativeSubscription = otherLiveSubscription === null;
  const item = input.subscription.items.data[0]!;
  // Stripe emits invoice.paid for the zero-value invoice that opens a free
  // trial. Stripe recommends provisioning only when invoice.paid accompanies
  // canonical active subscription state. That also permits legitimate
  // zero-amount settled renewals covered by credits or discounts.
  const paidInvoice = input.eventType === "invoice.paid" &&
    input.subscription.status === "active";
  const paidThrough = paidInvoice ? item.current_period_end * 1000 : null;
  const serviceUntil = Math.max(existing?.service_until ?? 0, paidThrough ?? 0) || null;
  const graceUntil = input.eventType === "invoice.payment_failed" && serviceUntil !== null &&
      configuredGraceMs(env) > 0
    ? serviceUntil + configuredGraceMs(env)
    : existing?.grace_until ?? null;
  const now = Date.now();
  const trialStart = input.subscription.trial_start === null ||
      input.subscription.trial_start === undefined
    ? null
    : input.subscription.trial_start * 1000;
  const trialEnd = input.subscription.trial_end === null ||
      input.subscription.trial_end === undefined
    ? null
    : input.subscription.trial_end * 1000;
  const projection = projectStripeEntitlement({
    stripeStatus: input.subscription.status,
    cancelAtPeriodEnd: input.subscription.cancel_at_period_end,
    cancelAt: input.subscription.cancel_at === null ? null : input.subscription.cancel_at * 1000,
    trialEnd,
    serviceUntil,
    graceUntil,
  }, now);
  const endedAtSeconds = input.subscription.ended_at ?? input.subscription.canceled_at ?? null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(customer.user_id)
    .first<UserRow>();
  if (!user) throw new BillingEventError("unknown_user");
  const compatibilityPlan = projection.accessUntil !== null && projection.accessUntil > now
    ? "paid"
    : "free";

  const statements = [
    env.DB.prepare(
      `INSERT INTO stripe_subscriptions
         (stripe_subscription_id, user_id, stripe_customer_id, price_id, plan,
          stripe_status, cancel_at_period_end, cancel_at, trial_start, trial_end,
          service_until, grace_until,
          ended_at, last_paid_invoice_id, last_event_created, last_synced_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stripe_subscription_id) DO UPDATE SET
         stripe_status = CASE
           WHEN excluded.last_event_created >= stripe_subscriptions.last_event_created
             THEN excluded.stripe_status ELSE stripe_subscriptions.stripe_status END,
         cancel_at_period_end = CASE
           WHEN excluded.last_event_created >= stripe_subscriptions.last_event_created
             THEN excluded.cancel_at_period_end ELSE stripe_subscriptions.cancel_at_period_end END,
         cancel_at = CASE
           WHEN excluded.last_event_created >= stripe_subscriptions.last_event_created
             THEN excluded.cancel_at ELSE stripe_subscriptions.cancel_at END,
         trial_start = CASE
           WHEN excluded.last_event_created >= stripe_subscriptions.last_event_created
             THEN excluded.trial_start ELSE stripe_subscriptions.trial_start END,
         trial_end = CASE
           WHEN excluded.last_event_created >= stripe_subscriptions.last_event_created
             THEN excluded.trial_end ELSE stripe_subscriptions.trial_end END,
         service_until = CASE
           WHEN COALESCE(excluded.service_until, 0) > COALESCE(stripe_subscriptions.service_until, 0)
             THEN excluded.service_until ELSE stripe_subscriptions.service_until END,
         grace_until = CASE
           WHEN COALESCE(excluded.grace_until, 0) > COALESCE(stripe_subscriptions.grace_until, 0)
             THEN excluded.grace_until ELSE stripe_subscriptions.grace_until END,
         ended_at = CASE
           WHEN excluded.last_event_created >= stripe_subscriptions.last_event_created
             THEN excluded.ended_at ELSE stripe_subscriptions.ended_at END,
         last_paid_invoice_id = CASE
           WHEN excluded.last_paid_invoice_id IS NOT NULL
             THEN excluded.last_paid_invoice_id ELSE stripe_subscriptions.last_paid_invoice_id END,
         last_event_created = MAX(stripe_subscriptions.last_event_created, excluded.last_event_created),
         last_synced_at = excluded.last_synced_at,
         updated_at = excluded.updated_at`,
    ).bind(
      input.subscription.id,
      customer.user_id,
      stripeCustomerId,
      item.price.id,
      input.subscription.status,
      input.subscription.cancel_at_period_end ? 1 : 0,
      input.subscription.cancel_at === null ? null : input.subscription.cancel_at * 1000,
      trialStart,
      trialEnd,
      serviceUntil,
      graceUntil,
      endedAtSeconds === null ? null : endedAtSeconds * 1000,
      paidInvoice ? invoice?.id ?? null : existing?.last_paid_invoice_id ?? null,
      input.eventCreated,
      now,
      now,
      now,
    ),
  ];
  if (trialStart !== null) {
    statements.push(env.DB.prepare(
      `UPDATE stripe_customers
       SET trial_used_at = COALESCE(trial_used_at, ?), updated_at = ?
       WHERE user_id = ? AND stripe_customer_id = ?`,
    ).bind(trialStart, now, customer.user_id, stripeCustomerId));
  }
  if (authoritativeSubscription) {
    statements.push(env.DB.prepare(
      `INSERT INTO account_entitlements
         (user_id, plan, source, state, trial_until, service_until, grace_until,
          source_ref, updated_at)
       VALUES (?, 'paid', 'stripe', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan = excluded.plan, source = excluded.source, state = excluded.state,
         trial_until = excluded.trial_until,
         service_until = CASE
           WHEN COALESCE(excluded.service_until, 0) > COALESCE(account_entitlements.service_until, 0)
             THEN excluded.service_until ELSE account_entitlements.service_until END,
         grace_until = CASE
           WHEN COALESCE(excluded.grace_until, 0) > COALESCE(account_entitlements.grace_until, 0)
             THEN excluded.grace_until ELSE account_entitlements.grace_until END,
         source_ref = excluded.source_ref, updated_at = excluded.updated_at
       WHERE account_entitlements.source <> 'manual'`,
    ).bind(
      customer.user_id,
      projection.state,
      trialEnd,
      serviceUntil,
      graceUntil,
      input.subscription.id,
      now,
    ));
    statements.push(env.DB.prepare(
      `UPDATE users SET subscription_status = ?, updated_at = ?
       WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM account_entitlements e
         WHERE e.user_id = users.id AND e.source = 'manual'
       )`,
    ).bind(compatibilityPlan, now, customer.user_id));
  }
  if (input.eventType === "checkout.session.completed") {
    const session = input.object as unknown as StripeCheckoutSession;
    if (
      session.client_reference_id !== null &&
      session.client_reference_id !== undefined &&
      session.client_reference_id !== customer.user_id
    ) {
      throw new BillingEventError("checkout_user_mismatch");
    }
    if (customerId(session.customer) !== stripeCustomerId) {
      throw new BillingEventError("checkout_customer_mismatch");
    }
    statements.push(env.DB.prepare(
      `UPDATE stripe_checkout_attempts
       SET status = 'complete', updated_at = ?
       WHERE user_id = ? AND stripe_checkout_session_id = ?
         AND status IN ('creating','open')`,
    ).bind(now, customer.user_id, session.id));
  }
  const noticeId = `billing:${input.eventId ?? `${input.eventType}:${input.subscription.id}:${input.eventCreated}`}`;
  if (
    authoritativeSubscription && input.eventType === "customer.subscription.trial_will_end" &&
    projection.state === "trialing" && trialEnd !== null
  ) {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Paid trial ends soon",
      message: `Your Paid trial ends ${deadlineLabel(trialEnd)}. Stripe will then charge your saved payment method. Use Manage billing to update payment details or cancel.`,
      severity: "warning",
      createdAt: now,
    }));
  } else if (authoritativeSubscription && projection.state === "trialing" && trialEnd !== null) {
    statements.push(billingNoticeStatement(env, {
      id: `billing:trial-start:${input.subscription.id}:${trialEnd}`,
      userId: customer.user_id,
      title: "Paid trial started",
      message: `Your ${PAID_TRIAL_DAYS}-day Paid trial is active through ${deadlineLabel(trialEnd)}. Stripe will charge your payment method after the trial.`,
      severity: "info",
      createdAt: now,
    }));
  } else if (
    authoritativeSubscription && projection.state === "expired" && trialEnd !== null &&
    serviceUntil === null && (
      input.subscription.status === "canceled" || input.subscription.cancel_at_period_end ||
      input.subscription.cancel_at !== null
    )
  ) {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Paid trial canceled",
      message: hasPermanentFreeEligibility(user)
        ? "Your Paid trial was canceled. Your workbench is returning to the Free resource limits without deleting your files."
        : "Your Paid trial was canceled. Your workbench will be suspended until you resubscribe or complete Free verification.",
      severity: "warning",
      createdAt: now,
    }));
  } else if (authoritativeSubscription && paidInvoice && serviceUntil !== null) {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Payment confirmed",
      message: `Your Paid plan is active through ${deadlineLabel(serviceUntil)}.`,
      severity: "info",
      createdAt: now,
    }));
  } else if (authoritativeSubscription && input.eventType === "invoice.payment_failed") {
    const accessMessage = graceUntil !== null && graceUntil > (serviceUntil ?? 0)
      ? ` Access is available through the grace deadline ${deadlineLabel(graceUntil)}.`
      : serviceUntil !== null
      ? ` Already-paid service remains available through ${deadlineLabel(serviceUntil)}.`
      : " Paid trial access has ended.";
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Payment needs attention",
      message: `Stripe could not collect your subscription payment.${accessMessage} Use Manage billing to resolve it.`,
      severity: "warning",
      createdAt: now,
    }));
  } else if (authoritativeSubscription && input.eventType === "invoice.payment_action_required") {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Payment action required",
      message: "Your bank requires an additional payment step. Use Manage billing to complete it.",
      severity: "warning",
      createdAt: now,
    }));
  } else if (authoritativeSubscription && input.eventType === "invoice.finalization_failed") {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Invoice needs attention",
      message: "Stripe could not finalize your subscription invoice. Use Manage billing to review the requested billing details.",
      severity: "warning",
      createdAt: now,
    }));
  } else if (authoritativeSubscription && input.eventType === "customer.subscription.deleted" && serviceUntil !== null &&
      serviceUntil > now) {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Paid plan ending",
      message: `Your Paid plan remains available through ${deadlineLabel(serviceUntil)}.`,
      severity: "warning",
      createdAt: now,
    }));
  } else if (authoritativeSubscription && input.subscription.cancel_at_period_end && serviceUntil !== null) {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Cancellation scheduled",
      message: `Your Paid plan remains active through ${deadlineLabel(serviceUntil)}. You can undo cancellation from Manage billing before it ends.`,
      severity: "warning",
      createdAt: now,
    }));
  } else if (
    authoritativeSubscription && existing?.cancel_at_period_end &&
    !input.subscription.cancel_at_period_end &&
    serviceUntil !== null
  ) {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Cancellation reversed",
      message: `Your Paid plan will continue. The current paid period ends ${deadlineLabel(serviceUntil)}.`,
      severity: "info",
      createdAt: now,
    }));
  }
  await env.DB.batch(statements);
  if (
    authoritativeSubscription && existingEntitlement?.source !== "manual" &&
    projection.accessUntil !== null && projection.accessUntil > now
  ) {
    await restoreBillingSuspendedContainer(env, customer.user_id);
    await requestPaidUpgrade(env, customer.user_id, now);
  } else if (authoritativeSubscription && existingEntitlement?.source !== "manual") {
    await enforceEndedPaidAccess(env, user, now);
  }
  if (input.eventId !== null) {
    await env.DB.prepare(
      `UPDATE stripe_billing_events
       SET status = 'processed', object_id = ?, subscription_id = ?, processed_at = ?
       WHERE event_id = ? AND status = 'processing'`,
    ).bind(objectId(input.object), input.subscription.id, now, input.eventId).run();
  }
  return customer.user_id;
}

export async function processBillingEventMessage(
  env: Bindings,
  message: BillingEventMessage,
): Promise<void> {
  if (!/^evt_[A-Za-z0-9_]+$/.test(message.eventId)) {
    throw new BillingEventError("invalid_event_id");
  }
  const claim = await claimBillingEvent(env, message);
  if (claim === "processed") return;
  if (claim === "busy") throw new BillingEventError("event_processing");
  try {
    const event = await retrieveStripeEvent(env, message.eventId);
    if (event.type !== message.eventType || event.created !== message.eventCreated) {
      throw new BillingEventError("event_metadata_mismatch");
    }
    if (event.api_version !== undefined && event.api_version !== null &&
        event.api_version !== STRIPE_API_VERSION) {
      throw new BillingEventError("event_api_version_mismatch");
    }
    if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
      await markNonSubscriptionEvent(env, event.id, event.data.object);
      return;
    }
    if (event.type === "checkout.session.expired") {
      const sessionId = objectId(event.data.object);
      if (!sessionId) throw new BillingEventError("checkout_missing_id");
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE stripe_checkout_attempts SET status = 'expired', updated_at = ?
           WHERE stripe_checkout_session_id = ? AND status IN ('creating','open')`,
        ).bind(Date.now(), sessionId),
        env.DB.prepare(
          `UPDATE stripe_billing_events
           SET status = 'processed', object_id = ?, processed_at = ?
           WHERE event_id = ? AND status = 'processing'`,
        ).bind(sessionId, Date.now(), event.id),
      ]);
      return;
    }
    if (event.type === "charge.dispute.created" || event.type === "charge.refunded") {
      await processBillingRiskEvent(env, event);
      return;
    }
    const subscriptionId = relatedSubscriptionId(event.type, event.data.object);
    if (!subscriptionId) {
      // Non-subscription invoice anomalies are support signals, not implicit
      // authorization mutations.
      if (event.type === "invoice.finalization_failed") {
        console.warn(JSON.stringify({ event: "billing_operator_alert", type: event.type, eventId: event.id }));
        await markNonSubscriptionEvent(env, event.id, event.data.object);
        return;
      }
      throw new BillingEventError("missing_subscription_reference");
    }
    await env.DB.prepare(
      `UPDATE stripe_billing_events SET subscription_id = ?
       WHERE event_id = ? AND status = 'processing'`,
    ).bind(subscriptionId, event.id).run();
    const subscription = await retrieveStripeSubscription(env, subscriptionId);
    if (subscription.id !== subscriptionId) {
      throw new BillingEventError("subscription_id_mismatch");
    }
    if (event.type.startsWith("invoice.") &&
        relatedSubscriptionId(event.type, event.data.object) !== subscription.id) {
      throw new BillingEventError("invoice_subscription_mismatch");
    }
    await applyCanonicalSubscription(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
      object: event.data.object,
      subscription,
    });
  } catch (error) {
    await markEventFailed(env, message.eventId, error);
    throw error;
  }
}

export async function processBillingQueue(
  batch: BillingQueueBatch,
  env: Bindings,
): Promise<void> {
  await Promise.all(batch.messages.map(async (message) => {
    try {
      await processBillingEventMessage(env, message.body);
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({
        event: "billing_event_failed",
        eventId: message.body.eventId,
        error: error instanceof BillingEventError ? error.code : "processing_error",
      }));
      message.retry();
    }
  }));
}

function configuredExportWindowMs(env: Bindings): number {
  const raw = env.BILLING_EXPORT_WINDOW_DAYS?.trim();
  if (!raw) return 0;
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? Math.floor(days * 86_400_000) : 0;
}

async function publishSuspensionNotices(
  env: Bindings,
  userId: string,
  at: number,
  destroyAfter: number | null,
): Promise<void> {
  await createUserNotification(env, {
    id: `billing:suspended:${userId}:${at}`,
    userId,
    title: "Workbench suspended",
    message: "Paid access ended and your workbench has been stopped. Resubscribe or complete Free verification to restore access.",
    severity: "critical",
    createdAt: at,
  });
  if (destroyAfter !== null) {
    const deadline = deadlineLabel(destroyAfter);
    await createUserNotification(env, {
      id: `billing:export-deadline:${userId}:${destroyAfter}`,
      userId,
      title: "Export deadline",
      message: `Export your files or restore eligibility before ${deadline}.`,
      severity: "critical",
      createdAt: at,
    });
    await createUserNotification(env, {
      id: `billing:destruction-warning:${userId}:${destroyAfter}`,
      userId,
      title: "Workbench deletion scheduled",
      message: `Your suspended workbench is scheduled for deletion after ${deadline}. Restore eligibility before then to cancel deletion.`,
      severity: "critical",
      createdAt: at,
    });
  }
}

async function restoreBillingSuspendedContainer(
  env: Bindings,
  userId: string,
): Promise<void> {
  let container = await getContainerForUser(env, userId);
  if (!container || container.suspension_reason !== "billing") return;
  const activeJob = await env.DB.prepare(
    `SELECT 1 FROM jobs WHERE container_id = ? AND status IN ('queued','running')
       AND op IN ('provision','rebuild','start','stop','destroy','resize') LIMIT 1`,
  ).bind(container.id).first();
  // Keep the billing marker until the in-flight lifecycle job settles. A stop
  // that races renewal must finish as suspended so the next pass can restart
  // the previously running workbench instead of leaving it silently stopped.
  if (activeJob) return;
  if (!container.host_id) {
    await env.DB.prepare(
      `UPDATE containers SET status = 'waitlisted', status_detail = 'waiting for capacity',
         suspension_reason = NULL, billing_suspended_at = NULL, destroy_after = NULL,
         suspended_at = NULL
       WHERE id = ? AND suspension_reason = 'billing' AND host_id IS NULL`,
    ).bind(container.id).run();
    return;
  }
  if (container.status !== "suspended" && container.status !== "stopped") {
    await env.DB.prepare(
      `UPDATE containers
       SET suspension_reason = NULL, billing_suspended_at = NULL,
           destroy_after = NULL, suspended_at = NULL
       WHERE id = ? AND suspension_reason = 'billing'`,
    ).bind(container.id).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE containers SET status = 'stopped', status_detail = NULL,
       suspension_reason = NULL, billing_suspended_at = NULL,
       destroy_after = NULL, suspended_at = NULL
     WHERE id = ? AND suspension_reason = 'billing'
       AND status IN ('suspended','stopped')`,
  ).bind(container.id).run();
  container = (await getContainerForUser(env, userId)) ?? container;
  if (!container.host_id) return;
  const host = await getHost(env, container.host_id);
  if (host?.status === "active") await enqueueJob(env, "start", container, host);
}

async function suspendContainerForBilling(
  env: Bindings,
  userId: string,
  at: number,
): Promise<void> {
  let container = await getContainerForUser(env, userId);
  if (!container || container.status === "destroying") return;
  if (!container.host_id) {
    if (container.status !== "waitlisted" && container.status !== "suspended") return;
    await env.DB.prepare(
      `UPDATE containers SET status = 'suspended', status_detail = 'paid access ended',
         suspended_at = ?, suspension_reason = 'billing', billing_suspended_at = ?,
         destroy_after = NULL
       WHERE id = ? AND host_id IS NULL AND status IN ('waitlisted','suspended')`,
    ).bind(at, at, container.id).run();
    await publishSuspensionNotices(env, userId, at, null);
    return;
  }
  if (container.status === "upgrade_pending") {
    await cancelUnreservedPlanTransition(env, container.id, at);
    container = (await getContainerForUser(env, userId)) ?? container;
  }
  const exportWindowMs = configuredExportWindowMs(env);
  const destroyAfter = exportWindowMs > 0 ? at + exportWindowMs : null;
  if (container.status === "stopped" || container.status === "suspended") {
    await env.DB.prepare(
      `UPDATE containers SET status = 'suspended', status_detail = 'paid access ended',
         suspended_at = ?, suspension_reason = 'billing', billing_suspended_at = ?,
         destroy_after = ?
       WHERE id = ?`,
    ).bind(at, at, destroyAfter, container.id).run();
    await publishSuspensionNotices(env, userId, at, destroyAfter);
    return;
  }
  await env.DB.prepare(
    `UPDATE containers
     SET suspension_reason = 'billing', billing_suspended_at = ?, destroy_after = ?,
         status_detail = 'paid access ended; stopping workbench'
     WHERE id = ? AND status IN ('running','error','upgrade_pending')`,
  ).bind(at, destroyAfter, container.id).run();
  await publishSuspensionNotices(env, userId, at, destroyAfter);
  container = (await getContainerForUser(env, userId)) ?? container;
  if (!["running", "upgrade_pending", "error"].includes(container.status) || !container.host_id) return;
  const host = await getHost(env, container.host_id);
  if (host?.status !== "active") return;
  try {
    await enqueueJob(env, "stop", container, host);
  } catch (error) {
    // An active resize finishes or fails before the next reconciliation pass.
    // Keep the billing marker and retry the stop without racing that job.
    if (error instanceof LifecycleJobConflictError || error instanceof HostJobAdmissionError) return;
    throw error;
  }
}

async function enforceEndedPaidAccess(
  env: Bindings,
  user: UserRow,
  at: number,
): Promise<void> {
  const container = await getContainerForUser(env, user.id);
  if (hasPermanentFreeEligibility(user)) {
    if (container?.status === "waitlisted" && !container.host_id && container.tier === "paid") {
      const free = TIERS.free;
      const placement = SERVICE_PLANS.free;
      await env.DB.prepare(
        `UPDATE containers
         SET tier = 'free', placement_class = ?, placement_mode = ?, cpu = ?, ram_mb = ?,
             disk_gb = ?, storage_grandfathered = 0,
             status_detail = 'waiting for Free capacity'
         WHERE id = ? AND status = 'waitlisted' AND host_id IS NULL AND tier = 'paid'`,
      ).bind(
        placement.hostType,
        placement.tenancyMode,
        free.cpu,
        free.ramMb,
        free.diskGb,
        container.id,
      ).run();
      return;
    }
    if (container?.status === "upgrade_pending") {
      await cancelUnreservedPlanTransition(env, container.id, at);
    }
    if (container?.tier === "paid") await requestPlanTransition(env, user.id, "free", at);
    return;
  }
  await suspendContainerForBilling(env, user.id, at);
}

/** Enforce paid-through deadlines locally even if deletion webhooks are late. */
export async function reconcileBillingState(
  env: Bindings,
  at = Date.now(),
): Promise<void> {
  const subscriptions = await env.DB.prepare(
    `SELECT s.*, u.id AS account_id
     FROM stripe_subscriptions s
     JOIN users u ON u.id = s.user_id
     JOIN account_entitlements e ON e.user_id = s.user_id AND e.source = 'stripe'
       AND e.source_ref = s.stripe_subscription_id
     WHERE u.status = 'active'
     ORDER BY s.last_synced_at, s.user_id
     LIMIT 50`,
  ).all<StripeSubscriptionRow & { account_id: string }>();

  for (const subscription of subscriptions.results) {
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(subscription.user_id)
      .first<UserRow>();
    if (!user) continue;
    const projected = projectStripeEntitlement({
      stripeStatus: subscription.stripe_status,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      cancelAt: subscription.cancel_at,
      trialEnd: subscription.trial_end,
      serviceUntil: subscription.service_until,
      graceUntil: subscription.grace_until,
    }, at);
    const reconciliationStatements = [
      env.DB.prepare(
        `UPDATE account_entitlements
         SET state = ?, trial_until = ?, service_until = ?, grace_until = ?, updated_at = ?
         WHERE user_id = ? AND source = 'stripe'`,
      ).bind(
        projected.state,
        subscription.trial_end,
        subscription.service_until,
        subscription.grace_until,
        at,
        user.id,
      ),
      env.DB.prepare(
        `UPDATE users SET subscription_status = ?, updated_at = ?
         WHERE id = ? AND NOT EXISTS (
           SELECT 1 FROM account_entitlements e
           WHERE e.user_id = users.id AND e.source = 'manual'
         )`,
      ).bind(projected.accessUntil !== null && projected.accessUntil > at ? "paid" : "free", at, user.id),
    ];
    const priorEntitlement = await accountEntitlement(env, user.id);
    if (priorEntitlement?.state !== projected.state && projected.state === "grace" && subscription.grace_until) {
      reconciliationStatements.push(billingNoticeStatement(env, {
        id: `billing:grace-start:${subscription.stripe_subscription_id}:${subscription.grace_until}`,
        userId: user.id,
        title: "Payment grace period started",
        message: `Restore payment before ${deadlineLabel(subscription.grace_until)} to avoid suspension or a Free-plan downgrade.`,
        severity: "critical",
        createdAt: at,
      }));
    }
    if (priorEntitlement?.state !== projected.state && projected.state === "expired") {
      reconciliationStatements.push(billingNoticeStatement(env, {
        id: `billing:access-expired:${subscription.stripe_subscription_id}:${subscription.service_until ?? at}`,
        userId: user.id,
        title: "Paid access ended",
        message: hasPermanentFreeEligibility(user)
          ? "Your Paid plan ended. Your workbench is returning to the Free resource limits without deleting your files."
          : "Your Paid plan and any grace period ended. Your workbench will be suspended until you resubscribe or complete Free verification.",
        severity: "critical",
        createdAt: at,
      }));
    }
    await env.DB.batch(reconciliationStatements);

    if (projected.accessUntil !== null && projected.accessUntil > at) {
      await restoreBillingSuspendedContainer(env, user.id);
      await requestPaidUpgrade(env, user.id, at);
      continue;
    }
    await enforceEndedPaidAccess(env, user, at);
  }
}

/** Bounded canonical refresh repairs missed status and paid-invoice webhooks. */
export async function reconcileStaleStripeSubscriptions(
  env: Bindings,
  at = Date.now(),
): Promise<void> {
  if (!env.STRIPE_SECRET_KEY?.trim() || !env.STRIPE_PRICE_PAID_MONTHLY?.trim()) return;
  const stale = await env.DB.prepare(
    `SELECT * FROM stripe_subscriptions
     WHERE stripe_status NOT IN ('canceled','incomplete_expired')
       AND last_synced_at <= ?
     ORDER BY last_synced_at, stripe_subscription_id
     LIMIT 10`,
  ).bind(at - 6 * 60 * 60 * 1000).all<StripeSubscriptionRow>();
  for (const row of stale.results) {
    const subscription = await retrieveStripeSubscription(env, row.stripe_subscription_id);
    const latestInvoice = subscription.latest_invoice;
    const invoiceId = typeof latestInvoice === "string" ? latestInvoice : latestInvoice?.id ?? null;
    let invoice: StripeInvoice | null = null;
    if (invoiceId) invoice = await retrieveStripeInvoice(env, invoiceId);
    const paidInvoice = invoice?.paid === true || invoice?.status === "paid";
    await applyCanonicalSubscription(env, {
      eventId: null,
      eventType: paidInvoice ? "invoice.paid" : "customer.subscription.updated",
      eventCreated: Math.floor(at / 1000),
      object: (invoice ?? subscription) as unknown as Record<string, unknown>,
      subscription,
    });
  }
}

export async function destroyExpiredBillingSuspensions(
  env: Bindings,
  at = Date.now(),
): Promise<void> {
  const expired = await env.DB.prepare(
    `SELECT user_id FROM containers
     WHERE status = 'suspended' AND suspension_reason = 'billing'
       AND destroy_after IS NOT NULL AND destroy_after <= ?
     ORDER BY destroy_after LIMIT 20`,
  ).bind(at).all<{ user_id: string }>();
  for (const row of expired.results) {
    const container = await getContainerForUser(env, row.user_id);
    if (!container?.host_id || container.destroy_after === null || container.destroy_after > at) continue;
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'")
      .bind(row.user_id).first<UserRow>();
    if (user && (await effectiveEntitlementForUser(env, user, at)).eligible) {
      await restoreBillingSuspendedContainer(env, row.user_id);
      continue;
    }
    const host = await getHost(env, container.host_id);
    if (host?.status === "active") await enqueueJob(env, "destroy", container, host);
  }
}
