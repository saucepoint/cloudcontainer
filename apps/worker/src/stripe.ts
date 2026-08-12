import { z } from "zod";
import type { Bindings } from "./types.js";

/** Pinned with the webhook destination; upgrade only with refreshed fixtures. */
export const STRIPE_API_VERSION = "2026-07-29.dahlia";
export const STRIPE_WEBHOOK_TOLERANCE_SEC = 300;
export const PAID_TRIAL_DAYS = 7;

const StripeIdSchema = z.string().min(1);
const StripeExpandableIdSchema = z.union([
  StripeIdSchema,
  z.object({ id: StripeIdSchema }).passthrough(),
]);
const StripeCustomerSchema = z.object({
  id: StripeIdSchema,
  deleted: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).passthrough();
const StripeCustomerReferenceSchema = z.union([StripeIdSchema, StripeCustomerSchema]);
const StripeSubscriptionItemSchema = z.object({
  id: StripeIdSchema,
  current_period_end: z.number().int(),
  price: z.object({ id: StripeIdSchema }).passthrough(),
  quantity: z.number().nullable().optional(),
}).passthrough();
const StripeSubscriptionSchema = z.object({
  id: StripeIdSchema,
  customer: StripeCustomerReferenceSchema,
  status: z.string().min(1),
  cancel_at_period_end: z.boolean(),
  cancel_at: z.number().int().nullable(),
  trial_start: z.number().int().nullable().optional(),
  trial_end: z.number().int().nullable().optional(),
  canceled_at: z.number().int().nullable().optional(),
  ended_at: z.number().int().nullable().optional(),
  metadata: z.record(z.string(), z.string()),
  latest_invoice: StripeExpandableIdSchema.nullable().optional(),
  items: z.object({
    data: z.array(StripeSubscriptionItemSchema),
    has_more: z.boolean().optional(),
  }).passthrough(),
}).passthrough();
const StripeInvoiceSchema = z.object({
  id: StripeIdSchema,
  customer: StripeCustomerReferenceSchema.nullable(),
  status: z.string().nullable().optional(),
  paid: z.boolean().optional(),
  amount_paid: z.number().nullable().optional(),
  parent: z.object({
    type: z.string().optional(),
    subscription_details: z.object({
      subscription: StripeExpandableIdSchema.nullable().optional(),
    }).passthrough().nullable().optional(),
  }).passthrough().nullable().optional(),
  // Accepted only for old event fixtures during a webhook-version rollout.
  subscription: StripeExpandableIdSchema.nullable().optional(),
}).passthrough();
const StripePriceSchema = z.object({
  id: StripeIdSchema,
  active: z.boolean(),
  livemode: z.boolean(),
  currency: z.string().min(1),
  type: z.string().min(1),
  unit_amount: z.number().int().nullable(),
  tax_behavior: z.enum(["exclusive", "inclusive", "unspecified"]).optional(),
  billing_scheme: z.string().optional(),
  recurring: z.object({
    interval: z.string().min(1),
    interval_count: z.number().int(),
    usage_type: z.string().min(1),
  }).passthrough().nullable().optional(),
  product: z.union([
    StripeIdSchema,
    z.object({
      id: StripeIdSchema,
      active: z.boolean(),
      tax_code: StripeExpandableIdSchema.nullable().optional(),
    }).passthrough(),
  ]),
}).passthrough();
const StripeChargeSchema = z.object({
  id: StripeIdSchema,
  customer: StripeCustomerReferenceSchema.nullable(),
  invoice: StripeExpandableIdSchema.nullable().optional(),
}).passthrough();
const StripeEventSchema = z.object({
  id: StripeIdSchema,
  type: z.string().min(1),
  created: z.number().int(),
  api_version: z.string().nullable().optional(),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }).passthrough(),
}).passthrough();
const StripeCheckoutSessionSchema = z.object({
  id: StripeIdSchema,
  url: z.string().url(),
  status: z.string().optional(),
  customer: StripeCustomerReferenceSchema,
  subscription: StripeExpandableIdSchema.nullable().optional(),
  client_reference_id: z.string().nullable().optional(),
  expires_at: z.number().int().optional(),
}).passthrough();
const StripeCheckoutEventObjectSchema = z.object({
  id: StripeIdSchema,
  customer: StripeCustomerReferenceSchema.nullable(),
  subscription: StripeExpandableIdSchema.nullable().optional(),
  client_reference_id: z.string().nullable().optional(),
}).passthrough();
const StripePortalSessionSchema = z.object({
  id: StripeIdSchema,
  url: z.string().url(),
}).passthrough();
const StripeSubscriptionListSchema = z.object({
  data: z.array(StripeSubscriptionSchema),
  has_more: z.boolean(),
}).passthrough();

