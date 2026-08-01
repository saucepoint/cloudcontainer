import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { encryptJsonAtRest, INPUT_LIMITS } from "@workbench/contract";
import {
  buildCredentialPayload,
  decryptLlmKeys,
  getCredentialsRow,
  upsertCredentials,
  validateCloudflareToken,
  validateConvexToken,
  validateSupabaseToken,
} from "../src/credentials.js";
import { makeEnv, seedUser, stubFetch } from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

/** Fresh env with the referenced user present (FK enforced, as in D1). */
async function envWithUser() {
  const { env } = makeEnv();
  await seedUser(env);
  return env;
}

describe("upsertCredentials", () => {
  it("stores LLM keys encrypted and round-trips them", async () => {
    const env = await envWithUser();
    await upsertCredentials(env, "user-1", { llmKeys: { anthropic: "CANARY-ant-1" } });

    const row = await getCredentialsRow(env, "user-1");
    expect(row?.llm_keys).toBeTruthy();
    expect(row?.llm_keys).not.toContain("CANARY-ant-1"); // ciphertext only in D1
    expect(decryptLlmKeys(env, row)).toEqual({ anthropic: "CANARY-ant-1" });
  });

  it("rejects an aggregate UTF-8 payload overflow before storing anything", async () => {
    const env = await envWithUser();
    const token = "💥".repeat(INPUT_LIMITS.tokenBytes / 2);
    const codex = "💥".repeat(INPUT_LIMITS.codexAuthBytes / 2);

    await expect(upsertCredentials(env, "user-1", {
      llmKeys: {
        openai: token,
        anthropic: token,
        gemini: token,
        openrouter: token,
        opencode_go: token,
        claude_subscription_token: token,
        codex_subscription_token: codex,
        github_copilot: token,
      },
      cloudflareToken: "💥".repeat(INPUT_LIMITS.cloudflareTokenBytes / 2),
      wranglerOauth: token,
    })).rejects.toThrow("credential payload exceeds the aggregate byte limit");
    expect(await getCredentialsRow(env, "user-1")).toBeNull();
  });

  it("merges new keys and deletes keys set to the empty string", async () => {
    const env = await envWithUser();
    await upsertCredentials(env, "user-1", { llmKeys: { anthropic: "a", openai: "o" } });
    await upsertCredentials(env, "user-1", { llmKeys: { anthropic: "", gemini: "g" } });

    const row = await getCredentialsRow(env, "user-1");
    expect(decryptLlmKeys(env, row)).toEqual({ openai: "o", gemini: "g" });
  });

  it("sets and clears the Cloudflare token independently of LLM keys", async () => {
    const env = await envWithUser();
    await upsertCredentials(env, "user-1", { llmKeys: { openai: "o" }, cloudflareToken: "cf-1" });
    let row = await getCredentialsRow(env, "user-1");
    expect(buildCredentialPayload(env, row).cloudflareToken).toBe("cf-1");

    await upsertCredentials(env, "user-1", { cloudflareToken: "" });
    row = await getCredentialsRow(env, "user-1");
    expect(buildCredentialPayload(env, row).cloudflareToken).toBeUndefined();
    expect(decryptLlmKeys(env, row)).toEqual({ openai: "o" }); // untouched
  });

  it("stores and clears Supabase and Convex tokens independently", async () => {
    const env = await envWithUser();
    await upsertCredentials(env, "user-1", {
      supabaseToken: "CANARY-supabase",
      convexToken: "CANARY-convex",
    });

    let row = await getCredentialsRow(env, "user-1");
    expect(row?.supabase_token).not.toContain("CANARY-supabase");
    expect(row?.convex_token).not.toContain("CANARY-convex");
    expect(buildCredentialPayload(env, row)).toMatchObject({
      supabaseToken: "CANARY-supabase",
      convexToken: "CANARY-convex",
    });

    await upsertCredentials(env, "user-1", { supabaseToken: "" });
    row = await getCredentialsRow(env, "user-1");
    expect(buildCredentialPayload(env, row).supabaseToken).toBeUndefined();
    expect(buildCredentialPayload(env, row).convexToken).toBe("CANARY-convex");
  });

  it("stores the wrangler OAuth blob encrypted and clears it independently", async () => {
    const env = await envWithUser();
    const blob = JSON.stringify({ oauth_token: "CANARY-wr", refresh_token: "r", expiration_time: "t", scopes: [] });
    await upsertCredentials(env, "user-1", { cloudflareToken: "cf-1", wranglerOauth: blob });

    let row = await getCredentialsRow(env, "user-1");
    expect(row?.wrangler_oauth).not.toContain("CANARY-wr"); // ciphertext only in D1
    expect(buildCredentialPayload(env, row).wranglerOauth).toBe(blob);

    await upsertCredentials(env, "user-1", { wranglerOauth: "" });
    row = await getCredentialsRow(env, "user-1");
    expect(buildCredentialPayload(env, row).wranglerOauth).toBeUndefined();
    expect(buildCredentialPayload(env, row).cloudflareToken).toBe("cf-1"); // untouched
  });
});

