import type {
  AccountEntitlementRow,
  Bindings,
  EntitlementPlan,
  EntitlementState,
  StripeSubscriptionRow,
  UserRow,
} from "./types.js";

export interface EffectiveEntitlement {
  eligible: boolean;
  plan: "free" | EntitlementPlan | null;
  source: "world_id" | "invite" | "development" | "stripe" | "manual" | null;
  state: EntitlementState | "free" | "ineligible";
  accessUntil: number | null;
}

export interface StripeEntitlementFacts {
  stripeStatus: string;
  cancelAtPeriodEnd: boolean;
  cancelAt: number | null;
  trialEnd: number | null;
  serviceUntil: number | null;
  graceUntil: number | null;
}

const FREE_VERIFICATION_METHODS = new Set(["world_id", "invite", "development"]);

export function hasPermanentFreeEligibility(user: UserRow): boolean {
  return user.verified_at !== null &&
    user.verification_method !== null &&
    FREE_VERIFICATION_METHODS.has(user.verification_method);
}

function laterDeadline(...deadlines: Array<number | null>): number | null {
  const present = deadlines.filter((deadline): deadline is number => deadline !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

/** Pure Stripe-facts projection. Labels never decide access without a deadline. */
export function projectStripeEntitlement(
  facts: StripeEntitlementFacts,
  now: number,
): { state: EntitlementState; accessUntil: number | null } {
  const paid = facts.serviceUntil !== null && facts.serviceUntil > now;
  const grace = facts.graceUntil !== null && facts.graceUntil > now;

  if (facts.stripeStatus === "incomplete" || facts.stripeStatus === "incomplete_expired") {
    return { state: "pending", accessUntil: null };
  }
  if (facts.stripeStatus === "trialing") {
    if (facts.cancelAtPeriodEnd || facts.cancelAt !== null) {
      return { state: "expired", accessUntil: null };
    }
    return facts.trialEnd !== null && facts.trialEnd > now
      ? { state: "trialing", accessUntil: facts.trialEnd }
      : { state: "expired", accessUntil: null };
  }
  if (facts.stripeStatus === "past_due" || facts.stripeStatus === "unpaid") {
    if (paid) return { state: "past_due", accessUntil: facts.serviceUntil };
    if (grace) return { state: "grace", accessUntil: facts.graceUntil };
    return { state: "expired", accessUntil: null };
  }
  if (facts.stripeStatus === "paused") {
    if (paid) return { state: "past_due", accessUntil: facts.serviceUntil };
    if (grace) return { state: "grace", accessUntil: facts.graceUntil };
    return { state: "expired", accessUntil: null };
  }
  if (facts.stripeStatus === "canceled") {
    return paid
      ? { state: "cancel_scheduled", accessUntil: facts.serviceUntil }
      : { state: "expired", accessUntil: null };
  }
  if (facts.stripeStatus !== "active") return { state: "pending", accessUntil: null };
  if (paid) {
    const scheduled = facts.cancelAtPeriodEnd ||
      (facts.cancelAt !== null && facts.cancelAt > now);
    return {
      state: scheduled ? "cancel_scheduled" : "active",
      accessUntil: facts.serviceUntil,
    };
  }
  if (grace) return { state: "grace", accessUntil: facts.graceUntil };
  return { state: "pending", accessUntil: null };
}

export function effectiveEntitlement(
  user: UserRow,
  entitlement: AccountEntitlementRow | null,
  now: number,
): EffectiveEntitlement {
  if (entitlement?.source === "manual") {
    const accessUntil = laterDeadline(entitlement.service_until, entitlement.grace_until);
    if (accessUntil === null || accessUntil > now) {
      return {
        eligible: true,
        plan: entitlement.plan,
        source: "manual",
        state: "manual",
        accessUntil,
      };
    }
  }

  if (entitlement?.source === "stripe" && entitlement.plan === "paid") {
    const accessUntil = laterDeadline(
      entitlement.trial_until,
      entitlement.service_until,
      entitlement.grace_until,
    );
    if (
      accessUntil !== null && accessUntil > now &&
      entitlement.state !== "pending" && entitlement.state !== "expired"
    ) {
      return {
        eligible: true,
        plan: "paid",
        source: "stripe",
        state: entitlement.state,
        accessUntil,
      };
    }
  }

  if (hasPermanentFreeEligibility(user)) {
    return {
      eligible: true,
      plan: "free",
      source: user.verification_method,
      state: "free",
      accessUntil: null,
    };
  }

  return {
    eligible: false,
    plan: null,
    source: null,
    state: "ineligible",
    accessUntil: null,
  };
}

export async function accountEntitlement(
  env: Bindings,
  userId: string,
): Promise<AccountEntitlementRow | null> {
  return env.DB.prepare("SELECT * FROM account_entitlements WHERE user_id = ?")
    .bind(userId)
    .first<AccountEntitlementRow>();
}

export async function effectiveEntitlementForUser(
  env: Bindings,
  user: UserRow,
  now = Date.now(),
): Promise<EffectiveEntitlement> {
  const entitlement = await accountEntitlement(env, user.id);
  if (entitlement?.source !== "stripe") return effectiveEntitlement(user, entitlement, now);
  const subscription = entitlement.source_ref
    ? await env.DB.prepare(
        "SELECT * FROM stripe_subscriptions WHERE stripe_subscription_id = ? AND user_id = ?",
      ).bind(entitlement.source_ref, user.id).first<StripeSubscriptionRow>()
    : null;
  if (!subscription) {
    return effectiveEntitlement(user, {
      ...entitlement,
      state: "expired",
      service_until: null,
      grace_until: null,
    }, now);
  }
  const projection = projectStripeEntitlement({
    stripeStatus: subscription.stripe_status,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    cancelAt: subscription.cancel_at,
    trialEnd: subscription.trial_end,
    serviceUntil: subscription.service_until,
    graceUntil: subscription.grace_until,
  }, now);
  return effectiveEntitlement(user, {
    ...entitlement,
    state: projection.state,
    trial_until: subscription.trial_end,
    service_until: subscription.service_until,
    grace_until: subscription.grace_until,
  }, now);
}
