import { z } from "zod";

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export const AGENTS = ["pi", "claude", "codex", "opencode"] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<Agent, string> = {
  pi: "Pi",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "opencode_go",
  "claude_subscription_token",
  "codex_subscription_token",
  "github_copilot",
  "deepseek",
  "kimi",
  "minimax",
  "zai",
  "vercel_ai_gateway",
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google (Gemini)",
  openrouter: "OpenRouter",
  opencode_go: "OpenCode Go",
  claude_subscription_token: "Claude subscription",
  codex_subscription_token: "ChatGPT (Codex)",
  github_copilot: "GitHub Copilot",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  minimax: "MiniMax",
  zai: "Z.AI",
  vercel_ai_gateway: "Vercel AI Gateway",
};

/**
 * Credentials that only ever enter the system through a control-plane OAuth
 * flow (device code / PKCE). The credentials API refuses pasted values for
 * these; an empty string (deletion) is still allowed.
 */
export const OAUTH_ONLY_LLM_PROVIDERS = [
  "claude_subscription_token",
  "codex_subscription_token",
  "github_copilot",
] as const satisfies readonly LlmProvider[];

export const CONTAINER_STATUSES = [
  "waitlisted",
  "provisioning",
  "running",
  "stopped",
  "suspended",
  "upgrade_pending",
  "error",
  "destroying",
] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

const JOB_OPS = [
  "provision",
  "start",
  "stop",
  "resize",
  "rebuild",
  "destroy",
  "refresh-credentials",
  "sync-keys",
  "export-window",
] as const;
export type JobOp = (typeof JOB_OPS)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TIERS = {
  free: { cpu: 1, ramMb: 2048, diskGb: 5 },
  paid: { cpu: 2, ramMb: 4096, diskGb: 8 },
} as const;
export type Tier = keyof typeof TIERS;

export const INPUT_LIMITS = {
  sshKeyBytes: 4096,
  sshKeysPerAccount: 64,
  tokenBytes: 16 * 1024,
  codexAuthBytes: 64 * 1024,
  cloudflareTokenBytes: 4096,
  credentialPayloadBytes: 256 * 1024,
  sealedCredentialBytes: 384 * 1024,
  jobRequestBytes: 1024 * 1024,
  githubReposPerProvision: 20,
} as const;

// ---------------------------------------------------------------------------
// Credential payloads (sealed to host key; never persisted in job rows)
// ---------------------------------------------------------------------------

export const LlmKeysSchema = z
  .object({
    openai: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    anthropic: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    gemini: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    openrouter: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    opencode_go: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    claude_subscription_token: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    codex_subscription_token: z.string().max(INPUT_LIMITS.codexAuthBytes).optional(),
    github_copilot: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    deepseek: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    kimi: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    minimax: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    zai: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    vercel_ai_gateway: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
  })
  .strict();
export type LlmKeys = z.infer<typeof LlmKeysSchema>;

/**
 * Wrangler's on-disk login state (config/default.toml), produced by the
 * control-plane "Sign in with Cloudflare" PKCE flow. Travels as a JSON string
 * (like the Codex auth.json blob) so presence markers stay uniform; the
 * daemon parses it with this schema before rendering the TOML.
 */
export const WranglerOauthSchema = z
  .object({
    oauth_token: z.string().max(INPUT_LIMITS.tokenBytes),
    refresh_token: z.string().max(INPUT_LIMITS.tokenBytes),
    expiration_time: z.string().max(64),
    scopes: z.array(z.string().max(64)).max(64),
  })
  .strict();
export type WranglerOauth = z.infer<typeof WranglerOauthSchema>;

function jsonUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const CredentialPayloadSchema = z
  .object({
    llmKeys: LlmKeysSchema.optional(),
    cloudflareToken: z.string().max(INPUT_LIMITS.cloudflareTokenBytes).optional(),
    wranglerOauth: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    githubToken: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    githubLogin: z.string().max(256).optional(),
  })
  .strict()
  .refine(
    (payload) => jsonUtf8Bytes(payload) <= INPUT_LIMITS.credentialPayloadBytes,
    "credential payload exceeds the aggregate byte limit",
  );
export type CredentialPayload = z.infer<typeof CredentialPayloadSchema>;

// ---------------------------------------------------------------------------
// Job requests (Worker -> daemon)
// ---------------------------------------------------------------------------

const base = {
  jobId: z.string().min(1).max(128),
  containerId: z.string().min(1).max(128),
};

// Key comments may contain multibyte characters, so the per-key limit is
// enforced in UTF-8 bytes — the same unit as the aggregate job budget. A
// code-unit count would let maximal multibyte keys plus credentials exceed
// INPUT_LIMITS.jobRequestBytes and make otherwise valid `start` jobs fail.
const SshKeysSchema = z
  .array(
    z
      .string()
      .min(1)
      .refine(
        (key) => utf8Bytes(key) <= INPUT_LIMITS.sshKeyBytes,
        "ssh key exceeds the byte limit",
      ),
  )
  .max(INPUT_LIMITS.sshKeysPerAccount);

