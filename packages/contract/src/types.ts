import { z } from "zod";

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export const AGENTS = ["pi", "opencode", "codex", "claude"] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<Agent, string> = {
  pi: "Pi",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** Official home pages for each supported coding agent. */
export const AGENT_HOMES: Record<Agent, string> = {
  pi: "https://pi.dev",
  claude: "https://claude.com/claude-code",
  codex: "https://openai.com/codex",
  opencode: "https://opencode.ai",
};

export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "opencode_go",
  "claude_subscription_token",
  "codex_subscription_token",
  "pi_claude_subscription_token",
  "pi_codex_subscription_token",
  "opencode_claude_subscription_token",
  "opencode_codex_subscription_token",
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
  pi_claude_subscription_token: "Claude for Pi",
  pi_codex_subscription_token: "ChatGPT for Pi",
  opencode_claude_subscription_token: "Claude for OpenCode",
  opencode_codex_subscription_token: "ChatGPT for OpenCode",
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
  "pi_claude_subscription_token",
  "pi_codex_subscription_token",
  "opencode_claude_subscription_token",
  "opencode_codex_subscription_token",
  "github_copilot",
] as const satisfies readonly LlmProvider[];

export const CLAUDE_OAUTH_AGENTS = ["pi", "claude", "opencode"] as const;
export type ClaudeOauthAgent = (typeof CLAUDE_OAUTH_AGENTS)[number];
export const CLAUDE_OAUTH_PROVIDERS: Record<ClaudeOauthAgent, LlmProvider> = {
  pi: "pi_claude_subscription_token",
  claude: "claude_subscription_token",
  opencode: "opencode_claude_subscription_token",
};

export const CHATGPT_OAUTH_AGENTS = ["pi", "codex", "opencode"] as const;
export type ChatgptOauthAgent = (typeof CHATGPT_OAUTH_AGENTS)[number];
export const CHATGPT_OAUTH_PROVIDERS: Record<ChatgptOauthAgent, LlmProvider> = {
  pi: "pi_codex_subscription_token",
  codex: "codex_subscription_token",
  opencode: "opencode_codex_subscription_token",
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

const JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TIERS = {
  // `cpu` is the public plan value. `provisionedCpu` is both the Incus limit
  // and the amount reserved from a host's independently registered capacity.
  free: { cpu: 1, provisionedCpu: 1, ramMb: 1536, swapMb: 1024, diskGb: 5 },
  paid: { cpu: 2, provisionedCpu: 2, ramMb: 4096, swapMb: 1536, diskGb: 8 },
} as const;
export type Tier = keyof typeof TIERS;

export const HOST_TYPES = ["budget", "regular", "dedicated"] as const;
const HostTypeSchema = z.enum(HOST_TYPES);
export type HostType = z.infer<typeof HostTypeSchema>;

export const TENANCY_MODES = ["shared", "dedicated"] as const;
const TenancyModeSchema = z.enum(TENANCY_MODES);
export type TenancyMode = z.infer<typeof TenancyModeSchema>;

export const MIN_HOST_RAM_RESERVE_MB = 3072;
export const HOST_RAM_RESERVE_PERCENT = 8;
export const HOST_VCPU_OVERCOMMIT = 4;
export const HOST_RAM_OVERCOMMIT_NUMERATOR = 5;
export const HOST_RAM_OVERCOMMIT_DENOMINATOR = 4;

export function minimumHostRamReserveMb(ramTotalMb: number): number {
  return Math.max(
    MIN_HOST_RAM_RESERVE_MB,
    Math.ceil((ramTotalMb * HOST_RAM_RESERVE_PERCENT) / 100),
  );
}

/**
 * Billing remains separate from placement. A dedicated subscription is still
 * a paid account; it selects an exclusively assigned dedicated host rather
 * than the shared regular pool.
 */
export const SERVICE_PLANS = {
  // placementClass is persisted for backward-compatible container/rehome rows.
  // It is never an input to shared-host scheduling, which keys on tenancyMode.
  free: { tier: "free", tenancyMode: "shared", placementClass: "budget" },
  paid: { tier: "paid", tenancyMode: "shared", placementClass: "regular" },
  dedicated: { tier: "paid", tenancyMode: "dedicated", placementClass: "dedicated" },
} as const satisfies Record<
  string,
  { tier: Tier; tenancyMode: TenancyMode; placementClass: HostType }
>;
export type ServicePlan = keyof typeof SERVICE_PLANS;

const HOST_STATUSES = ["active", "draining", "unhealthy", "dead"] as const;
const HostStatusSchema = z.enum(HOST_STATUSES);
export type HostStatus = z.infer<typeof HostStatusSchema>;

const ManagementHostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, "invalid management hostname");

const HostSshHostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9._:-]+$/, "invalid tenant SSH hostname");

const DaemonEndpointSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const endpoint = new URL(value);
    return endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.pathname === "/" &&
      endpoint.search === "" &&
      endpoint.hash === "" &&
      !value.endsWith("/");
  }, "daemon endpoint must be an HTTPS origin without credentials, path, query, hash, or trailing slash");

function validateHostRamReserve(
  capacity: { ramTotalMb: number; ramReserveMb: number },
  context: z.RefinementCtx,
): void {
  if (capacity.ramReserveMb >= capacity.ramTotalMb) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ramReserveMb"],
      message: "RAM reserve must be smaller than total RAM",
    });
  }
  if (capacity.ramReserveMb < minimumHostRamReserveMb(capacity.ramTotalMb)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ramReserveMb"],
      message: "RAM reserve must be at least 3072 MiB or rounded-up 8% of total RAM, whichever is larger",
    });
  }
}

const HostCapacitySchema = z
  .object({
    ramTotalMb: z.number().int().positive(),
    ramReserveMb: z.number().int().nonnegative(),
    vcpuCapacity: z.number().int().positive(),
    diskTotalGb: z.number().int().positive(),
    maxTenants: z.number().int().positive(),
  })
  .strict()
  .superRefine(validateHostRamReserve);
export type HostCapacity = z.infer<typeof HostCapacitySchema>;

/** Public, non-secret host metadata produced by bootstrap and registered by an administrator. */
export const HostRegistrationSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
    hostType: HostTypeSchema,
    ipv4: z.string().ip({ version: "v4" }),
    ipv6: z.string().ip({ version: "v6" }).optional(),
    sshHostname: HostSshHostnameSchema,
    daemonEndpoint: DaemonEndpointSchema,
    daemonCertFingerprint: z.string().min(1).max(256).optional(),
    daemonPublicKey: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/, "daemon public key must encode exactly 32 bytes"),
    managementHostname: ManagementHostnameSchema,
    managementPort: z.number().int().min(1).max(65535).default(22),
    managementUser: z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/).default("root"),
    ramTotalMb: z.number().int().positive(),
    ramReserveMb: z.number().int().nonnegative(),
    vcpuCapacity: z.number().int().positive(),
    diskTotalGb: z.number().int().positive(),
    maxTenants: z.number().int().positive(),
    dedicatedUserId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((host, context) => {
    validateHostRamReserve(host, context);
    if (host.hostType === "dedicated" && host.maxTenants !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxTenants"],
        message: "dedicated hosts must have exactly one tenant slot",
      });
    }
    if (host.hostType !== "dedicated" && host.dedicatedUserId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dedicatedUserId"],
        message: "only dedicated hosts can be assigned to one account",
      });
    }
    const dedicatedFitsPaid = host.vcpuCapacity >= TIERS.paid.provisionedCpu &&
      (host.ramTotalMb - host.ramReserveMb) * HOST_RAM_OVERCOMMIT_NUMERATOR >=
        TIERS.paid.ramMb * HOST_RAM_OVERCOMMIT_DENOMINATOR &&
      host.diskTotalGb >= TIERS.paid.diskGb * 2;
    if (host.hostType === "dedicated" && !dedicatedFitsPaid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxTenants"],
        message: "dedicated host cannot fit the paid resource reservation",
      });
    }
  });
