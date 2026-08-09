import type {
  ContainerStatus,
  HostStatus,
  HostType,
  JobOp,
  JobStatus,
  TenancyMode,
  Tier,
} from "@workbench/contract";

export interface BillingEventMessage {
  eventId: string;
  eventType: string;
  eventCreated: number;
}

export interface BillingEventQueue {
  send(message: BillingEventMessage): Promise<void>;
}

/**
 * Bindings = generated Cloudflare.Env (vars + D1 bindings from wrangler.jsonc)
 * plus secrets, which wrangler cannot know about at type-generation time.
 */
export type Bindings = Omit<
  Cloudflare.Env,
  | "BASE_URL"
  | "DEV_AUTH"
  | "GITHUB_APP_CLIENT_ID"
  | "GITHUB_APP_SLUG"
  | "AUTH_GOOGLE_CLIENT_ID"
  | "AUTH_GITHUB_CLIENT_ID"
  | "WORLD_ID_APP_ID"
  | "WORLD_ID_RP_ID"
  | "WORLD_ID_ACTION"
  | "WORLD_ID_ENVIRONMENT"
  | "STRIPE_PRICE_PAID_MONTHLY"
  | "PAID_PLAN_MONTHLY_PRICE"
  | "PAID_PLAN_CURRENCY"
  | "STRIPE_TAX_ENABLED"
  | "BILLING_ENABLED"
  | "BILLING_CHECKOUT_SESSION_MINUTES"
  | "BILLING_GRACE_DAYS"
  | "BILLING_EXPORT_WINDOW_DAYS"
  | "SSH_PORT_RANGE_START"
  | "SSH_PORT_RANGE_END"
> & {
  // vars (re-widened: `wrangler types` emits the literal placeholder values)
  BASE_URL: string;
  DEV_AUTH: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_SLUG: string;
  AUTH_GOOGLE_CLIENT_ID: string;
  AUTH_GITHUB_CLIENT_ID: string;
  WORLD_ID_APP_ID: string;
  WORLD_ID_RP_ID: string;
  WORLD_ID_ACTION: string;
  WORLD_ID_ENVIRONMENT: "production" | "staging";
  STRIPE_PRICE_PAID_MONTHLY?: string;
  PAID_PLAN_MONTHLY_PRICE?: string;
  PAID_PLAN_CURRENCY?: string;
  STRIPE_TAX_ENABLED?: string;
  BILLING_ENABLED?: string;
  BILLING_CHECKOUT_SESSION_MINUTES?: string;
  BILLING_GRACE_DAYS?: string;
  BILLING_EXPORT_WINDOW_DAYS?: string;
  SSH_PORT_RANGE_START: string;
  SSH_PORT_RANGE_END: string;
  // secrets
  BETTER_AUTH_SECRET: string;
  CREDENTIAL_MASTER_KEY: string;
  WORKER_RPC_PRIVATE_KEY: string;
  AUTH_GOOGLE_CLIENT_SECRET?: string;
  AUTH_GITHUB_CLIENT_SECRET?: string;
  WORLD_ID_SIGNING_KEY?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  BILLING_EVENTS?: BillingEventQueue;
  /** Protects the admin-only invite generation endpoint. Set with `wrangler secret put`. */
  INVITE_ADMIN_SECRET?: string;
  /** Protects host registration, health probes, and fleet state changes. */
  FLEET_ADMIN_SECRET?: string;
};

export interface UserRow {
  id: string;
  name: string;
  email: string;
  email_verified: 0 | 1;
  image: string | null;
  status: "active" | "banned" | "deleted";
  subscription_status: string;
  verified_at: number | null;
  verification_method: "world_id" | "invite" | "development" | null;
  created_at: number;
  updated_at: number;
}