/**
 * Monotonic ordering token for desired-state snapshots (the control plane's
 * job rowid). The daemon skips a snapshot whose revision it has already
 * matched or beaten, so a delayed older job cannot overwrite newer state.
 * Optional for rolling compatibility with older Workers.
 */
const SnapshotRevisionSchema = z.number().int().positive();
const DashboardUrlSchema = z.string().url().max(2048);
const SealedCredentialsSchema = z.string().min(1).max(INPUT_LIMITS.sealedCredentialBytes);
export const AgentsSchema = z.array(z.enum(AGENTS)).min(1).max(AGENTS.length);
export const GithubRepoNameSchema = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(
    (name) => name.split("/").every((component) => component !== "." && component !== ".."),
    "repository path components cannot be dot segments",
  );
export const GithubReposSchema = z
  .array(GithubRepoNameSchema)
  .max(INPUT_LIMITS.githubReposPerProvision)
  .refine((repositories) => {
    const cloneTargets = repositories.map((repository) =>
      repository.slice(repository.indexOf("/") + 1).toLowerCase()
    );
    return new Set(cloneTargets).size === cloneTargets.length;
  }, "repository clone targets must be unique");

export const ContainerSpecSchema = z
  .object({
    agents: AgentsSchema,
    tier: z.enum(["free", "paid"]),
    cpu: z.number().int().positive(),
    ramMb: z.number().int().positive(),
    diskGb: z.number().int().positive(),
    sshPort: z.number().int().min(1024).max(65535),
  })
  .strict();

export const JobRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("provision"),
      ...base,
      spec: ContainerSpecSchema,
      sshKeys: SshKeysSchema,
      dashboardUrl: DashboardUrlSchema,
      githubRepos: GithubReposSchema.default([]),
      // base64 sealed box of CredentialPayload (may be absent if user skipped all)
      sealedCredentials: SealedCredentialsSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("start"),
      ...base,
      // Optional for rolling compatibility with older Workers. Current
      // Workers include a full snapshot so changes made while stopped apply
      // before SSH becomes available again.
      sshKeys: SshKeysSchema.optional(),
      dashboardUrl: DashboardUrlSchema.optional(),
      sealedCredentials: SealedCredentialsSchema.optional(),
    })
    .strict(),
  z.object({ op: z.literal("stop"), ...base }).strict(),
  z
    .object({
      op: z.literal("resize"),
      ...base,
      spec: ContainerSpecSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("rebuild"),
      ...base,
      spec: ContainerSpecSchema,
      sshKeys: SshKeysSchema,
      dashboardUrl: DashboardUrlSchema,
      githubRepos: GithubReposSchema.default([]),
      sealedCredentials: SealedCredentialsSchema.optional(),
    })
    .strict(),
  z.object({ op: z.literal("destroy"), ...base }).strict(),
  z
    .object({
      op: z.literal("refresh-credentials"),
      ...base,
      dashboardUrl: DashboardUrlSchema,
      sealedCredentials: SealedCredentialsSchema,
      revision: SnapshotRevisionSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("sync-keys"),
      ...base,
      sshKeys: SshKeysSchema,
      dashboardUrl: DashboardUrlSchema,
      revision: SnapshotRevisionSchema.optional(),
    })
    .strict(),
  z.object({ op: z.literal("export-window"), ...base }).strict(),
]).refine(
  (request) => jsonUtf8Bytes(request) <= INPUT_LIMITS.jobRequestBytes,
  "job request exceeds the aggregate byte limit",
);
export type JobRequest = z.infer<typeof JobRequestSchema>;

// ---------------------------------------------------------------------------
// Job status / results (daemon -> Worker)
// ---------------------------------------------------------------------------

export const ProvisionResultSchema = z
  .object({
    hostKeyFingerprints: z.array(z.string()),
  })
  .strict();
export type ProvisionResult = z.infer<typeof ProvisionResultSchema>;

export const JobStatusResponseSchema = z
  .object({
    jobId: z.string(),
    status: z.enum(JOB_STATUSES),
    // Error strings must reference credential *kinds*, never values (§10).
    error: z.string().nullable(),
    result: ProvisionResultSchema.nullable(),
  })
  .strict();
export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>;

const ContainerStatSchema = z
  .object({
    containerId: z.string(),
    incusStatus: z.string(), // Running | Stopped | ...
  })
  .strict();

export const StatsResponseSchema = z
  .object({
    hostId: z.string(),
    containers: z.array(ContainerStatSchema),
    ramTotalMb: z.number(),
    // Optional for daemon-first/Worker-first rolling compatibility.
    ramAvailableMb: z.number().nonnegative().optional(),
    cpuLogical: z.number().int().positive().optional(),
    loadAverage1: z.number().nonnegative().optional(),
    uptimeSec: z.number(),
    hostUptimeSec: z.number().nonnegative().optional(),
  })
  .strict();
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const HealthResponseSchema = z
  .object({ ok: z.boolean(), hostId: z.string(), version: z.string() })
  .strict();
