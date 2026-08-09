-- Expand-first monetization foundation. Legacy host_type/placement_class and
-- users.subscription_status remain during the rolling fleet release.

ALTER TABLE hosts ADD COLUMN tenancy_mode TEXT NOT NULL DEFAULT 'shared'
  CHECK (tenancy_mode IN ('shared', 'dedicated'));
UPDATE hosts
SET tenancy_mode = CASE host_type WHEN 'dedicated' THEN 'dedicated' ELSE 'shared' END;

-- JSON array reported by rollout-compatible daemons. NULL means legacy.
ALTER TABLE hosts ADD COLUMN daemon_capabilities TEXT;

ALTER TABLE containers ADD COLUMN placement_mode TEXT NOT NULL DEFAULT 'shared'
  CHECK (placement_mode IN ('shared', 'dedicated'));
UPDATE containers
SET placement_mode = CASE placement_class WHEN 'dedicated' THEN 'dedicated' ELSE 'shared' END;

-- Paid-to-free downgrades cannot shrink Incus/ZFS volumes safely. Keep the
-- actual disk reservation and make the exceptional allocation explicit.
ALTER TABLE containers ADD COLUMN storage_grandfathered INTEGER NOT NULL DEFAULT 0
  CHECK (storage_grandfathered IN (0, 1));
ALTER TABLE containers ADD COLUMN suspension_reason TEXT
  CHECK (suspension_reason IN ('billing'));
ALTER TABLE containers ADD COLUMN billing_suspended_at INTEGER;
ALTER TABLE containers ADD COLUMN destroy_after INTEGER;

ALTER TABLE waitlist ADD COLUMN skip_count INTEGER NOT NULL DEFAULT 0
  CHECK (skip_count >= 0);

-- Existing announcements remain global. Billing notices use this nullable
-- owner so account-specific deadlines never appear to another account.
ALTER TABLE notifications ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX idx_notifications_user_active
ON notifications(user_id, created_at, expires_at);

CREATE INDEX idx_hosts_tenancy_placement
ON hosts(tenancy_mode, status, last_seen_at, consecutive_failures);
CREATE INDEX idx_containers_mode_waitlist
ON containers(placement_mode, status, host_id);

CREATE TABLE account_entitlements (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan          TEXT NOT NULL CHECK (plan IN ('paid', 'dedicated')),
  source        TEXT NOT NULL CHECK (source IN ('stripe', 'manual')),
  state         TEXT NOT NULL CHECK (
    state IN ('pending', 'trialing', 'active', 'cancel_scheduled', 'past_due', 'grace', 'expired', 'manual')
  ),
  trial_until   INTEGER,
  service_until INTEGER,
  grace_until   INTEGER,
  source_ref    TEXT,
  updated_at    INTEGER NOT NULL,
  CHECK (source <> 'stripe' OR plan = 'paid'),
  CHECK (source <> 'manual' OR state = 'manual')
);

-- Preserve existing operator-entitled accounts without fabricating Stripe
-- objects or requiring them to buy again.
INSERT INTO account_entitlements
  (user_id, plan, source, state, service_until, grace_until, source_ref, updated_at)
SELECT id, subscription_status, 'manual', 'manual', NULL, NULL, 'legacy-operator', updated_at
FROM users
WHERE subscription_status IN ('paid', 'dedicated');

CREATE TABLE stripe_customers (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE stripe_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stripe_customer_id      TEXT NOT NULL,
  price_id                TEXT NOT NULL,
  plan                    TEXT NOT NULL CHECK (plan = 'paid'),
  stripe_status           TEXT NOT NULL,
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0
    CHECK (cancel_at_period_end IN (0, 1)),
  cancel_at               INTEGER,
  trial_start             INTEGER,
  trial_end               INTEGER,
  service_until           INTEGER,
  grace_until             INTEGER,
  ended_at                INTEGER,
  last_paid_invoice_id    TEXT,
  last_event_created      INTEGER NOT NULL DEFAULT 0,
  last_synced_at          INTEGER NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX idx_stripe_subscriptions_user
ON stripe_subscriptions(user_id, updated_at DESC);
CREATE INDEX idx_stripe_subscriptions_sync
ON stripe_subscriptions(stripe_status, last_synced_at);
CREATE UNIQUE INDEX idx_stripe_subscriptions_one_live_user
ON stripe_subscriptions(user_id)
WHERE stripe_status NOT IN ('canceled', 'incomplete_expired');

CREATE TABLE stripe_checkout_attempts (
  id                         TEXT PRIMARY KEY,
  user_id                    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_checkout_session_id TEXT UNIQUE,
  status                     TEXT NOT NULL CHECK (
    status IN ('creating', 'open', 'complete', 'expired', 'failed')
  ),
  expires_at                 INTEGER NOT NULL,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_stripe_checkout_one_open_user
ON stripe_checkout_attempts(user_id)
WHERE status IN ('creating', 'open');

CREATE TABLE stripe_billing_events (
  event_id         TEXT PRIMARY KEY,
  event_type       TEXT NOT NULL,
  event_created    INTEGER NOT NULL,
  object_id        TEXT,
  subscription_id  TEXT,
  status           TEXT NOT NULL CHECK (
    status IN ('received', 'processing', 'processed', 'failed')
  ),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  received_at      INTEGER NOT NULL,
  processing_started_at INTEGER,
  processed_at     INTEGER,
  last_error_code  TEXT
);
CREATE INDEX idx_stripe_billing_events_status
ON stripe_billing_events(status, received_at);
CREATE INDEX idx_stripe_billing_events_subscription
ON stripe_billing_events(subscription_id, received_at DESC);

CREATE TABLE container_plan_transitions (
  container_id       TEXT PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
  from_tier          TEXT NOT NULL CHECK (from_tier IN ('free', 'paid')),
  to_tier            TEXT NOT NULL CHECK (to_tier IN ('free', 'paid')),
  target_disk_gb     INTEGER NOT NULL CHECK (target_disk_gb > 0),
  prior_status       TEXT NOT NULL CHECK (prior_status IN ('running', 'stopped')),
  state              TEXT NOT NULL CHECK (
    state IN ('requested', 'reserving', 'resizing', 'waiting_capacity',
              'failed_retryable', 'complete', 'cancelled')
  ),
  reserved_cpu       INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cpu >= 0),
  reserved_ram_mb    INTEGER NOT NULL DEFAULT 0 CHECK (reserved_ram_mb >= 0),
  reserved_disk_gb   INTEGER NOT NULL DEFAULT 0 CHECK (reserved_disk_gb >= 0),
  requested_at       INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_error_code    TEXT
);
CREATE INDEX idx_container_plan_transitions_state
ON container_plan_transitions(state, requested_at);
