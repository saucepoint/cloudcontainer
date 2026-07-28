import type { ContainerStatus, JobOp, JobStatus, Tier } from "@workbench/contract";

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
  // secrets
  BETTER_AUTH_SECRET: string;
  CREDENTIAL_MASTER_KEY: string;
  WORKER_RPC_PRIVATE_KEY: string;
  AUTH_GOOGLE_CLIENT_SECRET?: string;
  AUTH_GITHUB_CLIENT_SECRET?: string;
  WORLD_ID_SIGNING_KEY?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** Protects the admin-only invite generation endpoint. Set with `wrangler secret put`. */
  INVITE_ADMIN_SECRET?: string;
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
  status: string;
  joined_at: number;
  last_seen_at: number | null;
  consecutive_failures: number;
}

export interface ContainerRow {
  id: string;
  user_id: string;
  host_id: string | null;
  ssh_port: number | null;
  agents: string; // JSON array of Agent, e.g. '["claude","codex"]'
  github_repos: string; // JSON array of owner/name repositories cloned on provision
  tier: Tier;
  cpu: number;
  ram_mb: number;
  disk_gb: number;
  status: ContainerStatus;
  status_detail: string | null;
  host_key_fingerprints: string | null;
  suspended_at: number | null;
  created_at: number;
  last_upgraded_at: number | null;
}

export interface CredentialsRow {
  user_id: string;
  github_token: string | null;
  github_refresh_token: string | null;
  github_expires_at: number | null;
  github_login: string | null;
  cloudflare_token: string | null;
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
