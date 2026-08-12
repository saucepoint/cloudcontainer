import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  processBillingEventMessage,
  reconcileBillingState,
} from "../src/billing.js";
import { billingRoutes } from "../src/billing-routes.js";
import {
  effectiveEntitlement,
  projectStripeEntitlement,
} from "../src/entitlements.js";
import type {
  AccountEntitlementRow,
  AppContext,
  BillingEventMessage,
  Bindings,
  UserRow,
} from "../src/types.js";
import {
  createTestSession,
  fakeDaemon,
  makeEnv,
  seedContainer,
  seedHost,
  seedUser,
  stubFetch,
} from "./helpers/env.js";

const BILLING_CONFIG = {
  BILLING_ENABLED: "1",
  STRIPE_SECRET_KEY: "sk_test_local",
  STRIPE_WEBHOOK_SECRET: "whsec_local",
  STRIPE_PRICE_PAID_MONTHLY: "price_paid_monthly",
  PAID_PLAN_MONTHLY_PRICE: "20.00",
  PAID_PLAN_CURRENCY: "USD",
  STRIPE_TAX_ENABLED: "0",
  BILLING_EVENTS: { send: async () => {} },
} satisfies Partial<Bindings>;

function app() {
  return new Hono<AppContext>().route("/", billingRoutes);
}

async function unverifiedUser(env: Bindings, id = "user-1") {
  await seedUser(env, id);
  await env.DB.prepare(
    "UPDATE users SET verified_at = NULL, verification_method = NULL WHERE id = ?",
  ).bind(id).run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(id).first<UserRow>();
  if (!user) throw new Error("user vanished");
  return { user, cookie: await createTestSession(env, id) };
}

function subscription(
  periodEnd: number,
  status = "active",
  trial: { start: number; end: number } | null = null,
) {
  return {
    id: "sub_paid",
    customer: "cus_user",
    status,
    cancel_at_period_end: false,
    cancel_at: null,
    trial_start: trial?.start ?? null,
    trial_end: trial?.end ?? null,
    ended_at: null,
    metadata: { userId: "user-1", plan: "paid" },
    items: {
      data: [{
        id: "si_paid",
        current_period_end: periodEnd,
        price: { id: "price_paid_monthly" },
        quantity: 1,
      }],
      has_more: false,
    },
  };
}

function paidPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: "price_paid_monthly",
    active: true,
    livemode: false,
    currency: "usd",
    type: "recurring",
    unit_amount: 2_000,
    tax_behavior: "exclusive",
    billing_scheme: "per_unit",
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    product: { id: "prod_paid", active: true, tax_code: "txcd_10103000" },
    ...overrides,
  };
}

function invoiceEvent(
  id: string,
  created: number,
  type = "invoice.paid",
  invoiceId = "in_paid",
) {
  return {
    id,
    type,
    created,
    data: {
      object: {
        id: invoiceId,
        customer: "cus_user",
        paid: type === "invoice.paid",
        amount_paid: type === "invoice.paid" ? 2_000 : 0,
        status: type === "invoice.paid" ? "paid" : "open",
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: "sub_paid" },
        },
      },
    },
  };
}

async function seedStripeCustomer(env: Bindings): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stripe_customers
       (user_id, stripe_customer_id, created_at, updated_at)
     VALUES ('user-1', 'cus_user', 1, 1)`,
  ).run();
}

async function seedExpiredStripeSubscription(env: Bindings): Promise<void> {
  await seedStripeCustomer(env);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stripe_subscriptions
         (stripe_subscription_id, user_id, stripe_customer_id, price_id, plan,
          stripe_status, cancel_at_period_end, service_until, last_event_created,
          last_synced_at, created_at, updated_at)
       VALUES ('sub_paid', 'user-1', 'cus_user', 'price_paid_monthly', 'paid',
               'canceled', 0, 100, 1, 1, 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO account_entitlements
         (user_id, plan, source, state, service_until, source_ref, updated_at)
       VALUES ('user-1', 'paid', 'stripe', 'active', 100, 'sub_paid', 1)`,
    ),
  ]);
}

function stripeEventRoutes(events: Record<string, unknown>, subscriptions: Record<string, unknown>) {
  return (url: URL) => {
    const eventId = url.pathname.match(/^\/v1\/events\/(.+)$/)?.[1];
    if (eventId && events[eventId]) return Response.json(events[eventId]);
    const subscriptionId = url.pathname.match(/^\/v1\/subscriptions\/(.+)$/)?.[1];
    if (subscriptionId && subscriptions[subscriptionId]) {
      return Response.json(subscriptions[subscriptionId]);
    }
    return null;
  };
}

