-- A Stripe trial is an account-level acquisition benefit, not a property of
-- every replacement subscription. Preserve whether the mapped Customer has
-- already consumed it so cancellation/resubscription cannot mint free service
-- indefinitely.
ALTER TABLE stripe_customers ADD COLUMN trial_used_at INTEGER;

UPDATE stripe_customers
SET trial_used_at = (
  SELECT MIN(s.trial_start)
  FROM stripe_subscriptions s
  WHERE s.user_id = stripe_customers.user_id AND s.trial_start IS NOT NULL
)
WHERE EXISTS (
  SELECT 1 FROM stripe_subscriptions s
  WHERE s.user_id = stripe_customers.user_id AND s.trial_start IS NOT NULL
);
