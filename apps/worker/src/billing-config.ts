import {
  paidPriceId,
  PAID_TRIAL_DAYS,
  retrieveStripePrice,
  StripeConfigurationError,
  type StripePrice,
} from "./stripe.js";
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
    display: `${PAID_TRIAL_DAYS}-day free trial, then ${currency} ${price}/month`,
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

/** Fail closed before Checkout if the charged Stripe Price can differ from the UI disclosure. */
export async function validatePaidStripePrice(env: Bindings): Promise<StripePrice> {
  const expectedId = paidPriceId(env);
  const expectedCurrency = env.PAID_PLAN_CURRENCY?.trim().toLowerCase();
  const price = await retrieveStripePrice(env, expectedId);
  const productActive = typeof price.product === "object" && price.product.active;
  if (
    price.id !== expectedId || !price.active || !productActive ||
    price.type !== "recurring" || price.billing_scheme !== "per_unit" ||
    price.unit_amount !== configuredUnitAmount(env) ||
    price.currency.toLowerCase() !== expectedCurrency ||
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
