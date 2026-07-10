/**
 * Wire-contract schema tests: both the Worker and the daemon validate against
 * these schemas, so their strictness is what keeps the two sides honest (§18
 * principle 5) — and what keeps unexpected fields (e.g. plaintext credential
 * fields) off the wire.
 */
import { describe, expect, it } from "vitest";
import {
  ContainerSpecSchema,
  INPUT_LIMITS,
  JobRequestSchema,
  JobStatusResponseSchema,
  GithubRepoNameSchema,
  LlmKeysSchema,
} from "../src/types.js";

const spec = {
  agents: ["claude"],
  tier: "free",
  cpu: 1,
  ramMb: 2048,
  diskGb: 8,
  sshPort: 30500,
};
const base = { jobId: "j-1", containerId: "c-1" };

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
    // Kept compatible during daemon-first rolling deploys.
    expect(JobRequestSchema.safeParse({ op: "start", ...base }).success).toBe(true);
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
  it("accepts any subset of known providers and nothing else", () => {
    expect(LlmKeysSchema.safeParse({}).success).toBe(true);
    expect(LlmKeysSchema.safeParse({ anthropic: "k" }).success).toBe(true);
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
  });
});

describe("GithubRepoNameSchema", () => {
  it("accepts owner/name and rejects path traversal or extra path components", () => {
    expect(GithubRepoNameSchema.safeParse("octocat/hello-world").success).toBe(true);
    for (const name of ["../secret", "owner/..", "owner/repo/extra", "/repo", "owner/"]) {
      expect(GithubRepoNameSchema.safeParse(name).success).toBe(false);
    }
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
