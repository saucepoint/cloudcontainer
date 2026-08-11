import { describe, expect, it } from "vitest";
import {
  billingAvailability,
  configuredCheckoutSessionMinutes,
  configuredExportWindowMs,
  configuredGraceMs,
} from "../src/billing-config.js";
import { StripeConfigurationError } from "../src/stripe.js";
import type { Bindings } from "../src/types.js";
import { makeEnv } from "./helpers/env.js";

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

describe("billing configuration", () => {
  it("uses explicit defaults only when optional policy is absent", () => {
    const { env } = makeEnv(BILLING_CONFIG);

    expect(configuredCheckoutSessionMinutes(env)).toBe(60);
    expect(configuredGraceMs(env)).toBe(0);
    expect(configuredExportWindowMs(env)).toBe(0);
    expect(billingAvailability(env).configured).toBe(true);
  });

  it("rejects malformed policy instead of silently changing billing behavior", () => {
    const invalidGrace = makeEnv({ ...BILLING_CONFIG, BILLING_GRACE_DAYS: "later" }).env;
    const invalidExport = makeEnv({ ...BILLING_CONFIG, BILLING_EXPORT_WINDOW_DAYS: "0" }).env;
    const invalidCheckout = makeEnv({
      ...BILLING_CONFIG,
      BILLING_CHECKOUT_SESSION_MINUTES: "30",
    }).env;
    const invalidTax = makeEnv({ ...BILLING_CONFIG, STRIPE_TAX_ENABLED: "yes" }).env;

    for (const check of [
      () => configuredGraceMs(invalidGrace),
      () => configuredExportWindowMs(invalidExport),
      () => configuredCheckoutSessionMinutes(invalidCheckout),
      () => billingAvailability(invalidTax),
    ]) {
      expect(check).toThrow(StripeConfigurationError);
    }
  });
});