export interface HostRow {
  id: string;
  ipv4: string;
  ipv6: string | null;
  ssh_hostname: string;
  daemon_endpoint: string;
  daemon_cert_fp: string | null;
  daemon_pubkey: string;
  ram_total_mb: number;
  ram_allocated_mb: number;
  ram_reserve_mb: number;
  vcpu_capacity: number;
  vcpu_allocated: number;
  disk_total_gb: number;
  disk_allocated_gb: number;
  status: HostStatus;
  joined_at: number;
  last_seen_at: number | null;
  consecutive_failures: number;
  host_type: HostType;
  tenancy_mode: TenancyMode;
  daemon_capabilities: string | null;
  max_tenants: number;
  dedicated_user_id: string | null;
  management_hostname: string | null;
  management_port: number;
  management_user: string;
  daemon_version: string | null;
  reported_ram_total_mb: number | null;
  reported_cpu_logical: number | null;
  generation: number;
  retired_at: number | null;
}

export interface ContainerRow {
  id: string;
  user_id: string;
  host_id: string | null;
  ssh_port: number | null;
  agents: string; // JSON array of Agent, e.g. '["claude","codex"]'
  github_repos: string; // JSON array of owner/name repositories cloned on provision
  tier: Tier;
  placement_class: HostType;
  placement_mode: TenancyMode;
  cpu: number;
  ram_mb: number;
  disk_gb: number;
  status: ContainerStatus;
  status_detail: string | null;
  host_key_fingerprints: string | null;
  suspended_at: number | null;
  created_at: number;
  last_upgraded_at: number | null;
  rehome_tier: Tier | null;
  rehome_placement_class: HostType | null;
  rehome_requested_at: number | null;
  storage_grandfathered: 0 | 1;
  suspension_reason: "billing" | null;
  billing_suspended_at: number | null;
  destroy_after: number | null;
}

export type EntitlementPlan = "paid" | "dedicated";
export type EntitlementSource = "stripe" | "manual";
export type EntitlementState =
  | "pending"
  | "trialing"
  | "active"
  | "cancel_scheduled"
  | "past_due"
  | "grace"
  | "expired"
  | "manual";

export interface AccountEntitlementRow {
  user_id: string;
  plan: EntitlementPlan;
  source: EntitlementSource;
  state: EntitlementState;
  trial_until: number | null;
  service_until: number | null;
  grace_until: number | null;
  source_ref: string | null;
  updated_at: number;
}

export interface StripeCustomerRow {
  user_id: string;
  stripe_customer_id: string;
  created_at: number;
  updated_at: number;
}

export interface StripeSubscriptionRow {
  stripe_subscription_id: string;
  user_id: string;
  stripe_customer_id: string;
  price_id: string;
  plan: "paid";
  stripe_status: string;
  cancel_at_period_end: 0 | 1;
  cancel_at: number | null;
  trial_start: number | null;
  trial_end: number | null;
  service_until: number | null;
  grace_until: number | null;
  ended_at: number | null;
  last_paid_invoice_id: string | null;
  last_event_created: number;
  last_synced_at: number;
  created_at: number;
  updated_at: number;
}

export type PlanTransitionState =
  | "requested"
  | "reserving"
  | "resizing"
  | "waiting_capacity"
  | "failed_retryable"
  | "complete"
  | "cancelled";

export interface ContainerPlanTransitionRow {
  container_id: string;
  from_tier: Tier;
  to_tier: Tier;
  target_disk_gb: number;
  prior_status: "running" | "stopped";
  state: PlanTransitionState;
  reserved_cpu: number;
  reserved_ram_mb: number;
  reserved_disk_gb: number;
  requested_at: number;
  updated_at: number;
  last_error_code: string | null;
}

export interface CredentialsRow {
  user_id: string;
  github_token: string | null;
  github_refresh_token: string | null;
  github_expires_at: number | null;
  github_login: string | null;
  cloudflare_token: string | null;
  supabase_token: string | null;
  convex_token: string | null;
  wrangler_oauth: string | null;
  llm_keys: string | null;
  rotated_at: number | null;
}

export interface JobRow {
  id: string;
  container_id: string;
  op: JobOp;
  status: JobStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface AppContext {
  Bindings: Bindings;
  Variables: {
    user: UserRow;
  };
}