async function signature(rawBody: string, secret: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  ));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("entitlement projection", () => {
  const user = {
    id: "user-1",
    name: "Test",
    email: "test@example.test",
    email_verified: 1,
    image: null,
    status: "active",
    subscription_status: "free",
    verified_at: null,
    verification_method: null,
    created_at: 1,
    updated_at: 1,
  } satisfies UserRow;

  it("keeps paid bypass independent from permanent free eligibility", () => {
    const entitlement = {
      user_id: user.id,
      plan: "paid",
      source: "stripe",
      state: "active",
      trial_until: null,
      service_until: 2_000,
      grace_until: null,
      source_ref: "sub_paid",
      updated_at: 1,
    } satisfies AccountEntitlementRow;
    expect(effectiveEntitlement(user, entitlement, 1_999)).toMatchObject({
      eligible: true,
      plan: "paid",
      source: "stripe",
    });
    expect(effectiveEntitlement(user, entitlement, 2_000)).toMatchObject({
      eligible: false,
      plan: null,
    });
    expect(effectiveEntitlement({
      ...user,
      verified_at: 1,
      verification_method: "invite",
    }, entitlement, 2_000)).toMatchObject({
      eligible: true,
      plan: "free",
      source: "invite",
    });
  });

  it("separates scheduled cancellation, payment failure, grace, and expiry", () => {
    expect(projectStripeEntitlement({
      stripeStatus: "incomplete",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      trialEnd: null,
      serviceUntil: 2_000,
      graceUntil: null,
    }, 1_000)).toEqual({ state: "pending", accessUntil: null });
    expect(projectStripeEntitlement({
      stripeStatus: "trialing",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      trialEnd: 2_000,
      serviceUntil: null,
      graceUntil: null,
    }, 1_000)).toEqual({ state: "trialing", accessUntil: 2_000 });
    expect(projectStripeEntitlement({
      stripeStatus: "active",
      cancelAtPeriodEnd: true,
      cancelAt: 2_000,
      trialEnd: null,
      serviceUntil: 2_000,
      graceUntil: null,
    }, 1_000)).toEqual({ state: "cancel_scheduled", accessUntil: 2_000 });
    expect(projectStripeEntitlement({
      stripeStatus: "past_due",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      trialEnd: null,
      serviceUntil: 2_000,
      graceUntil: 3_000,
    }, 1_500)).toEqual({ state: "past_due", accessUntil: 2_000 });
    expect(projectStripeEntitlement({
      stripeStatus: "past_due",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      trialEnd: null,
      serviceUntil: 2_000,
      graceUntil: 3_000,
    }, 2_500)).toEqual({ state: "grace", accessUntil: 3_000 });
    expect(projectStripeEntitlement({
      stripeStatus: "past_due",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      trialEnd: null,
      serviceUntil: 2_000,
      graceUntil: 3_000,
    }, 3_000)).toEqual({ state: "expired", accessUntil: null });
  });
});

