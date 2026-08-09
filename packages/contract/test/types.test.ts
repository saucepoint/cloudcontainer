/**
 * Wire-contract schema tests: both the Worker and the daemon validate against
 * these schemas, so their strictness is what keeps the two sides honest (§18
 * principle 5) — and what keeps unexpected fields (e.g. plaintext credential
 * fields) off the wire.
 */
import { describe, expect, it } from "vitest";
import { generateX25519Keypair, sealJson } from "../src/crypto.js";
import {
  CHATGPT_OAUTH_PROVIDERS,
  CLAUDE_OAUTH_PROVIDERS,
  ContainerSpecSchema,
  CredentialPayloadSchema,
  INPUT_LIMITS,
  JobRequestSchema,
  JobStatusResponseSchema,
  GithubRepoNameSchema,
  GithubReposSchema,
  HostFleetUpdateSchema,
  HostRegistrationSchema,
  HOST_RAM_OVERCOMMIT,
  HOST_RAM_OVERCOMMIT_DENOMINATOR,
  HOST_RAM_OVERCOMMIT_NUMERATOR,
  HOST_RAM_RESERVE_PERCENT,
  HOST_TYPES,
  TENANCY_MODES,
  LLM_PROVIDERS,
  LlmKeysSchema,
  MAX_HOST_VCPU_OVERCOMMIT,
  MIN_HOST_RAM_RESERVE_MB,
  TIERS,
  SERVICE_PLANS,
  cpuTenantCeiling,
  hostCpuRamTenantCeiling,
  minimumHostRamReserveMb,
  ramTenantCeiling,
} from "../src/types.js";

const spec = {
  agents: ["claude"],
  tier: "free",
  cpu: 1,
  ramMb: 1536,
  diskGb: 5,
  sshPort: 30500,
};
const base = { jobId: "j-1", containerId: "c-1" };

describe("tier capacities", () => {
  it("gives the free tier 1.5 GiB RAM, 1 GiB swap, and 5 GiB disk", () => {
    expect(TIERS.free.cpu).toBe(1);
    expect(TIERS.free.provisionedCpu).toBe(1);
    expect(TIERS.free.ramMb).toBe(1536);
    expect(TIERS.free.swapMb).toBe(1024);
    expect(TIERS.free.diskGb).toBe(5);
  });

  it("keeps the paid tier at 8 GiB disk without swap", () => {
    expect(TIERS.paid.cpu).toBe(2);
    expect(TIERS.paid.provisionedCpu).toBe(3);
    expect(TIERS.paid.swapMb).toBe(0);
    expect(TIERS.paid.diskGb).toBe(8);
  });

  it("maps free and paid plans to shared tenancy while keeping dedicated isolated", () => {
    expect(HOST_TYPES).toEqual(["budget", "regular", "dedicated"]);
    expect(TENANCY_MODES).toEqual(["shared", "dedicated"]);
    expect(SERVICE_PLANS).toEqual({
      free: { tier: "free", tenancyMode: "shared", hostType: "budget" },
      paid: { tier: "paid", tenancyMode: "shared", hostType: "regular" },
      dedicated: { tier: "paid", tenancyMode: "dedicated", hostType: "dedicated" },
    });
  });

  it("reserves the greater of 3 GiB or a rounded-up 8% of host RAM", () => {
    expect(MIN_HOST_RAM_RESERVE_MB).toBe(3072);
    expect(HOST_RAM_RESERVE_PERCENT).toBe(8);
    expect(minimumHostRamReserveMb(8192)).toBe(3072);
    expect(minimumHostRamReserveMb(38400)).toBe(3072);
    expect(minimumHostRamReserveMb(38401)).toBe(3073);
    expect(minimumHostRamReserveMb(65536)).toBe(5243);
    expect(MAX_HOST_VCPU_OVERCOMMIT).toBe(4);
    expect(HOST_RAM_OVERCOMMIT).toBe(1.25);
    expect(HOST_RAM_OVERCOMMIT_NUMERATOR).toBe(5);
    expect(HOST_RAM_OVERCOMMIT_DENOMINATOR).toBe(4);
  });

  it("rounds up CPU and 1.25x RAM tenant ceilings", () => {
    expect(cpuTenantCeiling(16, "paid")).toBe(6);
    expect(ramTenantCeiling(8192, 3072, "free")).toBe(5);
    expect(hostCpuRamTenantCeiling({
      ramTotalMb: 8192,
      ramReserveMb: 3072,
      vcpuCapacity: 16,
    }, "free")).toBe(5);
  });
});