export type StripeEvent = z.infer<typeof StripeEventSchema>;
export type StripeCustomer = z.infer<typeof StripeCustomerSchema>;
export type StripeCheckoutSession = z.infer<typeof StripeCheckoutSessionSchema>;
export type StripeCheckoutEventObject = z.infer<typeof StripeCheckoutEventObjectSchema>;
export type StripePortalSession = z.infer<typeof StripePortalSessionSchema>;
export type StripeSubscription = z.infer<typeof StripeSubscriptionSchema>;
export type StripeSubscriptionList = z.infer<typeof StripeSubscriptionListSchema>;
export type StripeInvoice = z.infer<typeof StripeInvoiceSchema>;
export type StripePrice = z.infer<typeof StripePriceSchema>;
export type StripeCharge = z.infer<typeof StripeChargeSchema>;

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

const StripeErrorPayloadSchema = z.object({
  error: z.object({
    code: z.string().optional(),
    type: z.string().optional(),
  }),
});

function stripeSecret(env: Bindings): string {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (!secret) throw new StripeConfigurationError();
  const liveMode = configuredStripeLiveMode(env);
  const validPrefix = liveMode
    ? secret.startsWith("sk_live_") || secret.startsWith("rk_live_")
    : secret.startsWith("sk_test_") || secret.startsWith("rk_test_");
  if (!validPrefix) {
    throw new StripeConfigurationError("Stripe API key mode does not match STRIPE_LIVE_MODE");
  }
  return secret;
}

export function configuredStripeLiveMode(env: Bindings): boolean {
  const value = env.STRIPE_LIVE_MODE?.trim();
  if (value !== "0" && value !== "1") {
    throw new StripeConfigurationError("Stripe live mode is not configured");
  }
  return value === "1";
}

/** Validate the API key prefix without returning or exposing the credential. */
export function validateStripeApiKeyMode(env: Bindings): void {
  stripeSecret(env);
}

async function stripeRequest<T>(
  env: Bindings,
  method: "GET" | "POST",
  path: string,
  schema: z.ZodType<T>,
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
    const payload: unknown = await response.json().catch(() => null);
    const parsed = StripeErrorPayloadSchema.safeParse(payload);
    const code = parsed.success
      ? parsed.data.error.code ?? parsed.data.error.type ?? "api_error"
      : "api_error";
    throw new StripeApiError(response.status, code);
  }
  const payload: unknown = await response.json().catch(() => {
    throw new StripeApiError(502, "invalid_json");
  });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new StripeApiError(502, "invalid_response");
  return parsed.data;
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
    StripeCustomerSchema,
    form,
    `customer:${input.userId}`,
  );
}