/** Validated host mutations accepted by the secret-authenticated fleet API. */
export const HostFleetUpdateSchema = z
  .object({
    status: z.enum(["active", "draining", "dead"]).optional(),
    hostType: HostTypeSchema.optional(),
    dedicatedUserId: z.string().min(1).max(128).nullable().optional(),
    sshHostname: HostSshHostnameSchema.optional(),
    daemonEndpoint: DaemonEndpointSchema.optional(),
    managementHostname: ManagementHostnameSchema.optional(),
    managementPort: z.number().int().min(1).max(65535).optional(),
    managementUser: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z_][a-z0-9_-]*$/)
      .optional(),
    capacity: HostCapacitySchema.optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.hostType !== undefined ||
      value.dedicatedUserId !== undefined ||
      value.sshHostname !== undefined ||
      value.daemonEndpoint !== undefined ||
      value.managementHostname !== undefined ||
      value.managementPort !== undefined ||
      value.managementUser !== undefined ||
      value.capacity !== undefined,
    "host update is empty",
  )
  .superRefine((value, context) => {
    const endpointUpdate = value.sshHostname !== undefined ||
      value.daemonEndpoint !== undefined ||
      value.managementHostname !== undefined ||
      value.managementPort !== undefined ||
      value.managementUser !== undefined;
    const mutationGroups = [
      value.status !== undefined,
      value.dedicatedUserId !== undefined,
      value.capacity !== undefined || value.hostType !== undefined,
      endpointUpdate,
    ].filter(Boolean).length;
    if (mutationGroups > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "combine endpoint fields only; submit state, assignment, and capacity separately",
      });
    }
    if (value.force !== undefined && value.status !== "dead") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["force"],
        message: "force is valid only when retiring a host",
      });
    }
    if (value.hostType !== undefined && value.capacity === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capacity"],
        message: "host class changes require a fresh capacity report",
      });
    }
  });
/** An orderly re-home destroys the old Incus container before re-provisioning. */
export const ContainerRehomeSchema = z
  .object({ confirmDataLoss: z.literal(true) })
  .strict();
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
    pi_claude_subscription_token: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    pi_codex_subscription_token: z.string().max(INPUT_LIMITS.codexAuthBytes).optional(),
    opencode_claude_subscription_token: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    opencode_codex_subscription_token: z.string().max(INPUT_LIMITS.codexAuthBytes).optional(),
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
    supabaseToken: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
    convexToken: z.string().max(INPUT_LIMITS.tokenBytes).optional(),
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
    // Optional while a rolling fleet contains mixed daemon versions.
    hostType: HostTypeSchema.optional(),
    tenancyMode: TenancyModeSchema.optional(),
    /** Accepted from the previous daemon release; current placement ignores it. */
    capabilities: z.array(z.string().min(1).max(128)).max(32).optional(),
    version: z.string().min(1).max(128).optional(),
    containers: z.array(ContainerStatSchema),
    ramTotalMb: z.number(),
    ramAvailableMb: z.number().nonnegative().optional(),
    cpuLogical: z.number().int().positive().optional(),
    loadAverage1: z.number().nonnegative().optional(),
    uptimeSec: z.number(),
    hostUptimeSec: z.number().nonnegative().optional(),
  })
  .strict();
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    hostId: z.string(),
    hostType: HostTypeSchema.optional(),
    tenancyMode: TenancyModeSchema.optional(),
    /** Accepted from the previous daemon release; current placement ignores it. */
    capabilities: z.array(z.string().min(1).max(128)).max(32).optional(),
    version: z.string(),
  })
  .strict();