describe("HostRegistrationSchema", () => {
  const host = {
    id: "budget-fsn-1",
    hostType: "budget",
    ipv4: "192.0.2.10",
    sshHostname: "ssh-1.example.test",
    daemonEndpoint: "https://daemon-1.example.test:8443",
    daemonPublicKey: generateX25519Keypair().publicKey,
    managementHostname: "management-1.example.test",
    managementPort: 22,
    managementUser: "root",
    ramTotalMb: 32768,
    ramReserveMb: 3072,
    vcpuCapacity: 24,
    diskTotalGb: 700,
    maxTenants: 12,
  };

  it("accepts public bootstrap metadata and rejects insecure endpoints", () => {
    expect(HostRegistrationSchema.safeParse(host).success).toBe(true);
    expect(HostRegistrationSchema.safeParse({
      ...host,
      daemonEndpoint: "http://daemon-1.example.test:8443",
    }).success).toBe(false);
    for (const daemonEndpoint of [
      "https://daemon-1.example.test:8443/",
      "https://operator:secret@daemon-1.example.test:8443",
      "https://daemon-1.example.test:8443/rpc",
      "https://daemon-1.example.test:8443?target=other",
    ]) {
      expect(HostRegistrationSchema.safeParse({ ...host, daemonEndpoint }).success).toBe(false);
    }
    expect(HostRegistrationSchema.safeParse({
      ...host,
      ramReserveMb: host.ramTotalMb,
    }).success).toBe(false);
    expect(HostRegistrationSchema.safeParse({
      ...host,
      daemonPublicKey: "c2hvcnQ=",
    }).success).toBe(false);
    expect(HostRegistrationSchema.safeParse({ ...host, maxTenants: 25 }).success).toBe(true);
    expect(HostRegistrationSchema.safeParse({
      ...host,
      ramTotalMb: 65536,
      ramReserveMb: 5242,
    }).success).toBe(false);
  });

  it("keeps the operational tenant ceiling independent of mixed resource admission", () => {
    const ramConstrained = {
      ...host,
      ramTotalMb: 8192,
      ramReserveMb: 3072,
      vcpuCapacity: 16,
      diskTotalGb: 100,
      maxTenants: 5,
    };
    expect(HostRegistrationSchema.safeParse(ramConstrained).success).toBe(true);
    expect(HostRegistrationSchema.safeParse({
      ...ramConstrained,
      maxTenants: 6,
    }).success).toBe(true);

    const cpuConstrained = {
      ...host,
      ramTotalMb: 16384,
      ramReserveMb: 3072,
      vcpuCapacity: 4,
      diskTotalGb: 100,
      maxTenants: 4,
    };
    expect(HostRegistrationSchema.safeParse(cpuConstrained).success).toBe(true);
    expect(HostRegistrationSchema.safeParse({
      ...cpuConstrained,
      maxTenants: 5,
    }).success).toBe(true);
  });

  it("requires dedicated hosts to have exactly one slot and rejects assignments on shared hosts", () => {
    expect(HostRegistrationSchema.safeParse({
      ...host,
      id: "dedicated-1",
      hostType: "dedicated",
      maxTenants: 1,
      dedicatedUserId: "paid-user",
    }).success).toBe(true);
    expect(HostRegistrationSchema.safeParse({
      ...host,
      id: "dedicated-1",
      hostType: "dedicated",
      maxTenants: 2,
    }).success).toBe(false);
    expect(HostRegistrationSchema.safeParse({
      ...host,
      dedicatedUserId: "paid-user",
    }).success).toBe(false);
  });
});

describe("HostFleetUpdateSchema", () => {
  it("groups endpoint edits but separates state and capacity transitions", () => {
    expect(HostFleetUpdateSchema.safeParse({
      managementHostname: "new-management.example.test",
      daemonEndpoint: "https://new-daemon.example.test:8443",
    }).success).toBe(true);
    expect(HostFleetUpdateSchema.safeParse({
      status: "active",
      capacity: {
        ramTotalMb: 8192,
        ramReserveMb: 3072,
        vcpuCapacity: 6,
        diskTotalGb: 70,
        maxTenants: 4,
      },
    }).success).toBe(false);
    expect(HostFleetUpdateSchema.safeParse({ status: "draining", force: true }).success)
      .toBe(false);
    expect(HostFleetUpdateSchema.safeParse({ status: "draining", force: false }).success)
      .toBe(false);
    expect(HostFleetUpdateSchema.safeParse({ hostType: "regular" }).success).toBe(false);
    expect(HostFleetUpdateSchema.safeParse({
      hostType: "regular",
      capacity: {
        ramTotalMb: 16384,
        ramReserveMb: 3072,
        vcpuCapacity: 8,
        diskTotalGb: 160,
        maxTenants: 2,
      },
    }).success).toBe(true);
  });
});