export async function createStripeCheckoutSession(
  env: Bindings,
  input: {
    userId: string;
    customerId: string;
    attemptId: string;
    expiresAt: number;
    trialEligible: boolean;
  },
): Promise<StripeCheckoutSession> {
  const form = new URLSearchParams({
    mode: "subscription",
    customer: input.customerId,
    payment_method_collection: "always",
    client_reference_id: input.userId,
    "line_items[0][price]": paidPriceId(env),
    "line_items[0][quantity]": "1",
    "subscription_data[metadata][userId]": input.userId,
    "subscription_data[metadata][plan]": "paid",
    "subscription_data[billing_mode][type]": "flexible",
    "subscription_data[billing_mode][flexible][proration_discounts]": "itemized",
    "automatic_tax[enabled]": env.STRIPE_TAX_ENABLED === "1" ? "true" : "false",
    expires_at: String(input.expiresAt),
    success_url: `${env.BASE_URL}/dashboard?checkout=success`,
    cancel_url: `${env.BASE_URL}/dashboard?checkout=cancelled`,
  });
  if (input.trialEligible) {
    form.set("subscription_data[trial_period_days]", String(PAID_TRIAL_DAYS));
    form.set("subscription_data[trial_settings][end_behavior][missing_payment_method]", "cancel");
  }
  if (env.STRIPE_TAX_ENABLED === "1") {
    form.set("billing_address_collection", "required");
    form.set("customer_update[address]", "auto");
  }
  return stripeRequest<StripeCheckoutSession>(
    env,
    "POST",
    "/v1/checkout/sessions",
    StripeCheckoutSessionSchema,
    form,
    input.attemptId,
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
    StripePortalSessionSchema,
    new URLSearchParams({
      customer: customerId,
      return_url: `${env.BASE_URL}/account`,
    }),
  );
}

export async function retrieveStripeEvent(env: Bindings, eventId: string): Promise<StripeEvent> {
  return stripeRequest<StripeEvent>(
    env,
    "GET",
    `/v1/events/${encodeURIComponent(eventId)}`,
    StripeEventSchema,
  );
}

export async function retrieveStripeSubscription(
  env: Bindings,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    env,
    "GET",
    `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    StripeSubscriptionSchema,
  );
}

export async function listStripeSubscriptions(
  env: Bindings,
  customerId: string,
): Promise<StripeSubscriptionList> {
  const query = new URLSearchParams({ customer: customerId, status: "all", limit: "100" });
  return stripeRequest<StripeSubscriptionList>(
    env,
    "GET",
    `/v1/subscriptions?${query}`,
    StripeSubscriptionListSchema,
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
    StripeInvoiceSchema,
  );
}

export async function retrieveStripePrice(env: Bindings, priceId: string): Promise<StripePrice> {
  return stripeRequest<StripePrice>(
    env,
    "GET",
    `/v1/prices/${encodeURIComponent(priceId)}?expand%5B%5D=product`,
    StripePriceSchema,
  );
}

export async function retrieveStripeCharge(env: Bindings, chargeId: string): Promise<StripeCharge> {
  return stripeRequest<StripeCharge>(
    env,
    "GET",
    `/v1/charges/${encodeURIComponent(chargeId)}`,
    StripeChargeSchema,
  );
}

export function stripeEntityId(
  value: unknown,
): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const id = Reflect.get(value, "id");
  return typeof id === "string" ? id : null;
}

export function parseStripeInvoice(value: unknown): StripeInvoice {
  const invoice = StripeInvoiceSchema.safeParse(value);
  if (!invoice.success) throw new StripeApiError(502, "invalid_response");
  return invoice.data;
}

export function parseStripeCheckoutEvent(value: unknown): StripeCheckoutEventObject {
  const session = StripeCheckoutEventObjectSchema.safeParse(value);
  if (!session.success) throw new StripeApiError(502, "invalid_response");
  return session.data;
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
  expectedLiveMode: boolean,
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

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new StripeWebhookError("invalid_json");
  }
  const event = StripeEventSchema.safeParse(payload);
  if (!event.success) throw new StripeWebhookError("invalid_event");
  if (event.data.livemode !== expectedLiveMode) {
    throw new StripeWebhookError("mode_mismatch");
  }
  return event.data;
}
