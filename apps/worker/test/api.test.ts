/**
 * HTTP-level tests for the API routes: real Hono app, fake D1/KV, stubbed
 * daemon + external HTTP. Covers wizard submit, container actions, key
 * management, the no-key enrollment path (U4), and account deletion (U8).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptJsonAtRest, generateX25519Keypair } from "@codestation/contract";
import { apiRoutes, validPubkey } from "../src/api.js";
import { upsertCredentials } from "../src/credentials.js";
import { createSession } from "../src/sessions.js";
import type { AppContext, Bindings, UserRow } from "../src/types.js";
import { fakeDaemon, makeEnv, seedContainer, seedHost, seedUser, stubFetch } from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

const hostKeys = generateX25519Keypair();
const PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIItest test@laptop";

function app() {
  return new Hono<AppContext>().route("/", apiRoutes);
}

async function login(env: Bindings, user: UserRow): Promise<Record<string, string>> {
  const sid = await createSession(env, user.id);
  return { cookie: `cs_session=${sid}` };
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

describe("validPubkey", () => {
  it("accepts common key types with or without comments", () => {
    expect(validPubkey(PUBKEY)).toBe(true);
    expect(validPubkey("ssh-rsa AAAAB3NzaC1yc2E=")).toBe(true);
    expect(validPubkey("ecdsa-sha2-nistp256 AAAAE2Vj comment here")).toBe(true);
    expect(validPubkey("  ssh-ed25519 AAAA trailing-ws  ")).toBe(true);
  });

  it("rejects garbage, private keys, and oversized blobs", () => {
    expect(validPubkey("not a key")).toBe(false);
    expect(validPubkey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(false);
    expect(validPubkey(`ssh-ed25519 ${"A".repeat(5000)}`)).toBe(false);
    expect(validPubkey("ssh-dss AAAA")).toBe(false); // legacy DSA not allowed
  });
});

describe("auth gating", () => {
  it("rejects unauthenticated API access with JSON 401", async () => {
    const { env } = makeEnv();
    const res = await app().request("/api/container", {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});

describe("POST /api/provision", () => {
  async function setup() {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    const headers = await login(env, user);
    const daemon = fakeDaemon();
    stubFetch(daemon.route, (url) =>
      url.hostname === "api.cloudflare.com" ? Response.json({ success: true }) : null,
    );
    return { env, headers, daemon };
  }

  it("requires at least one known agent", async () => {
    const { env, headers } = await setup();
    for (const agents of [[], ["emacs"], ["claude", "emacs"], undefined]) {
      const res = await app().request("/api/provision", json({ agents }, headers), env);
      expect(res.status).toBe(400);
    }
  });

  it("rejects a malformed SSH key without creating anything", async () => {
    const { env, headers } = await setup();
    for (const sshPubkey of ["not-a-key", 42]) {
      const res = await app().request(
        "/api/provision",
        json({ agents: ["claude"], sshPubkey }, headers),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect((await env.DB.prepare("SELECT * FROM containers").all()).results).toHaveLength(0);
  });

  it("provisions: stores the key, encrypts credentials, dispatches the job", async () => {
    const { env, headers, daemon } = await setup();
    const res = await app().request(
      "/api/provision",
      json(
        {
          agents: ["codex", "claude"],
          sshPubkey: PUBKEY,
          llmKeys: { anthropic: "CANARY-llm" },
          cloudflareToken: "cf-token",
        },
        headers,
      ),
      env,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { container: { status: string; agents: string[] } };
    expect(body.container.status).toBe("provisioning");
    expect(body.container.agents).toEqual(["claude", "codex"]); // canonical order

    const keys = await env.DB.prepare("SELECT pubkey FROM ssh_keys").all<{ pubkey: string }>();
    expect(keys.results.map((k) => k.pubkey)).toEqual([PUBKEY]);

    // Secrets hygiene: canary encrypted in D1, sealed on the wire, absent from job rows.
    const credRow = await env.DB.prepare("SELECT * FROM credentials_encrypted").first();
    expect(JSON.stringify(credRow)).not.toContain("CANARY-");
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM jobs").all()).results)).not.toContain(
      "CANARY-",
    );
    expect(daemon.submitted).toMatchObject([{ op: "provision" }]);
    expect(JSON.stringify(daemon.submitted)).not.toContain("CANARY-");
  });

  it("verifies and carries selected GitHub repositories into provisioning", async () => {
    const { env, headers, daemon } = await setup();
    await env.DB.prepare(
      `INSERT INTO credentials_encrypted (user_id, github_token, github_expires_at, github_login)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(
        "user-1",
        encryptJsonAtRest("CANARY-gh-access", env.CREDENTIAL_MASTER_KEY),
        Date.now() + 3_600_000,
        "octocat",
      )
      .run();
    stubFetch(
      daemon.route,
      (url) =>
        url.hostname === "api.github.com" && url.pathname === "/user/repos"
          ? Response.json([
              { full_name: "octocat/hello-world", private: false, archived: false },
              { full_name: "acme/private", private: true, archived: false },
            ])
          : null,
      (url) =>
        url.hostname === "api.cloudflare.com" ? Response.json({ success: true }) : null,
    );

    const response = await app().request(
      "/api/provision",
      json(
        {
          agents: ["codex"],
          githubRepos: ["octocat/hello-world", "acme/private"],
        },
        headers,
      ),
      env,
    );
    expect(response.status).toBe(202);
    expect(daemon.submitted[0]).toMatchObject({
      op: "provision",
      githubRepos: ["octocat/hello-world", "acme/private"],
    });
    const container = await env.DB.prepare("SELECT github_repos FROM containers").first<{
      github_repos: string;
    }>();
    expect(JSON.parse(container!.github_repos)).toEqual([
      "octocat/hello-world",
      "acme/private",
    ]);
  });

  it("rejects repositories that the connected GitHub token cannot access", async () => {
    const { env, headers, daemon } = await setup();
    await env.DB.prepare(
      `INSERT INTO credentials_encrypted (user_id, github_token, github_expires_at)
       VALUES (?, ?, ?)`,
    )
      .bind(
        "user-1",
        encryptJsonAtRest("CANARY-gh-access", env.CREDENTIAL_MASTER_KEY),
        Date.now() + 3_600_000,
      )
      .run();
    stubFetch(
      daemon.route,
      (url) =>
        url.hostname === "api.github.com" && url.pathname === "/user/repos"
          ? Response.json([{ full_name: "octocat/allowed", private: true, archived: false }])
          : null,
    );

    const response = await app().request(
      "/api/provision",
      json({ agents: ["codex"], githubRepos: ["octocat/not-allowed"] }, headers),
      env,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("no longer available"),
    });
    expect((await env.DB.prepare("SELECT * FROM containers").all()).results).toHaveLength(0);
  });

  it("refuses a second container (one per account)", async () => {
    const { env, headers } = await setup();
    await seedContainer(env);
    const res = await app().request("/api/provision", json({ agents: ["claude"] }, headers), env);
    expect(res.status).toBe(409);
  });

  it("rejects an invalid Cloudflare token up front", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env);
    const headers = await login(env, user);
    stubFetch((url) =>
      url.hostname === "api.cloudflare.com" ? Response.json({ success: false }) : null,
    );
    const res = await app().request(
      "/api/provision",
      json({ agents: ["claude"], cloudflareToken: "bad" }, headers),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("explains that launch can continue without the token when Cloudflare is unavailable", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env);
    const headers = await login(env, user);
    stubFetch(() => {
      throw new Error("Cloudflare outage");
    });

    const res = await app().request(
      "/api/provision",
      json({ agents: ["claude"], cloudflareToken: "valid-looking" }, headers),
      env,
    );
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("remove the token to launch now"),
    });
    expect((await env.DB.prepare("SELECT * FROM containers").all()).results).toHaveLength(0);
  });
});

describe("GET /api/container", () => {
  it("returns null when the user has no container", async () => {
    const { env } = makeEnv();
    const headers = await login(env, await seedUser(env));
    const res = await app().request("/api/container", { headers }, env);
    expect(await res.json()).toEqual({ container: null });
  });

  it("exposes the ssh command and allowed ops for a running container", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "running", host_key_fingerprints: '["fp1"]' });
    const headers = await login(env, user);

    const res = await app().request("/api/container", { headers }, env);
    const { container } = (await res.json()) as {
      container: { sshCommand: string; allowedOps: string[]; hostKeyFingerprints: string[] };
    };
    expect(container.sshCommand).toBe("ssh -p 30500 dev@host-1.codestation.test");
    expect(container.allowedOps).toContain("stop");
    expect(container.hostKeyFingerprints).toEqual(["fp1"]);
  });
});

describe("GET /api/dashboard", () => {
  it("returns the initial container, credential-presence, and key state together", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "running" });
    await env.DB.prepare(
      "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES (?, 'laptop', ?, ?)",
    )
      .bind(user.id, PUBKEY, Date.now())
      .run();
    const headers = await login(env, user);

    const res = await app().request("/api/dashboard", { headers }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      container: { status: string; sshCommand: string };
      credentials: { llm: Record<string, boolean>; cloudflare: boolean };
      keys: Array<{ label: string; pubkey: string }>;
    };
    expect(body.container).toMatchObject({
      status: "running",
      sshCommand: "ssh -p 30500 dev@host-1.codestation.test",
    });
    expect(body.credentials).toMatchObject({ llm: {}, cloudflare: false });
    expect(body.keys).toMatchObject([{ label: "laptop", pubkey: PUBKEY }]);
  });
});

describe("POST /api/container/:op", () => {
  it("refuses ops that the current status does not allow", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "provisioning" });
    const headers = await login(env, user);

    const res = await app().request("/api/container/stop", { method: "POST", headers }, env);
    expect(res.status).toBe(409);
  });

  it("rejects unknown ops (no arbitrary op injection into jobs)", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env);
    await seedContainer(env);
    const headers = await login(env, user);

    const res = await app().request(
      "/api/container/export-window",
      { method: "POST", headers },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("dispatches an allowed op and reflects the pending status", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    await seedContainer(env, { status: "running" });
    const headers = await login(env, user);
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const res = await app().request("/api/container/destroy", { method: "POST", headers }, env);
    expect(res.status).toBe(202);
    expect(daemon.submitted).toMatchObject([{ op: "destroy" }]);
    const row = await env.DB.prepare("SELECT status FROM containers").first<{ status: string }>();
    expect(row?.status).toBe("destroying");
  });

  it("retry re-runs the failed op from the error state", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    await seedContainer(env, { status: "error" });
    await env.DB.prepare(
      "INSERT INTO jobs (id, container_id, op, status, error, created_at, updated_at) VALUES ('j1', 'container-1', 'rebuild', 'failed', 'boom', ?, ?)",
    )
      .bind(Date.now(), Date.now())
      .run();
    const headers = await login(env, user);
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    const res = await app().request("/api/container/retry", { method: "POST", headers }, env);
    expect(res.status).toBe(202);
    expect(daemon.submitted).toMatchObject([{ op: "rebuild" }]);
  });
});

describe("SSH key management", () => {
  it("treats adding the same public key twice as idempotent", async () => {
    const { env } = makeEnv();
    const headers = await login(env, await seedUser(env));

    expect((await app().request("/api/keys", json({ pubkey: PUBKEY }, headers), env)).status).toBe(
      200,
    );
    const duplicate = await app().request("/api/keys", json({ pubkey: PUBKEY }, headers), env);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true });
    expect((await env.DB.prepare("SELECT * FROM ssh_keys").all()).results).toHaveLength(1);
  });

  it("adds a key, syncs it live, lists it, then deletes it", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    await seedContainer(env, { status: "running" });
    const headers = await login(env, user);
    const daemon = fakeDaemon();
    stubFetch(daemon.route);

    expect(
      (await app().request("/api/keys", json({ pubkey: PUBKEY, label: "laptop" }, headers), env))
        .status,
    ).toBe(200);
    expect(daemon.submitted).toMatchObject([{ op: "sync-keys", sshKeys: [PUBKEY] }]);

    const list = await app().request("/api/keys", { headers }, env);
    const { keys } = (await list.json()) as { keys: Array<{ id: number; label: string }> };
    expect(keys).toMatchObject([{ label: "laptop" }]);

    const del = await app().request(`/api/keys/${keys[0]!.id}`, { method: "DELETE", headers }, env);
    expect(del.status).toBe(200);
    // The delete triggers a second sync-keys, now empty (fail closed on the host).
    expect(daemon.submitted).toMatchObject([
      { op: "sync-keys", sshKeys: [PUBKEY] },
      { op: "sync-keys", sshKeys: [] },
    ]);
  });

  it("rejects invalid keys", async () => {
    const { env } = makeEnv();
    const headers = await login(env, await seedUser(env));
    for (const body of [{ pubkey: "junk" }, { pubkey: 42 }, { pubkey: PUBKEY, label: 42 }]) {
      const res = await app().request("/api/keys", json(body, headers), env);
      expect(res.status).toBe(400);
    }
  });

  it("cannot delete another user's key", async () => {
    const { env } = makeEnv();
    const alice = await seedUser(env, "alice");
    await seedUser(env, "bob");
    await env.DB.prepare(
      "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES ('bob', '', ?, ?)",
    )
      .bind(PUBKEY, Date.now())
      .run();
    const headers = await login(env, alice);

    await app().request("/api/keys/1", { method: "DELETE", headers }, env);
    const bobKeys = await env.DB.prepare("SELECT * FROM ssh_keys WHERE user_id = 'bob'").all();
    expect(bobKeys.results).toHaveLength(1);
  });
});

describe("credentials endpoint", () => {
  it("reports presence only — never credential values", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const headers = await login(env, user);
    stubFetch((url) =>
      url.hostname === "api.cloudflare.com" ? Response.json({ success: true }) : null,
    );

    await app().request(
      "/api/credentials",
      json({ llmKeys: { openai: "CANARY-oai" }, cloudflareToken: "CANARY-cf" }, headers),
      env,
    );
    const res = await app().request("/api/credentials", { headers }, env);
    const body = await res.json();
    expect(body).toMatchObject({ llm: { openai: true }, cloudflare: true, github: null });
    expect(JSON.stringify(body)).not.toContain("CANARY-");
  });

  it("rejects unknown providers, non-text values, oversized secrets, and pasted OAuth-only credentials", async () => {
    const { env } = makeEnv();
    const headers = await login(env, await seedUser(env));
    const invalidBodies = [
      { llmKeys: { mystery: "secret" } },
      { llmKeys: { openai: 123 } },
      { llmKeys: { openai: "x".repeat(16 * 1024 + 1) } },
      // OAuth-only credentials enter through their sign-in flows, never a paste.
      { llmKeys: { codex_subscription_token: '{"tokens":{"access_token":"x"}}' } },
      { llmKeys: { github_copilot: "gho_pasted" } },
      { wranglerOauth: '{"oauth_token":"pasted"}' },
      { cloudflareToken: { token: "not-text" } },
    ];

    for (const body of invalidBodies) {
      const res = await app().request("/api/credentials", json(body, headers), env);
      expect(res.status).toBe(400);
    }
    expect((await env.DB.prepare("SELECT * FROM credentials_encrypted").all()).results).toHaveLength(
      0,
    );
  });

  it("allows empty-string disconnection of OAuth-only credentials", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const headers = await login(env, user);
    // Simulate credentials stored by the sign-in flows.
    await upsertCredentials(env, user.id, {
      llmKeys: { codex_subscription_token: '{"tokens":{}}', github_copilot: "gho_x" },
      wranglerOauth: '{"oauth_token":"t"}',
    });

    expect(
      (
        await app().request(
          "/api/credentials",
          json(
            { llmKeys: { codex_subscription_token: "", github_copilot: "" }, wranglerOauth: "" },
            headers,
          ),
          env,
        )
      ).status,
    ).toBe(200);
    const presence = await app().request("/api/credentials", { headers }, env);
    expect(await presence.json()).toMatchObject({ llm: {}, wrangler: false });
  });

  it("accepts an OpenCode Go key and reports wrangler presence separately from the API token", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const headers = await login(env, user);

    expect(
      (
        await app().request(
          "/api/credentials",
          json({ llmKeys: { opencode_go: "CANARY-ocgo" } }, headers),
          env,
        )
      ).status,
    ).toBe(200);
    await upsertCredentials(env, user.id, { wranglerOauth: '{"oauth_token":"t"}' });

    const res = await app().request("/api/credentials", { headers }, env);
    const body = await res.json();
    expect(body).toMatchObject({ llm: { opencode_go: true }, cloudflare: false, wrangler: true });
    expect(JSON.stringify(body)).not.toContain("CANARY-");
  });
});

describe("enrollment (U4, no-key path)", () => {
  async function mintToken(env: Bindings, headers: Record<string, string>): Promise<string> {
    const res = await app().request("/api/enrollment", { method: "POST", headers }, env);
    const body = (await res.json()) as { token: string; expiresInSec: number };
    expect(body.expiresInSec).toBe(3600);
    return body.token;
  }

  it("redeems a token exactly once (single-use, racing-safe)", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env, { daemon_pubkey: hostKeys.publicKey });
    await seedContainer(env, { status: "running" });
    const headers = await login(env, user);
    const daemon = fakeDaemon();
    stubFetch(daemon.route);
    const token = await mintToken(env, headers);

    // The raw token is never stored (only its hash).
    const stored = await env.DB.prepare("SELECT token_hash FROM enrollment_tokens").first<{
      token_hash: string;
    }>();
    expect(stored?.token_hash).not.toBe(token);

    const first = await app().request("/api/enroll", json({ token, pubkey: PUBKEY }), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      sshCommand: "ssh -p 30500 dev@host-1.codestation.test",
    });
    expect(daemon.submitted).toMatchObject([{ op: "sync-keys", sshKeys: [PUBKEY] }]);

    const second = await app().request("/api/enroll", json({ token, pubkey: PUBKEY }), env);
    expect(second.status).toBe(403);
  });

  it("rejects expired tokens", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const headers = await login(env, user);
    const token = await mintToken(env, headers);
    await env.DB.prepare("UPDATE enrollment_tokens SET expires_at = ?")
      .bind(Date.now() - 1000)
      .run();

    const res = await app().request("/api/enroll", json({ token, pubkey: PUBKEY }), env);
    expect(res.status).toBe(403);
  });

  it("rejects missing or invalid pubkeys without consuming the token", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const headers = await login(env, user);
    const token = await mintToken(env, headers);

    expect((await app().request("/api/enroll", json({ token }), env)).status).toBe(400);
    expect(
      (await app().request("/api/enroll", json({ token, pubkey: "junk" }), env)).status,
    ).toBe(400);
    // Token still redeemable after the bad attempts.
    stubFetch(fakeDaemon().route);
    expect(
      (await app().request("/api/enroll", json({ token, pubkey: PUBKEY }), env)).status,
    ).toBe(200);
  });
});

describe("account deletion (U8)", () => {
  it("refuses while a container exists on a host", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedHost(env);
    await seedContainer(env);
    const headers = await login(env, user);

    const res = await app().request("/api/account/delete", { method: "POST", headers }, env);
    expect(res.status).toBe(409);
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = 'user-1'").first()).not.toBeNull();
  });

  it("purges credentials, keys, and the user row; revokes the session", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    const headers = await login(env, user);
    await env.DB.prepare(
      "INSERT INTO ssh_keys (user_id, label, pubkey, created_at) VALUES ('user-1', '', ?, ?)",
    )
      .bind(PUBKEY, Date.now())
      .run();
    await env.DB.prepare("INSERT INTO credentials_encrypted (user_id) VALUES ('user-1')").run();

    const res = await app().request("/api/account/delete", { method: "POST", headers }, env);
    expect(res.status).toBe(200);
    for (const table of ["users", "ssh_keys", "credentials_encrypted"]) {
      expect((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results).toHaveLength(0);
    }
    // Session unusable afterwards.
    const after = await app().request("/api/container", { headers }, env);
    expect(after.status).toBe(401);
  });

  it("drops a hostless waitlisted container as part of deletion", async () => {
    const { env } = makeEnv();
    const user = await seedUser(env);
    await seedContainer(env, { status: "waitlisted", host_id: null, ssh_port: null });
    const headers = await login(env, user);

    const res = await app().request("/api/account/delete", { method: "POST", headers }, env);
    expect(res.status).toBe(200);
    expect((await env.DB.prepare("SELECT * FROM containers").all()).results).toHaveLength(0);
  });
});
