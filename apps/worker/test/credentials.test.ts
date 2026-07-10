import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { encryptJsonAtRest } from "@codestation/contract";
import {
  buildCredentialPayload,
  decryptLlmKeys,
  getCredentialsRow,
  upsertCredentials,
  validateCloudflareToken,
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
