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
  "claude_subscription_token",
  "codex_subscription_token",
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google (Gemini)",
  openrouter: "OpenRouter",
  claude_subscription_token: "Claude subscription token",
  codex_subscription_token: "Codex subscription (auth.json)",
};

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

export const JOB_OPS = [
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
  free: { cpu: 1, ramMb: 2048, diskGb: 8 },
  paid: { cpu: 2, ramMb: 4096, diskGb: 32 },
} as const;
export type Tier = keyof typeof TIERS;

export const INPUT_LIMITS = {
  sshKeyBytes: 4096,
  sshKeysPerAccount: 64,
  tokenBytes: 16 * 1024,
  codexAuthBytes: 64 * 1024,
  cloudflareTokenBytes: 4096,
  sealedCredentialBytes: 256 * 1024,
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
    claude_subscription_token: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    codex_subscription_token: z.string().max(INPUT_LIMITS.codexAuthBytes).optional(),
  })
  .strict();
export type LlmKeys = z.infer<typeof LlmKeysSchema>;

export const CredentialPayloadSchema = z
  .object({
    llmKeys: LlmKeysSchema.optional(),
    cloudflareToken: z.string().max(INPUT_LIMITS.cloudflareTokenBytes).optional(),
    githubToken: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    githubLogin: z.string().max(256).optional(),
  })
  .strict();
export type CredentialPayload = z.infer<typeof CredentialPayloadSchema>;

// ---------------------------------------------------------------------------
// Job requests (Worker -> daemon)
// ---------------------------------------------------------------------------

const base = {
  jobId: z.string().min(1).max(128),
  containerId: z.string().min(1).max(128),
};

const SshKeysSchema = z
  .array(z.string().min(1).max(INPUT_LIMITS.sshKeyBytes))
  .max(INPUT_LIMITS.sshKeysPerAccount);
const DashboardUrlSchema = z.string().url().max(2048);
const SealedCredentialsSchema = z.string().min(1).max(INPUT_LIMITS.sealedCredentialBytes);

export const ContainerSpecSchema = z
  .object({
    agents: z.array(z.enum(AGENTS)).min(1).max(AGENTS.length),
    tier: z.enum(["free", "paid"]),
    cpu: z.number().int().positive(),
    ramMb: z.number().int().positive(),
    diskGb: z.number().int().positive(),
    sshPort: z.number().int().min(1024).max(65535),
  })
  .strict();
export type ContainerSpec = z.infer<typeof ContainerSpecSchema>;

export const JobRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("provision"),
      ...base,
      spec: ContainerSpecSchema,
      sshKeys: SshKeysSchema,
      dashboardUrl: DashboardUrlSchema,
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
    })
    .strict(),
  z
    .object({
      op: z.literal("sync-keys"),
      ...base,
      sshKeys: SshKeysSchema,
      dashboardUrl: DashboardUrlSchema,
    })
    .strict(),
  z.object({ op: z.literal("export-window"), ...base }).strict(),
]);
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

export const ContainerStatSchema = z
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
    uptimeSec: z.number(),
  })
  .strict();
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const HealthResponseSchema = z
  .object({ ok: z.boolean(), hostId: z.string(), version: z.string() })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
