import {
  paidPriceId,
  PAID_TRIAL_DAYS,
  retrieveStripePrice,
  StripeConfigurationError,
  type StripePrice,
} from "./stripe.js";
import { formatMonthlyPrice } from "./price.js";
import type { Bindings } from "./types.js";

const DAY_MS = 86_400_000;
const DEFAULT_CHECKOUT_SESSION_MINUTES = 60;
const MIN_CHECKOUT_SESSION_MINUTES = 31;
const MAX_CHECKOUT_SESSION_MINUTES = 24 * 60;
const DECIMAL_PRICE_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;
const ISO_CURRENCY_RE = /^[A-Z]{3}$/;

export interface PaidPlanDisplay {
  price: string;
  currency: string;
  interval: "month";
  trialDays: number;
  display: string;
}

export interface PaidStripePriceReport {
  valid: boolean;
  mismatches: string[];
  expected: {
    id: string;
    unitAmount: number;
    currency: string;
    taxEnabled: boolean;
  };
  actual: {
    id: string;
    active: boolean;
    liveMode: boolean;
    productId: string;
    productActive: boolean;
    type: string;
    billingScheme: string | null;
    unitAmount: number | null;
    currency: string;
    interval: string | null;
    intervalCount: number | null;
    usageType: string | null;
    taxBehavior: string | null;
    productTaxCode: string | null;
  };
}

function configuredDurationMs(
  value: string | undefined,
  name: string,
  allowZero: boolean,
): number {
  const raw = value?.trim();
  if (!raw) return 0;
  const days = Number(raw);
  const milliseconds = days * DAY_MS;
  if (
    !Number.isFinite(days) ||
    (allowZero ? days < 0 : days <= 0) ||
    !Number.isSafeInteger(milliseconds)
  ) {
    throw new StripeConfigurationError(`${name} is invalid`);
  }
  return milliseconds;
}

export function configuredGraceMs(env: Bindings): number {
  return configuredDurationMs(env.BILLING_GRACE_DAYS, "Billing grace period", true);
}

export function configuredExportWindowMs(env: Bindings): number {
  return configuredDurationMs(env.BILLING_EXPORT_WINDOW_DAYS, "Billing export window", false);
}

export function configuredCheckoutSessionMinutes(env: Bindings): number {
  const raw = env.BILLING_CHECKOUT_SESSION_MINUTES?.trim();
  if (!raw) return DEFAULT_CHECKOUT_SESSION_MINUTES;
  const minutes = Number(raw);
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_CHECKOUT_SESSION_MINUTES ||
    minutes > MAX_CHECKOUT_SESSION_MINUTES
  ) {
    throw new StripeConfigurationError("Checkout Session lifetime is invalid");
  }
  return minutes;
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

export function configuredUnitAmount(env: Bindings): number {
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

function paidPlanDisplay(env: Bindings): PaidPlanDisplay | null {
  const price = env.PAID_PLAN_MONTHLY_PRICE?.trim();
  const currency = env.PAID_PLAN_CURRENCY?.trim().toUpperCase();
  if (!price || !currency) return null;
  configuredUnitAmount(env);
  return {
    price,
    currency,
    interval: "month",
    trialDays: PAID_TRIAL_DAYS,
    display: `${PAID_TRIAL_DAYS}-day free trial, then ${formatMonthlyPrice(price, currency)}`,
  };
}

function taxConfigurationIsValid(value: string | undefined): boolean {
  const tax = value?.trim();
  if (!tax) return true;
  return tax === "0" || tax === "1";
}

export function billingAvailability(
  env: Bindings,
): { configured: boolean; paidPlan: PaidPlanDisplay | null } {
  const paidPlan = paidPlanDisplay(env);
  if (
    env.BILLING_ENABLED !== "1" ||
    !env.STRIPE_SECRET_KEY?.trim() ||
    !env.STRIPE_WEBHOOK_SECRET?.trim() ||
    !env.STRIPE_PRICE_PAID_MONTHLY?.trim() ||
    !env.BILLING_EVENTS ||
    !paidPlan
  ) {
    return { configured: false, paidPlan };
  }
  if (!taxConfigurationIsValid(env.STRIPE_TAX_ENABLED)) {
    throw new StripeConfigurationError("Stripe Tax setting is invalid");
  }
  configuredCheckoutSessionMinutes(env);
  configuredGraceMs(env);
  configuredExportWindowMs(env);
  return { configured: true, paidPlan };
}

function productTaxCode(product: StripePrice["product"]): string | null {
  if (typeof product === "string") return null;
  if (typeof product.tax_code === "string") return product.tax_code;
  return product.tax_code?.id ?? null;
}

function paidStripePriceReport(
  env: Bindings,
  price: StripePrice,
): PaidStripePriceReport {
  const expected = {
    id: paidPriceId(env),
    unitAmount: configuredUnitAmount(env),
    currency: env.PAID_PLAN_CURRENCY?.trim().toLowerCase() ?? "",
    taxEnabled: env.STRIPE_TAX_ENABLED === "1",
  };
  const actual = {
    id: price.id,
    active: price.active,
    liveMode: price.livemode,
    productId: typeof price.product === "string" ? price.product : price.product.id,
    productActive: typeof price.product === "object" && price.product.active,
    type: price.type,
    billingScheme: price.billing_scheme ?? null,
    unitAmount: price.unit_amount,
    currency: price.currency.toLowerCase(),
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
    usageType: price.recurring?.usage_type ?? null,
    taxBehavior: price.tax_behavior ?? null,
    productTaxCode: productTaxCode(price.product),
  };
  const mismatches = [
    actual.id !== expected.id ? "id" : null,
    !actual.active ? "active" : null,
    !actual.productActive ? "product_active" : null,
    actual.type !== "recurring" ? "type" : null,
    actual.billingScheme !== "per_unit" ? "billing_scheme" : null,
    actual.unitAmount !== expected.unitAmount ? "unit_amount" : null,
    actual.currency !== expected.currency ? "currency" : null,
    actual.interval !== "month" ? "interval" : null,
    actual.intervalCount !== 1 ? "interval_count" : null,
    actual.usageType !== "licensed" ? "usage_type" : null,
    expected.taxEnabled && !["exclusive", "inclusive"].includes(actual.taxBehavior ?? "")
      ? "tax_behavior"
      : null,
    expected.taxEnabled && actual.productTaxCode === null ? "product_tax_code" : null,
  ].filter((value): value is string => value !== null);
  return { valid: mismatches.length === 0, mismatches, expected, actual };
}

/** Fleet-admin-safe report of public Stripe Price attributes; never includes credentials. */
export async function inspectPaidStripePrice(env: Bindings): Promise<PaidStripePriceReport> {
  const price = await retrieveStripePrice(env, paidPriceId(env));
  return paidStripePriceReport(env, price);
}

/** Fail closed before Checkout if the charged Stripe Price can differ from the UI disclosure. */
export async function validatePaidStripePrice(env: Bindings): Promise<StripePrice> {
  const expectedId = paidPriceId(env);
  const price = await retrieveStripePrice(env, expectedId);
  const report = paidStripePriceReport(env, price);
  if (!report.valid) {
    throw new StripeConfigurationError(
      `Paid Stripe Price does not match the published plan (${report.mismatches.join(",")})`,
    );
  }
  return price;
}