describe("billing routes", () => {
  it("returns the server-configured price disclosure and fails closed without it", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    const { cookie } = await unverifiedUser(env);
    const status = await app().request("/api/billing/status", { headers: { cookie } }, env);
    expect(await status.json()).toMatchObject({
      configured: true,
      trialEligible: true,
      paidPlan: {
        price: "20.00",
        currency: "USD",
        interval: "month",
        trialDays: 7,
        display: "7-day free trial, then $20.00/mo",
      },
    });

    const missingConfig: Partial<Bindings> = { ...BILLING_CONFIG };
    delete missingConfig.PAID_PLAN_MONTHLY_PRICE;
    const missingDisclosure = makeEnv(missingConfig).env;
    const { cookie: missingCookie } = await unverifiedUser(missingDisclosure);
    const disabled = await app().request(
      "/api/billing/status",
      { headers: { cookie: missingCookie } },
      missingDisclosure,
    );
    expect(await disabled.json()).toMatchObject({ configured: false, paidPlan: null });
  });

  it("returns current account access with billing status for post-Checkout refreshes", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    const { cookie } = await unverifiedUser(env);
    await env.DB.prepare(
      `INSERT INTO account_entitlements
         (user_id, plan, source, state, trial_until, source_ref, updated_at)
       VALUES ('user-1', 'paid', 'manual', 'manual', NULL, 'support', ?)`,
    ).bind(Date.now()).run();

    const response = await app().request("/api/billing/status", { headers: { cookie } }, env);

    expect(await response.json()).toMatchObject({
      account: { state: "premium", verified: false, premium: true },
    });
  });

  it("keeps new sales disabled until the operator feature flag is enabled", async () => {
    const { env } = makeEnv({ ...BILLING_CONFIG, BILLING_ENABLED: "0" });
    const { cookie } = await unverifiedUser(env);
    const fetchMock = stubFetch(() => {
      throw new Error("disabled billing must not contact Stripe");
    });

    const response = await app().request("/api/billing/checkout", {
      method: "POST",
      headers: { cookie },
    }, env);
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets an authenticated unverified account start server-priced Checkout", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    const { cookie } = await unverifiedUser(env);
    const requests: Array<{
      path: string;
      body: URLSearchParams;
      idempotency: string | null;
      version: string | null;
    }> = [];
    stubFetch((url, init) => {
      const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      const headers = new Headers(init.headers);
      requests.push({
        path: url.pathname,
        body,
        idempotency: headers.get("idempotency-key"),
        version: headers.get("stripe-version"),
      });
      if (url.pathname === "/v1/prices/price_paid_monthly") {
        return Response.json(paidPrice());
      }
      if (url.pathname === "/v1/customers") {
        return Response.json({ id: "cus_user", metadata: { userId: "user-1" } });
      }
      if (url.pathname === "/v1/subscriptions") {
        return Response.json({ data: [], has_more: false });
      }
      if (url.pathname === "/v1/checkout/sessions") {
        return Response.json({
          id: "cs_checkout",
          url: "https://checkout.stripe.com/c/pay/test",
          customer: "cus_user",
        });
      }
      return null;
    });

    const response = await app().request("/api/billing/checkout", {
      method: "POST",
      headers: { cookie },
    }, env);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/test" });
    expect(requests.find((request) => request.path === "/v1/customers")).toMatchObject({
      path: "/v1/customers",
      idempotency: "customer:user-1",
      version: "2026-07-29.dahlia",
    });
    const firstSession = requests.find((request) => request.path === "/v1/checkout/sessions");
    expect(firstSession?.body.get("line_items[0][price]")).toBe("price_paid_monthly");
    expect(firstSession?.body.get("payment_method_collection")).toBe("always");
    expect(firstSession?.body.get("subscription_data[metadata][userId]")).toBe("user-1");
    expect(firstSession?.body.get("subscription_data[billing_mode][type]")).toBe("flexible");
    expect(firstSession?.body.get(
      "subscription_data[billing_mode][flexible][proration_discounts]",
    )).toBe("itemized");
    expect(firstSession?.body.get("subscription_data[trial_period_days]")).toBe("7");
    expect(firstSession?.body.get(
      "subscription_data[trial_settings][end_behavior][missing_payment_method]",
    )).toBe("cancel");
    expect(firstSession?.body.get("automatic_tax[enabled]")).toBe("false");
    expect(Number(firstSession?.body.get("expires_at"))).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 30 * 60,
    );
    expect(firstSession?.idempotency).toMatch(/^checkout:/);
    expect(await env.DB.prepare("SELECT * FROM account_entitlements").all())
      .toMatchObject({ results: [] });

    const secondCheckout = await app().request("/api/billing/checkout", {
      method: "POST",
      headers: { cookie },
    }, env);
    expect(secondCheckout.status).toBe(200);
    expect(await secondCheckout.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/test" });
    const sessions = requests.filter((request) => request.path === "/v1/checkout/sessions");
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.idempotency).toBe(sessions[0]?.idempotency);
    expect(await env.DB.prepare(
      "SELECT status, COUNT(*) AS count FROM stripe_checkout_attempts GROUP BY status",
    ).first()).toEqual({ status: "open", count: 1 });
  });

  it("fails closed when the Stripe Price differs from the published offer", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    const { cookie } = await unverifiedUser(env);
    const fetch = stubFetch((url) => {
      if (url.pathname === "/v1/prices/price_paid_monthly") {
        return Response.json(paidPrice({ unit_amount: 2_100 }));
      }
      throw new Error("mismatched pricing must stop before creating Stripe objects");
    });

    const response = await app().request("/api/billing/checkout", {
      method: "POST",
      headers: { cookie },
    }, env);

    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM stripe_customers").first())
      .toEqual({ count: 0 });
  });

  it("collects tax addresses and never repeats an account's used trial", async () => {
    const { env } = makeEnv({ ...BILLING_CONFIG, STRIPE_TAX_ENABLED: "1" });
    const { cookie } = await unverifiedUser(env);
    await seedStripeCustomer(env);
    await env.DB.prepare(
      "UPDATE stripe_customers SET trial_used_at = 1 WHERE user_id = 'user-1'",
    ).run();
    const status = await app().request("/api/billing/status", { headers: { cookie } }, env);
    expect(await status.json()).toMatchObject({ trialEligible: false });
    let checkoutBody: URLSearchParams | undefined;
    stubFetch((url, init) => {
      if (url.pathname === "/v1/prices/price_paid_monthly") return Response.json(paidPrice());
      if (url.pathname === "/v1/subscriptions") {
        return Response.json({ data: [], has_more: false });
      }
      if (url.pathname === "/v1/checkout/sessions") {
        checkoutBody = new URLSearchParams(typeof init.body === "string" ? init.body : "");
        return Response.json({
          id: "cs_tax",
          url: "https://checkout.stripe.com/c/pay/tax",
          customer: "cus_user",
        });
      }
      return null;
    });

    const response = await app().request("/api/billing/checkout", {
      method: "POST",
      headers: { cookie },
    }, env);

    expect(response.status).toBe(201);
    expect(checkoutBody?.get("automatic_tax[enabled]")).toBe("true");
    expect(checkoutBody?.get("billing_address_collection")).toBe("required");
    expect(checkoutBody?.get("customer_update[address]")).toBe("auto");
    expect(checkoutBody?.has("subscription_data[trial_period_days]")).toBe(false);
  });

  it("does not create a duplicate when Stripe already has an unsynced subscription", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    const { cookie } = await unverifiedUser(env);
    await seedStripeCustomer(env);
    const fetch = stubFetch((url) => {
      if (url.pathname === "/v1/prices/price_paid_monthly") return Response.json(paidPrice());
      if (url.pathname === "/v1/subscriptions") {
        return Response.json({
          data: [subscription(Math.floor(Date.now() / 1000) + 2_592_000, "trialing", {
            start: Math.floor(Date.now() / 1000),
            end: Math.floor(Date.now() / 1000) + 7 * 86_400,
          })],
          has_more: false,
        });
      }
      throw new Error("an unsynced subscription must stop before Checkout");
    });

    const response = await app().request("/api/billing/checkout", {
      method: "POST",
      headers: { cookie },
    }, env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "A Stripe subscription already exists and is still syncing. Try again shortly.",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM stripe_checkout_attempts").first())
      .toEqual({ count: 0 });
  });

  it("rejects malformed Stripe responses at the transport boundary", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    const { cookie } = await unverifiedUser(env);
    await seedStripeCustomer(env);
    stubFetch((url) => {
      if (url.pathname === "/v1/prices/price_paid_monthly") return Response.json(paidPrice());
      if (url.pathname === "/v1/subscriptions") {
        return Response.json({ data: {}, has_more: false });
      }
      throw new Error("invalid subscription data must stop before Checkout");
    });

    const response = await app().request("/api/billing/checkout", {
      method: "POST",
      headers: { cookie },
    }, env);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Stripe is temporarily unavailable. Try again shortly.",
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM stripe_checkout_attempts").first())
      .toEqual({ count: 0 });
  });

  it("verifies the exact raw webhook before publishing only event metadata", async () => {
    const sent: BillingEventMessage[] = [];
    const { env } = makeEnv({
      ...BILLING_CONFIG,
      BILLING_EVENTS: { send: async (message) => { sent.push(message); } },
    });
    const event = invoiceEvent("evt_webhook", Math.floor(Date.now() / 1000));
    const raw = JSON.stringify(event);
    const header = await signature(raw, "whsec_local", event.created);
    const response = await app().request("/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": header },
      body: raw,
    }, env);
    expect(response.status).toBe(204);
    expect(sent).toEqual([{
      eventId: "evt_webhook",
      eventType: "invoice.paid",
      eventCreated: event.created,
    }]);
    expect(JSON.stringify(sent)).not.toContain("cus_user");

    const tampered = await app().request("/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": header },
      body: `${raw} `,
    }, env);
    expect(tampered.status).toBe(400);
  });

  it("provides a secret-authenticated, non-PII billing support view", async () => {
    const { env } = makeEnv({ ...BILLING_CONFIG, FLEET_ADMIN_SECRET: "support-secret" });
    await seedUser(env, "user-1", "paid");
    await seedStripeCustomer(env);

    expect((await app().request("/api/admin/billing/user-1", {
      headers: { authorization: "Bearer wrong" },
    }, env)).status).toBe(401);
    const response = await app().request("/api/admin/billing/user-1", {
      headers: { authorization: "Bearer support-secret" },
    }, env);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      account: { id: "user-1", status: "active" },
      stripeCustomerId: "cus_user",
      entitlement: { plan: "paid", source: "manual" },
    });
    expect(JSON.stringify(body)).not.toContain("user-1@example.test");
  });

  it("reports Stripe Price mismatches without exposing billing secrets", async () => {
    const { env } = makeEnv({ ...BILLING_CONFIG, FLEET_ADMIN_SECRET: "support-secret" });
    stubFetch((url) => {
      if (url.pathname === "/v1/prices/price_paid_monthly") {
        return Response.json(paidPrice({ unit_amount: 2_100 }));
      }
      return null;
    });

    expect((await app().request("/api/admin/billing-configuration", {
      headers: { authorization: "Bearer wrong" },
    }, env)).status).toBe(401);
    const response = await app().request("/api/admin/billing-configuration", {
      headers: { authorization: "Bearer support-secret" },
    }, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      availability: { configured: true },
      stripePrice: {
        valid: false,
        mismatches: ["unit_amount"],
        expected: { id: "price_paid_monthly", unitAmount: 2_000, currency: "usd" },
        actual: { id: "price_paid_monthly", unitAmount: 2_100, currency: "usd" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("sk_test_local");
    expect(JSON.stringify(body)).not.toContain("whsec_local");
  });

});

describe("billing event consumer", () => {
  it("rejects events from a webhook endpoint using a different API version", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    const created = Math.floor(Date.now() / 1000);
    const event = {
      ...invoiceEvent("evt_wrong_version", created),
      api_version: "2025-03-31.basil",
    };
    stubFetch(stripeEventRoutes({ evt_wrong_version: event }, {}));

    await expect(processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    })).rejects.toMatchObject({ code: "event_api_version_mismatch" });
    expect(await env.DB.prepare(
      "SELECT status, last_error_code FROM stripe_billing_events WHERE event_id = 'evt_wrong_version'",
    ).first()).toEqual({
      status: "failed",
      last_error_code: "event_api_version_mismatch",
    });
  });

  it("grants Paid access for exactly the canonical seven-day trial window", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    const created = Math.floor(Date.now() / 1000);
    const trialEnd = created + 7 * 86_400;
    const event = {
      id: "evt_trial_started",
      type: "customer.subscription.created",
      created,
      data: { object: { id: "sub_paid", customer: "cus_user" } },
    };
    const openingInvoice = invoiceEvent(
      "evt_trial_zero_invoice",
      created + 1,
      "invoice.paid",
      "in_trial_zero",
    );
    openingInvoice.data.object.amount_paid = 0;
    stubFetch(stripeEventRoutes(
      { evt_trial_started: event, evt_trial_zero_invoice: openingInvoice },
      { sub_paid: subscription(trialEnd, "trialing", { start: created, end: trialEnd }) },
    ));

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });
    await processBillingEventMessage(env, {
      eventId: openingInvoice.id,
      eventType: openingInvoice.type,
      eventCreated: openingInvoice.created,
    });

    expect(await env.DB.prepare(
      `SELECT state, trial_until, service_until
       FROM account_entitlements WHERE user_id = 'user-1'`,
    ).first()).toEqual({
      state: "trialing",
      trial_until: trialEnd * 1000,
      service_until: null,
    });
    expect(await env.DB.prepare(
      `SELECT trial_start, trial_end, service_until
       FROM stripe_subscriptions WHERE stripe_subscription_id = 'sub_paid'`,
    ).first()).toEqual({
      trial_start: created * 1000,
      trial_end: trialEnd * 1000,
      service_until: null,
    });
    expect(await env.DB.prepare(
      "SELECT trial_used_at FROM stripe_customers WHERE user_id = 'user-1'",
    ).first()).toEqual({ trial_used_at: created * 1000 });
    expect(await env.DB.prepare(
      "SELECT subscription_status FROM users WHERE id = 'user-1'",
    ).first()).toEqual({ subscription_status: "paid" });
    expect(await env.DB.prepare(
      "SELECT title FROM notifications WHERE user_id = 'user-1'",
    ).first()).toEqual({ title: "Paid trial started" });
  });

  it("warns the owner when Stripe says the trial will end", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    const created = Math.floor(Date.now() / 1000);
    const trialStart = created - 4 * 86_400;
    const trialEnd = trialStart + 7 * 86_400;
    const event = {
      id: "evt_trial_will_end",
      type: "customer.subscription.trial_will_end",
      created,
      data: { object: { id: "sub_paid", customer: "cus_user" } },
    };
    stubFetch(stripeEventRoutes(
      { evt_trial_will_end: event },
      { sub_paid: subscription(trialEnd, "trialing", { start: trialStart, end: trialEnd }) },
    ));

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });

    expect(await env.DB.prepare(
      "SELECT title, severity FROM notifications WHERE id = 'billing:evt_trial_will_end'",
    ).first()).toEqual({ title: "Paid trial ends soon", severity: "warning" });
    expect(await env.DB.prepare(
      "SELECT state, trial_until FROM account_entitlements WHERE user_id = 'user-1'",
    ).first()).toEqual({ state: "trialing", trial_until: trialEnd * 1000 });
  });

  it("expires the matching local Checkout attempt from Stripe's terminal event", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await env.DB.prepare(
      `INSERT INTO stripe_checkout_attempts
         (id, user_id, stripe_checkout_session_id, status, expires_at, created_at, updated_at)
       VALUES ('checkout:one', 'user-1', 'cs_expired', 'open', 9999999999999, 1, 1)`,
    ).run();
    const event = {
      id: "evt_checkout_expired",
      type: "checkout.session.expired",
      created: 1_800_000_000,
      data: { object: { id: "cs_expired" } },
    };
    stubFetch(stripeEventRoutes({ evt_checkout_expired: event }, {}));

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });

    expect(await env.DB.prepare(
      "SELECT status FROM stripe_checkout_attempts WHERE id = 'checkout:one'",
    ).first()).toEqual({ status: "expired" });
    expect(await env.DB.prepare(
      "SELECT status, object_id FROM stripe_billing_events WHERE event_id = 'evt_checkout_expired'",
    ).first()).toEqual({ status: "processed", object_id: "cs_expired" });
  });

  it("correlates a refunded charge to the owner and raises a support alert", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    const event = {
      id: "evt_charge_refunded",
      type: "charge.refunded",
      created: 1_800_000_000,
      data: { object: { id: "ch_refunded", customer: "cus_user" } },
    };
    const invoice = invoiceEvent("ignored", event.created).data.object;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch((url) => {
      if (url.pathname === "/v1/events/evt_charge_refunded") return Response.json(event);
      if (url.pathname === "/v1/charges/ch_refunded") {
        return Response.json({ id: "ch_refunded", customer: "cus_user", invoice: "in_paid" });
      }
      if (url.pathname === "/v1/invoices/in_paid") return Response.json(invoice);
      if (url.pathname === "/v1/subscriptions/sub_paid") {
        return Response.json(subscription(event.created + 2_592_000));
      }
      return null;
    });

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });

    expect(await env.DB.prepare(
      "SELECT title, severity FROM notifications WHERE id = 'billing:evt_charge_refunded'",
    ).first()).toEqual({ title: "Payment refunded", severity: "critical" });
    expect(await env.DB.prepare(
      `SELECT status, object_id, subscription_id FROM stripe_billing_events
       WHERE event_id = 'evt_charge_refunded'`,
    ).first()).toEqual({
      status: "processed",
      object_id: "ch_refunded",
      subscription_id: "sub_paid",
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"userId":"user-1"'));
  });

  it("immediately returns a verified waitlisted owner to Free when the trial is canceled", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await seedUser(env, "user-1", "free");
    await seedStripeCustomer(env);
    await seedContainer(env, {
      host_id: null,
      ssh_port: null,
      tier: "paid",
      placement_class: "regular",
      placement_mode: "shared",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
      status: "waitlisted",
    });
    const created = Math.floor(Date.now() / 1000);
    const trialEnd = created + 7 * 86_400;
    const event = {
      id: "evt_trial_canceled",
      type: "customer.subscription.updated",
      created,
      data: { object: { id: "sub_paid", customer: "cus_user" } },
    };
    const canceledTrial = {
      ...subscription(trialEnd, "trialing", { start: created, end: trialEnd }),
      cancel_at_period_end: true,
    };
    stubFetch(stripeEventRoutes(
      { evt_trial_canceled: event },
      { sub_paid: canceledTrial },
    ));

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });

    expect(await env.DB.prepare(
      "SELECT state FROM account_entitlements WHERE user_id = 'user-1'",
    ).first()).toEqual({ state: "expired" });
    expect(await env.DB.prepare(
      `SELECT tier, placement_class, cpu, ram_mb, disk_gb, status
       FROM containers WHERE id = 'container-1'`,
    ).first()).toEqual({
      tier: "free",
      placement_class: "budget",
      cpu: 1,
      ram_mb: 1536,
      disk_gb: 5,
      status: "waitlisted",
    });
  });

  it("immediately downgrades a verified owner when the first post-trial payment fails", async () => {
    const { env } = makeEnv({ ...BILLING_CONFIG, BILLING_GRACE_DAYS: "3" });
    await seedUser(env, "user-1", "free");
    await seedStripeCustomer(env);
    await seedHost(env, {
      host_type: "regular",
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      tier: "paid",
      placement_class: "regular",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
    });
    const daemon = fakeDaemon();
    const created = Math.floor(Date.now() / 1000);
    const trialEnd = created - 1;
    const event = invoiceEvent(
      "evt_trial_payment_failed",
      created,
      "invoice.payment_failed",
      "in_trial_failed",
    );
    const stripeRoute = stripeEventRoutes(
      { evt_trial_payment_failed: event },
      {
        sub_paid: subscription(
          created + 30 * 86_400,
          "past_due",
          { start: trialEnd - 7 * 86_400, end: trialEnd },
        ),
      },
    );
    stubFetch((url, init) => stripeRoute(url) ?? daemon.route(url, init));

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });

    expect(await env.DB.prepare(
      "SELECT state, service_until, grace_until FROM account_entitlements WHERE user_id = 'user-1'",
    ).first()).toEqual({ state: "expired", service_until: null, grace_until: null });
    expect(await env.DB.prepare(
      `SELECT to_tier, state FROM container_plan_transitions
       WHERE container_id = 'container-1'`,
    ).first()).toEqual({ to_tier: "free", state: "requested" });
    expect(daemon.submitted).toMatchObject([{ op: "stop", containerId: "container-1" }]);
  });

  it("grants service from invoice.paid and makes duplicate delivery a no-op", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    const created = 1_800_000_000;
    const event = invoiceEvent("evt_paid", created);
    const periodEnd = created + 2_592_000;
    const fetch = stubFetch(stripeEventRoutes(
      { evt_paid: event },
      { sub_paid: subscription(periodEnd) },
    ));
    const message = { eventId: "evt_paid", eventType: "invoice.paid", eventCreated: created };

    await processBillingEventMessage(env, message);
    await processBillingEventMessage(env, message);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare(
      "SELECT source, state, service_until FROM account_entitlements WHERE user_id = 'user-1'",
    ).first()).toEqual({
      source: "stripe",
      state: "active",
      service_until: periodEnd * 1000,
    });
    expect(await env.DB.prepare(
      "SELECT status, attempt_count, subscription_id FROM stripe_billing_events WHERE event_id = 'evt_paid'",
    ).first()).toEqual({ status: "processed", attempt_count: 1, subscription_id: "sub_paid" });
    expect(await env.DB.prepare(
      "SELECT subscription_status, verified_at FROM users WHERE id = 'user-1'",
    ).first()).toEqual({ subscription_status: "paid", verified_at: null });
    expect(await env.DB.prepare(
      "SELECT user_id, title, message FROM notifications WHERE id = 'billing:evt_paid'",
    ).first()).toEqual({
      user_id: "user-1",
      title: "Payment confirmed",
      message: `Your Paid plan is active through ${new Date(periodEnd * 1000).toISOString().slice(0, 10)}.`,
    });
  });

  it("activates Premium without automatically changing an existing Free instance", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await seedUser(env, "user-1", "free");
    await seedStripeCustomer(env);
    await seedHost(env, {
      vcpu_allocated: 1,
      ram_allocated_mb: 1536,
      disk_allocated_gb: 10,
    });
    await seedContainer(env, { tier: "free", status: "running" });
    const created = 1_800_000_000;
    const event = invoiceEvent("evt_paid_free_instance", created);
    stubFetch(stripeEventRoutes(
      { evt_paid_free_instance: event },
      { sub_paid: subscription(created + 2_592_000) },
    ));

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });
    await reconcileBillingState(env, Date.now());

    expect(await env.DB.prepare(
      "SELECT tier, status, cpu, ram_mb, disk_gb FROM containers WHERE id = 'container-1'",
    ).first()).toEqual({
      tier: "free",
      status: "running",
      cpu: 1,
      ram_mb: 1536,
      disk_gb: 5,
    });
    expect((await env.DB.prepare("SELECT * FROM container_plan_transitions").all()).results)
      .toEqual([]);
  });

  it("accepts a settled zero-amount renewal but not the trial-opening invoice", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    const created = 1_800_000_000;
    const event = invoiceEvent("evt_credit_paid", created);
    event.data.object.amount_paid = 0;
    const periodEnd = created + 2_592_000;
    stubFetch(stripeEventRoutes(
      { evt_credit_paid: event },
      { sub_paid: subscription(periodEnd, "active") },
    ));

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });

    expect(await env.DB.prepare(
      "SELECT state, service_until FROM account_entitlements WHERE user_id = 'user-1'",
    ).first()).toEqual({ state: "active", service_until: periodEnd * 1000 });
  });

  it("never shortens paid-through service when an older event arrives later", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    const newer = invoiceEvent("evt_newer", 1_800_000_100, "invoice.paid", "in_newer");
    const older = invoiceEvent("evt_older", 1_800_000_000, "invoice.paid", "in_older");
    let canonicalPeriodEnd = 1_803_000_000;
    stubFetch((url) => {
      if (url.pathname === "/v1/events/evt_newer") return Response.json(newer);
      if (url.pathname === "/v1/events/evt_older") return Response.json(older);
      if (url.pathname === "/v1/subscriptions/sub_paid") {
        return Response.json(subscription(canonicalPeriodEnd));
      }
      return null;
    });
    await processBillingEventMessage(env, {
      eventId: "evt_newer",
      eventType: "invoice.paid",
      eventCreated: newer.created,
    });
    canonicalPeriodEnd = 1_802_000_000;
    await processBillingEventMessage(env, {
      eventId: "evt_older",
      eventType: "invoice.paid",
      eventCreated: older.created,
    });
    expect(await env.DB.prepare(
      "SELECT service_until, last_event_created FROM stripe_subscriptions WHERE stripe_subscription_id = 'sub_paid'",
    ).first()).toEqual({
      service_until: 1_803_000_000_000,
      last_event_created: newer.created,
    });
  });

  it("reclaims a billing event left processing by a lost Worker isolate", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    const created = 1_800_000_000;
    const event = invoiceEvent("evt_reclaimed", created);
    const periodEnd = created + 2_592_000;
    stubFetch(stripeEventRoutes(
      { evt_reclaimed: event },
      { sub_paid: subscription(periodEnd) },
    ));
    await env.DB.prepare(
      `INSERT INTO stripe_billing_events
         (event_id, event_type, event_created, status, attempt_count,
          received_at, processing_started_at)
       VALUES ('evt_reclaimed', 'invoice.paid', ?, 'processing', 1, 1, 1)`,
    ).bind(created).run();

    await processBillingEventMessage(env, {
      eventId: "evt_reclaimed",
      eventType: "invoice.paid",
      eventCreated: created,
    });

    expect(await env.DB.prepare(
      "SELECT status, attempt_count FROM stripe_billing_events WHERE event_id = 'evt_reclaimed'",
    ).first()).toEqual({ status: "processed", attempt_count: 2 });
  });

  it("does not let a delayed terminal event replace a newer live subscription", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO stripe_subscriptions
           (stripe_subscription_id, user_id, stripe_customer_id, price_id, plan,
            stripe_status, cancel_at_period_end, service_until, last_event_created,
            last_synced_at, created_at, updated_at)
         VALUES ('sub_old', 'user-1', 'cus_user', 'price_paid_monthly', 'paid',
                 'canceled', 0, 1000, 1, 1, 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO stripe_subscriptions
           (stripe_subscription_id, user_id, stripe_customer_id, price_id, plan,
            stripe_status, cancel_at_period_end, service_until, last_event_created,
            last_synced_at, created_at, updated_at)
         VALUES ('sub_new', 'user-1', 'cus_user', 'price_paid_monthly', 'paid',
                 'active', 0, 1900000000000, 2, 2, 2, 2)`,
      ),
      env.DB.prepare(
        `INSERT INTO account_entitlements
           (user_id, plan, source, state, service_until, source_ref, updated_at)
         VALUES ('user-1', 'paid', 'stripe', 'active', 1900000000000, 'sub_new', 2)`,
      ),
    ]);
    const event = {
      id: "evt_old_deleted",
      type: "customer.subscription.deleted",
      created: 3,
      data: { object: { id: "sub_old", customer: "cus_user" } },
    };
    stubFetch(stripeEventRoutes(
      { evt_old_deleted: event },
      { sub_old: { ...subscription(1), id: "sub_old", status: "canceled" } },
    ));

    await processBillingEventMessage(env, {
      eventId: event.id,
      eventType: event.type,
      eventCreated: event.created,
    });

    expect(await env.DB.prepare(
      "SELECT state, source_ref, service_until FROM account_entitlements WHERE user_id = 'user-1'",
    ).first()).toEqual({
      state: "active",
      source_ref: "sub_new",
      service_until: 1_900_000_000_000,
    });
  });

  it("records payment failure without extending paid service", async () => {
    const { env } = makeEnv({ ...BILLING_CONFIG, BILLING_GRACE_DAYS: "0" });
    await unverifiedUser(env);
    await seedStripeCustomer(env);
    const paid = invoiceEvent("evt_paid", 1_800_000_000);
    const failed = invoiceEvent(
      "evt_failed",
      1_800_000_100,
      "invoice.payment_failed",
      "in_failed",
    );
    const paidEnd = 1_801_000_000;
    let current = subscription(paidEnd);
    stubFetch((url) => {
      if (url.pathname === "/v1/events/evt_paid") return Response.json(paid);
      if (url.pathname === "/v1/events/evt_failed") return Response.json(failed);
      if (url.pathname === "/v1/subscriptions/sub_paid") return Response.json(current);
      return null;
    });
    await processBillingEventMessage(env, {
      eventId: "evt_paid",
      eventType: "invoice.paid",
      eventCreated: paid.created,
    });
    current = subscription(1_802_000_000, "past_due");
    await processBillingEventMessage(env, {
      eventId: "evt_failed",
      eventType: "invoice.payment_failed",
      eventCreated: failed.created,
    });
    expect(await env.DB.prepare(
      "SELECT stripe_status, service_until FROM stripe_subscriptions WHERE stripe_subscription_id = 'sub_paid'",
    ).first()).toEqual({ stripe_status: "past_due", service_until: paidEnd * 1000 });
  });
});

describe("billing deadline reconciliation", () => {
  it("suspends paid-bypass service without inventing a destruction deadline", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedExpiredStripeSubscription(env);
    await seedHost(env, {
      host_type: "regular",
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      tier: "paid",
      placement_class: "regular",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
    });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    await reconcileBillingState(env, 200);

    expect(await env.DB.prepare(
      `SELECT tier, status, suspension_reason, billing_suspended_at, destroy_after
       FROM containers WHERE id = 'container-1'`,
    ).first()).toEqual({
      tier: "paid",
      status: "running",
      suspension_reason: "billing",
      billing_suspended_at: 200,
      destroy_after: null,
    });
    expect(daemon.submitted).toMatchObject([{ op: "stop", containerId: "container-1" }]);
  });

  it("downgrades an expired verified owner in place", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await seedUser(env, "user-1", "free");
    await seedExpiredStripeSubscription(env);
    await seedHost(env, {
      host_type: "regular",
      vcpu_allocated: 2,
      ram_allocated_mb: 4096,
      disk_allocated_gb: 16,
    });
    await seedContainer(env, {
      tier: "paid",
      placement_class: "regular",
      cpu: 2,
      ram_mb: 4096,
      disk_gb: 8,
    });
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    await reconcileBillingState(env, 200);

    expect(await env.DB.prepare(
      "SELECT to_tier, target_disk_gb, state FROM container_plan_transitions WHERE container_id = 'container-1'",
    ).first()).toEqual({ to_tier: "free", target_disk_gb: 8, state: "requested" });
    expect(daemon.submitted).toMatchObject([{
      op: "stop",
      containerId: "container-1",
    }]);
  });

  it("stops an expired paid-bypass workbench after a failed reserved upgrade", async () => {
    const { env } = makeEnv(BILLING_CONFIG);
    await unverifiedUser(env);
    await seedExpiredStripeSubscription(env);
    await seedHost(env);
    await seedContainer(env, { status: "upgrade_pending" });
    await env.DB.prepare(
      `INSERT INTO container_plan_transitions
         (container_id, from_tier, to_tier, target_disk_gb, prior_status, state,
          reserved_cpu, reserved_ram_mb, reserved_disk_gb, requested_at, updated_at)
       VALUES ('container-1', 'free', 'paid', 8, 'running', 'failed_retryable',
               2, 2560, 6, 1, 1)`,
    ).run();
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    await reconcileBillingState(env, 200);

    expect(await env.DB.prepare(
      "SELECT status, suspension_reason FROM containers WHERE id = 'container-1'",
    ).first()).toEqual({ status: "upgrade_pending", suspension_reason: "billing" });
    expect(daemon.submitted).toMatchObject([{ op: "stop", containerId: "container-1" }]);
  });
});