describe("buildCredentialPayload", () => {
  it("returns an empty payload for a missing row", async () => {
    const { env } = makeEnv();
    expect(buildCredentialPayload(env, null)).toEqual({});
  });

  it("includes the short-lived GitHub token but NEVER the refresh token (§9/§10)", async () => {
    const env = await envWithUser();
    const key = env.CREDENTIAL_MASTER_KEY;
    await env.DB.prepare(
      `INSERT INTO credentials_encrypted (user_id, github_token, github_refresh_token, github_expires_at, github_login)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        "user-1",
        encryptJsonAtRest("CANARY-gh-access", key),
        encryptJsonAtRest("CANARY-gh-refresh", key),
        Date.now() + 3600_000,
        "octocat",
      )
      .run();

    const payload = buildCredentialPayload(env, await getCredentialsRow(env, "user-1"));
    expect(payload.githubToken).toBe("CANARY-gh-access");
    expect(payload.githubLogin).toBe("octocat");
    expect(JSON.stringify(payload)).not.toContain("CANARY-gh-refresh");
  });
});

describe("validateCloudflareToken", () => {
  it("accepts only a successful verify response", async () => {
    stubFetch((url) =>
      url.hostname === "api.cloudflare.com" ? Response.json({ success: true }) : null,
    );
    expect(await validateCloudflareToken("tok")).toBe(true);
  });

  it("rejects non-2xx and success:false responses", async () => {
    stubFetch((url) =>
      url.hostname === "api.cloudflare.com" ? Response.json({ success: false }) : null,
    );
    expect(await validateCloudflareToken("tok")).toBe(false);

    stubFetch((url) =>
      url.hostname === "api.cloudflare.com"
        ? new Response("nope", { status: 403 })
        : null,
    );
    expect(await validateCloudflareToken("tok")).toBe(false);
  });
});

describe("developer service token validation", () => {
  it("validates Supabase bearer credentials against the Management API", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.href !== "https://api.supabase.com/v1/projects") return null;
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer supabase-token");
      return Response.json([]);
    });

    expect(await validateSupabaseToken("supabase-token")).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("validates Convex personal access tokens with the CLI authorization check", async () => {
    stubFetch((url, init) => {
      if (url.href !== "https://api.convex.dev/api/authorize") return null;
      expect(init.method).toBe("HEAD");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer convex-token");
      expect(headers.get("convex-client")).toBe("workbench-control-plane");
      return new Response(null, { status: 200 });
    });

    expect(await validateConvexToken("convex-token")).toBe(true);
  });

  it("rejects provider tokens when their authorization endpoint rejects them", async () => {
    stubFetch(() => new Response(null, { status: 401 }));
    expect(await validateSupabaseToken("bad")).toBe(false);
    expect(await validateConvexToken("bad")).toBe(false);
  });
});
