import { SERVICE_PLANS, TIERS } from "@workbench/contract";
import { configuredExportWindowMs, configuredGraceMs } from "./billing-config.js";
import { BillingEventError } from "./billing-errors.js";
import {
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
  parseStripeCheckoutEvent,
  parseStripeInvoice,
  paidPriceId,
  retrieveStripeCharge,
  retrieveStripeEvent,
  retrieveStripeInvoice,
  retrieveStripeSubscription,
  stripeEntityId,
  PAID_TRIAL_DAYS,
  STRIPE_API_VERSION,
  StripeApiError,
  type StripeCharge,
  type StripeInvoice,
  type StripeSubscription,
} from "./stripe.js";
import type {
  BillingEventMessage,
  Bindings,
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

function objectId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return stripeEntityId(value);
}

function relatedSubscriptionId(eventType: string, object: unknown): string | null {
  if (eventType.startsWith("customer.subscription.")) return objectId(object);
  if (eventType === "checkout.session.completed") {
    return stripeEntityId(parseStripeCheckoutEvent(object).subscription);
  }
  if (eventType.startsWith("invoice.")) {
    const invoice = parseStripeInvoice(object);
    const parentSubscription = invoice.parent?.type === "subscription_details"
      ? invoice.parent.subscription_details?.subscription
      : null;
    return stripeEntityId(parentSubscription ?? invoice.subscription);
  }
  return null;
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
  object: unknown,
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
  const subscriptionId = relatedSubscriptionId("invoice.paid", invoice);
  if (!subscriptionId) throw new BillingEventError("risk_event_missing_subscription");
  const subscription = await retrieveStripeSubscription(env, subscriptionId);
  const customer = await validatedSubscriptionOwner(env, subscription);
  const stripeCustomerId = stripeEntityId(charge.customer);
  if (
    stripeCustomerId !== customer.stripe_customer_id ||
    stripeEntityId(invoice.customer) !== customer.stripe_customer_id
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
  const stripeCustomerId = stripeEntityId(subscription.customer);
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
    object: unknown;
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
    ? parseStripeInvoice(input.object)
    : null;
  if (invoice && stripeEntityId(invoice.customer) !== stripeCustomerId) {
    throw new BillingEventError("invoice_customer_mismatch");
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
  const graceMs = configuredGraceMs(env);
  const graceUntil = input.eventType === "invoice.payment_failed" && serviceUntil !== null &&
      graceMs > 0
    ? serviceUntil + graceMs
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
    const session = parseStripeCheckoutEvent(input.object);
    if (
      session.client_reference_id !== null &&
      session.client_reference_id !== undefined &&
      session.client_reference_id !== customer.user_id
    ) {
      throw new BillingEventError("checkout_user_mismatch");
    }
    if (stripeEntityId(session.customer) !== stripeCustomerId) {
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
      message: `Your Paid trial ends ${deadlineLabel(trialEnd)}. Stripe will then charge your saved payment method. Use Manage billing to update payment details or cancel. If access ends, save active work first: the workbench will stop, but persistent files will be retained.`,
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
        ? "Your Paid trial was canceled. Your workbench will stop before returning to Free resource limits. Unsaved progress may be lost, but persistent files will be retained."
        : "Your Paid trial was canceled. Your workbench will stop and remain suspended until you resubscribe or complete Free verification. Unsaved progress may be lost, but persistent files will be retained.",
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
      message: `Your Paid plan remains available through ${deadlineLabel(serviceUntil)}. At that deadline the workbench will stop before its machine limits change. Save active work first; persistent files will be retained.`,
      severity: "warning",
      createdAt: now,
    }));
  } else if (authoritativeSubscription && input.subscription.cancel_at_period_end && serviceUntil !== null) {
    statements.push(billingNoticeStatement(env, {
      id: noticeId,
      userId: customer.user_id,
      title: "Cancellation scheduled",
      message: `Your Paid plan remains active through ${deadlineLabel(serviceUntil)}. You can undo cancellation from Manage billing before it ends. Otherwise the workbench will stop at the deadline; save active work first. Persistent files will be retained.`,
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
  batch: MessageBatch<BillingEventMessage>,
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
    message: "Paid access ended and your workbench is being stopped. Unsaved progress may be lost, but persistent files are retained. Resubscribe or complete Free verification to restore access.",
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
        message: `Restore payment before ${deadlineLabel(subscription.grace_until)} to avoid suspension or a Free-plan downgrade. Otherwise the workbench will stop at the deadline; save active work first. Persistent files will be retained.`,
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
          ? "Your Paid plan ended. Your workbench will stop before returning to Free resource limits. Unsaved progress may be lost, but persistent files will be retained."
          : "Your Paid plan and any grace period ended. Your workbench will stop and remain suspended until you resubscribe or complete Free verification. Unsaved progress may be lost, but persistent files will be retained.",
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
      object: invoice ?? subscription,
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
