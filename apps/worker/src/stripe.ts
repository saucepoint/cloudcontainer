import type { Bindings } from "./types.js";

/** Pinned with the webhook destination; upgrade only with refreshed fixtures. */
export const STRIPE_API_VERSION = "2025-03-31.basil";
export const STRIPE_WEBHOOK_TOLERANCE_SEC = 300;
export const PAID_TRIAL_DAYS = 7;

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  api_version?: string | null;
  data: { object: Record<string, unknown> };
}

export interface StripeCustomer {
  id: string;
  deleted?: boolean;
  metadata?: Record<string, string>;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  status?: string;
  customer: string | StripeCustomer | null;
  subscription?: string | { id: string } | null;
  client_reference_id?: string | null;
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export interface StripeSubscriptionItem {
  id: string;
  current_period_end: number;
  price: { id: string };
  quantity?: number | null;
}

export interface StripeSubscription {
  id: string;
  customer: string | StripeCustomer;
  status: string;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  trial_start?: number | null;
  trial_end?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  metadata: Record<string, string>;
  latest_invoice?: string | { id: string } | null;
  items: { data: StripeSubscriptionItem[]; has_more?: boolean };
}

export interface StripeInvoice {
  id: string;
  customer: string | StripeCustomer | null;
  status?: string | null;
  paid?: boolean;
  amount_paid?: number | null;
  parent?: {
    type?: string;
    subscription_details?: { subscription?: string | { id: string } | null } | null;
  } | null;
  // Accepted only for old event fixtures during a webhook-version rollout.
  subscription?: string | { id: string } | null;
}

export class StripeConfigurationError extends Error {
  constructor(message = "Stripe billing is not configured") {
    super(message);
    this.name = "StripeConfigurationError";
  }
}

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Stripe API request failed (${status}, ${code})`);
    this.name = "StripeApiError";
  }
}

export class StripeWebhookError extends Error {
  constructor(readonly code: string) {
    super(`Stripe webhook rejected (${code})`);
    this.name = "StripeWebhookError";
  }
}

function stripeSecret(env: Bindings): string {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) throw new StripeConfigurationError();
  return secret;
}

async function stripeRequest<T>(
  env: Bindings,
  method: "GET" | "POST",
  path: string,
  form?: URLSearchParams,
  idempotencyKey?: string,
): Promise<T> {
  const headers = new Headers({
    authorization: `Bearer ${stripeSecret(env)}`,
    "stripe-version": STRIPE_API_VERSION,
  });
  if (form) headers.set("content-type", "application/x-www-form-urlencoded");
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  const response = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers,
    ...(form ? { body: form.toString() } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    let code = "api_error";
    try {
      const payload = await response.json() as { error?: { code?: string; type?: string } };
      code = payload.error?.code ?? payload.error?.type ?? code;
    } catch {
      // The status and a non-sensitive local code are sufficient for logs.
    }
    throw new StripeApiError(response.status, code);
  }
  return response.json<T>();
}

export function paidPriceId(env: Bindings): string {
  const price = env.STRIPE_PRICE_PAID_MONTHLY?.trim();
  if (!price) throw new StripeConfigurationError("Paid Stripe Price is not configured");
  return price;
}

export async function createStripeCustomer(
  env: Bindings,
  input: { userId: string; email: string },
): Promise<StripeCustomer> {
  const form = new URLSearchParams({
    email: input.email,
    "metadata[userId]": input.userId,
  });
  return stripeRequest<StripeCustomer>(
    env,
    "POST",
    "/v1/customers",
    form,
    `customer:${input.userId}`,
  );
}

export async function createStripeCheckoutSession(
  env: Bindings,
  input: { attemptId: string; userId: string; customerId: string; expiresAt: number },
): Promise<StripeCheckoutSession> {
  const form = new URLSearchParams({
    mode: "subscription",
    customer: input.customerId,
    client_reference_id: input.userId,
    "line_items[0][price]": paidPriceId(env),
    "line_items[0][quantity]": "1",
    "subscription_data[metadata][userId]": input.userId,
    "subscription_data[metadata][plan]": "paid",
    "subscription_data[trial_period_days]": String(PAID_TRIAL_DAYS),
    "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel",
    "automatic_tax[enabled]": env.STRIPE_TAX_ENABLED === "1" ? "true" : "false",
    expires_at: String(input.expiresAt),
    success_url: `${env.BASE_URL}/account?checkout=success`,
    cancel_url: `${env.BASE_URL}/account?checkout=cancelled`,
  });
  return stripeRequest<StripeCheckoutSession>(
    env,
    "POST",
    "/v1/checkout/sessions",
    form,
    `checkout:${input.attemptId}`,
  );
}

export async function createStripePortalSession(
  env: Bindings,
  customerId: string,
): Promise<StripePortalSession> {
  return stripeRequest<StripePortalSession>(
    env,
    "POST",
    "/v1/billing_portal/sessions",
    new URLSearchParams({
      customer: customerId,
      return_url: `${env.BASE_URL}/account`,
    }),
  );
}

export async function retrieveStripeEvent(env: Bindings, eventId: string): Promise<StripeEvent> {
  return stripeRequest<StripeEvent>(env, "GET", `/v1/events/${encodeURIComponent(eventId)}`);
}

export async function retrieveStripeSubscription(
  env: Bindings,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    env,
    "GET",
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
}

export async function retrieveStripeInvoice(
  env: Bindings,
  invoiceId: string,
): Promise<StripeInvoice> {
  return stripeRequest<StripeInvoice>(
    env,
    "GET",
    `/v1/invoices/${encodeURIComponent(invoiceId)}`,
  );
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

/** Verify the exact raw body using Stripe's timestamped HMAC scheme. */
export async function verifyStripeEvent(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined,
  now = Date.now(),
): Promise<StripeEvent> {
  if (!secret?.trim()) throw new StripeConfigurationError("Stripe webhook secret is not configured");
  if (!signatureHeader) throw new StripeWebhookError("missing_signature");
  let timestamp: number | undefined;
  const signatures: Uint8Array[] = [];
  for (const component of signatureHeader.split(",")) {
    const separator = component.indexOf("=");
    if (separator < 1) continue;
    const key = component.slice(0, separator).trim();
    const value = component.slice(separator + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1") {
      const bytes = hexBytes(value);
      if (bytes) signatures.push(bytes);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new StripeWebhookError("malformed_signature");
  }
  const age = Math.abs(Math.floor(now / 1000) - timestamp);
  if (age > STRIPE_WEBHOOK_TOLERANCE_SEC) throw new StripeWebhookError("stale_signature");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  ));
  if (!signatures.some((candidate) => equalBytes(candidate, expected))) {
    throw new StripeWebhookError("invalid_signature");
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new StripeWebhookError("invalid_json");
  }
  if (
    !event || typeof event !== "object" ||
    typeof (event as StripeEvent).id !== "string" ||
    typeof (event as StripeEvent).type !== "string" ||
    !Number.isInteger((event as StripeEvent).created) ||
    !(event as StripeEvent).data || typeof (event as StripeEvent).data.object !== "object"
  ) {
    throw new StripeWebhookError("invalid_event");
  }
  return event as StripeEvent;
}