describe("JobRequestSchema", () => {
  it("accepts a well-formed provision request", () => {
    const parsed = JobRequestSchema.safeParse({
      op: "provision",
      ...base,
      spec,
      sshKeys: [],
      dashboardUrl: "https://x",
      sealedCredentials: "abc",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown ops", () => {
    expect(JobRequestSchema.safeParse({ op: "melt-the-host", ...base }).success).toBe(false);
  });

  it("rejects unexpected fields (strict: no side channel for plaintext credentials)", () => {
    expect(
      JobRequestSchema.safeParse({ op: "stop", ...base, plaintextSecrets: "oops" }).success,
    ).toBe(false);
  });

  it("requires sealedCredentials on refresh-credentials but not on provision", () => {
    expect(
      JobRequestSchema.safeParse({ op: "refresh-credentials", ...base, dashboardUrl: "https://x" })
        .success,
    ).toBe(false);
    expect(
      JobRequestSchema.safeParse({
        op: "provision",
        ...base,
        spec,
        sshKeys: [],
        dashboardUrl: "https://x",
      }).success,
    ).toBe(true);
  });

  it("accepts a start request carrying the latest keys and sealed credential snapshot", () => {
    expect(
      JobRequestSchema.safeParse({
        op: "start",
        ...base,
        sshKeys: ["ssh-ed25519 AAAA test"],
        dashboardUrl: "https://x",
        sealedCredentials: "abc",
      }).success,
    ).toBe(true);
    // Kept compatible while a rolling fleet contains mixed daemon versions.
    expect(JobRequestSchema.safeParse({ op: "start", ...base }).success).toBe(true);
  });

  it("accepts an optional snapshot revision on desired-state sync ops", () => {
    for (const request of [
      { op: "sync-keys", sshKeys: [], dashboardUrl: "https://x" },
      { op: "refresh-credentials", dashboardUrl: "https://x", sealedCredentials: "abc" },
    ]) {
      expect(JobRequestSchema.safeParse({ ...request, ...base, revision: 7 }).success).toBe(true);
      expect(JobRequestSchema.safeParse({ ...request, ...base }).success).toBe(true);
      for (const revision of [0, -1, 1.5, "7"]) {
        expect(JobRequestSchema.safeParse({ ...request, ...base, revision }).success).toBe(false);
      }
    }
  });

  it("bounds ssh keys in UTF-8 bytes, matching the aggregate job budget", () => {
    const syncKeys = (sshKeys: string[]) =>
      JobRequestSchema.safeParse({ op: "sync-keys", ...base, sshKeys, dashboardUrl: "https://x" });
    // 4096 ASCII bytes: at the limit.
    expect(syncKeys(["x".repeat(INPUT_LIMITS.sshKeyBytes)]).success).toBe(true);
    // 4096 code units but 8192 UTF-8 bytes: a code-unit count would accept it.
    expect(syncKeys(["é".repeat(INPUT_LIMITS.sshKeyBytes)]).success).toBe(false);
    // Maximal multibyte keys plus maximal sealed credentials stay inside the
    // aggregate byte budget, so a valid start never fails schema validation.
    const request = {
      op: "start",
      ...base,
      sshKeys: Array.from(
        { length: INPUT_LIMITS.sshKeysPerAccount },
        (_, index) => `ssh-ed25519 AAAA key-${index} ${"é".repeat(100)}`,
      ),
      dashboardUrl: "https://x",
      sealedCredentials: "y".repeat(INPUT_LIMITS.sealedCredentialBytes),
    };
    expect(JobRequestSchema.safeParse(request).success).toBe(true);
  });

  it("requires at least one agent in a spec", () => {
    expect(ContainerSpecSchema.safeParse({ ...spec, agents: [] }).success).toBe(false);
    expect(ContainerSpecSchema.safeParse({ ...spec, agents: ["vim"] }).success).toBe(false);
  });

  it("bounds the ssh port to the unprivileged range", () => {
    expect(ContainerSpecSchema.safeParse({ ...spec, sshPort: 22 }).success).toBe(false);
    expect(ContainerSpecSchema.safeParse({ ...spec, sshPort: 70000 }).success).toBe(false);
  });
});

describe("LlmKeysSchema", () => {
  it("maps each subscription sign-in to a distinct per-agent credential", () => {
    expect(new Set(Object.values(CLAUDE_OAUTH_PROVIDERS)).size).toBe(3);
    expect(new Set(Object.values(CHATGPT_OAUTH_PROVIDERS)).size).toBe(3);
    expect(CHATGPT_OAUTH_PROVIDERS).toMatchObject({
      pi: "pi_codex_subscription_token",
      codex: "codex_subscription_token",
      opencode: "opencode_codex_subscription_token",
    });
    expect(CLAUDE_OAUTH_PROVIDERS).toMatchObject({
      pi: "pi_claude_subscription_token",
      claude: "claude_subscription_token",
      opencode: "opencode_claude_subscription_token",
    });
  });

  it("accepts any subset of known providers and nothing else", () => {
    expect(LlmKeysSchema.safeParse({}).success).toBe(true);
    for (const provider of LLM_PROVIDERS) {
      expect(LlmKeysSchema.safeParse({ [provider]: "k" }).success).toBe(true);
    }
    expect(LlmKeysSchema.safeParse({ made_up_provider: "k" }).success).toBe(false);
  });

  it("bounds credential values before they cross the host RPC boundary", () => {
    expect(
      LlmKeysSchema.safeParse({ openai: "x".repeat(INPUT_LIMITS.tokenBytes + 1) }).success,
    ).toBe(false);
    expect(
      LlmKeysSchema.safeParse({
        codex_subscription_token: "x".repeat(INPUT_LIMITS.codexAuthBytes + 1),
      }).success,
    ).toBe(false);
    expect(
      LlmKeysSchema.safeParse({
        opencode_codex_subscription_token: "x".repeat(INPUT_LIMITS.codexAuthBytes + 1),
      }).success,
    ).toBe(false);
  });
});

describe("aggregate request budgets", () => {
  function maximalPayload(fill: string) {
    return {
      llmKeys: {
        openai: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
        anthropic: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
        gemini: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
        openrouter: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
        opencode_go: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
        claude_subscription_token: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
        codex_subscription_token: fill.repeat(INPUT_LIMITS.codexAuthBytes / fill.length),
        github_copilot: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
        // The aggregate payload budget is smaller than every provider's
        // individual maximum, so include newer providers at a minimal value.
        deepseek: fill,
        kimi: fill,
        minimax: fill,
        zai: fill,
        vercel_ai_gateway: fill,
      },
      cloudflareToken: fill.repeat(INPUT_LIMITS.cloudflareTokenBytes / fill.length),
      supabaseToken: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
      convexToken: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
      wranglerOauth: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
      githubToken: fill.repeat(INPUT_LIMITS.tokenBytes / fill.length),
      githubLogin: fill.repeat(256 / fill.length),
    };
  }

  it("accepts, seals, and transports the maximal ASCII credential combination", () => {
    const payload = CredentialPayloadSchema.parse(maximalPayload("x"));
    const sealed = sealJson(payload, generateX25519Keypair().publicKey);
    expect(sealed.length).toBeLessThanOrEqual(INPUT_LIMITS.sealedCredentialBytes);

    const request = {
      op: "provision",
      jobId: "j-max",
      containerId: "c-max",
      spec,
      sshKeys: Array.from(
        { length: INPUT_LIMITS.sshKeysPerAccount },
        () => "x".repeat(INPUT_LIMITS.sshKeyBytes),
      ),
      dashboardUrl: "https://workbench.example",
      githubRepos: [],
      sealedCredentials: sealed,
    };
    expect(new TextEncoder().encode(JSON.stringify(request)).byteLength)
      .toBeLessThanOrEqual(INPUT_LIMITS.jobRequestBytes);
    expect(JobRequestSchema.safeParse(request).success).toBe(true);
  });

  it("rejects a character-valid payload that exceeds the UTF-8 aggregate budget", () => {
    expect(CredentialPayloadSchema.safeParse(maximalPayload("💥")).success).toBe(false);
  });
});

describe("GithubRepoNameSchema", () => {
  it("accepts owner/name and rejects path traversal or extra path components", () => {
    expect(GithubRepoNameSchema.safeParse("octocat/hello-world").success).toBe(true);
    for (const name of ["../secret", "owner/..", "owner/repo/extra", "/repo", "owner/"]) {
      expect(GithubRepoNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("rejects repositories that would clone to the same case-insensitive path", () => {
    expect(GithubReposSchema.safeParse(["first/tools", "second/TOOLS"]).success).toBe(false);
    expect(GithubReposSchema.safeParse(["first/api", "second/web"]).success).toBe(true);
  });
});

describe("JobStatusResponseSchema", () => {
  it("round-trips a terminal status with a provision result", () => {
    const parsed = JobStatusResponseSchema.safeParse({
      jobId: "j-1",
      status: "succeeded",
      error: null,
      result: { hostKeyFingerprints: ["256 SHA256:x (ED25519)"] },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects statuses outside the enum", () => {
    expect(
      JobStatusResponseSchema.safeParse({ jobId: "j", status: "exploded", error: null, result: null })
        .success,
    ).toBe(false);
  });
});
