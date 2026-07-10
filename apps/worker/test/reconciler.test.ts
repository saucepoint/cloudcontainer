/**
 * Reconciler tests. All time-based behavior is driven by the injected clock —
 * a 7-day grace expiry runs in milliseconds ("time never passes in tests").
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptJsonAtRest, encryptJsonAtRest, generateX25519Keypair } from "@codestation/contract";
import { GRACE_DAYS, reconcile, STUCK_JOB_MS } from "../src/reconciler.js";
import type { CredentialsRow, JobRow } from "../src/types.js";
import { fakeDaemon, makeEnv, seedContainer, seedHost, seedUser, stubFetch, type FetchRoute } from "./helpers/env.js";

afterEach(() => vi.unstubAllGlobals());

const DAY_MS = 24 * 3600 * 1000;

/** Daemon route serving /stats for drift tests. */
function statsRoute(containers: Array<{ containerId: string; incusStatus: string }>): FetchRoute {
  return (url) =>
    url.pathname === "/stats"
      ? Response.json({ hostId: "host-1", containers, ramTotalMb: 65536, uptimeSec: 100 })
      : null;
}

async function insertJob(env: ReturnType<typeof makeEnv>["env"], job: Partial<JobRow>) {
  await env.DB.prepare(
    "INSERT INTO jobs (id, container_id, op, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      job.id ?? "job-1",
      job.container_id ?? "container-1",
      job.op ?? "provision",
      job.status ?? "running",
      job.created_at ?? Date.now(),
      job.updated_at ?? Date.now(),
    )
    .run();
}

describe("stuck-job timeout", () => {
  it("fails jobs stuck past the timeout and drops in-flight containers to error", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "provisioning" });
    const t0 = Date.now();
    await insertJob(env, { updated_at: t0 - STUCK_JOB_MS - 1 });
    stubFetch(statsRoute([]));

    await reconcile(env, () => t0);

    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = 'job-1'").first<JobRow>();
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("timed out");
    const container = await env.DB.prepare("SELECT status, status_detail FROM containers").first<{
      status: string;
      status_detail: string;
    }>();
    expect(container?.status).toBe("error");
    expect(container?.status_detail).toBe("operation timed out");
  });

  it("leaves recent running jobs alone (they get polled instead)", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "provisioning" });
    const t0 = Date.now();
    await insertJob(env, { updated_at: t0 - 60 * 1000 });
    const daemon = fakeDaemon(); // polls report success
    stubFetch(daemon.route, statsRoute([]));

    await reconcile(env, () => t0);

    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = 'job-1'").first<JobRow>();
    expect(job?.status).toBe("succeeded");
    const container = await env.DB.prepare("SELECT status FROM containers").first<{ status: string }>();
    expect(container?.status).toBe("running"); // provision succeeded
  });
});

describe("grace expiry (suspended + 7 days -> destroy)", () => {
  it("enqueues destroy once the grace period has fully elapsed", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    const t0 = Date.now();
    await seedContainer(env, { status: "suspended", suspended_at: t0 - (GRACE_DAYS + 1) * DAY_MS });
    const daemon = fakeDaemon();
    stubFetch(daemon.route, statsRoute([]));

    await reconcile(env, () => t0);
    expect(daemon.submitted).toMatchObject([{ op: "destroy", containerId: "container-1" }]);
  });

  it("does nothing while grace is still running", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    const t0 = Date.now();
    await seedContainer(env, { status: "suspended", suspended_at: t0 - (GRACE_DAYS - 1) * DAY_MS });
    const daemon = fakeDaemon();
    stubFetch(daemon.route, statsRoute([]));

    await reconcile(env, () => t0);
    expect(daemon.submitted).toHaveLength(0);
  });
});

describe("drift correction (D1 <-> incus)", () => {
  it("adopts the host's actual state when D1 disagrees", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "running" });
    stubFetch(statsRoute([{ containerId: "container-1", incusStatus: "Stopped" }]));

    await reconcile(env, Date.now);
    const row = await env.DB.prepare("SELECT status FROM containers").first<{ status: string }>();
    expect(row?.status).toBe("stopped");
  });

  it("ignores transitional incus states and unknown containers", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "running" });
    stubFetch(statsRoute([{ containerId: "container-1", incusStatus: "Frozen" }]));

    await reconcile(env, Date.now);
    const row = await env.DB.prepare("SELECT status FROM containers").first<{ status: string }>();
    expect(row?.status).toBe("running");
  });

  it("keeps last known state when the host is unreachable", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    await seedHost(env);
    await seedContainer(env, { status: "running" });
    stubFetch(() => {
      throw new Error("host down");
    });

    await reconcile(env, Date.now);
    const row = await env.DB.prepare("SELECT status FROM containers").first<{ status: string }>();
    expect(row?.status).toBe("running");
  });
});

describe("github token refresh loop", () => {
  it("exchanges the refresh token before expiry and pushes new credentials to the host", async () => {
    const { env } = makeEnv({
      GITHUB_APP_CLIENT_ID: "client-1",
      GITHUB_APP_CLIENT_SECRET: "shh",
    });
    await seedUser(env);
    await seedHost(env, { daemon_pubkey: generateX25519Keypair().publicKey });
    await seedContainer(env, { status: "running" });
    const t0 = Date.now();
    const key = env.CREDENTIAL_MASTER_KEY;
    await env.DB.prepare(
      `INSERT INTO credentials_encrypted (user_id, github_token, github_refresh_token, github_expires_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(
        "user-1",
        encryptJsonAtRest("old-access", key),
        encryptJsonAtRest("refresh-1", key),
        t0 + 10 * 60 * 1000, // expires within the 1h refresh lead
      )
      .run();

    const daemon = fakeDaemon();
    const githubExchanges: unknown[] = [];
    stubFetch(
      daemon.route,
      statsRoute([{ containerId: "container-1", incusStatus: "Running" }]),
      (url, init) => {
        if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
          githubExchanges.push(JSON.parse(String(init.body)));
          return Response.json({
            access_token: "new-access",
            refresh_token: "refresh-2",
            expires_in: 8 * 3600,
          });
        }
        if (url.hostname === "api.github.com" && url.pathname === "/user") {
          return Response.json({ login: "octocat" });
        }
        return null;
      },
    );

    await reconcile(env, () => t0);

    expect(githubExchanges).toMatchObject([
      { grant_type: "refresh_token", refresh_token: "refresh-1" },
    ]);
    const row = await env.DB.prepare(
      "SELECT * FROM credentials_encrypted WHERE user_id = 'user-1'",
    ).first<CredentialsRow>();
    expect(decryptJsonAtRest(row?.github_token as string, key)).toBe("new-access");
    expect(decryptJsonAtRest(row?.github_refresh_token as string, key)).toBe("refresh-2");
    expect(row?.github_login).toBe("octocat");
    // And the fresh token was pushed to the container.
    expect(daemon.submitted).toMatchObject([{ op: "refresh-credentials" }]);
  });

  it("skips entirely when the GitHub App is not configured", async () => {
    const { env } = makeEnv(); // no client id/secret
    stubFetch(statsRoute([]));
    await reconcile(env, Date.now); // would throw on an unexpected github.com fetch
  });
});

describe("expired-row cleanup", () => {
  it("prunes oauth states, old enrollment tokens, and old session revocations", async () => {
    const { env } = makeEnv();
    await seedUser(env);
    const t0 = Date.now();
    await env.DB.prepare(
      "INSERT INTO oauth_states (state, user_id, created_at, expires_at) VALUES ('s1', 'user-1', ?, ?)",
    )
      .bind(t0 - 1000, t0 - 1)
      .run();
    await env.DB.prepare(
      "INSERT INTO enrollment_tokens (token_hash, user_id, expires_at) VALUES ('h1', 'user-1', ?)",
    )
      .bind(t0 - 2 * DAY_MS)
      .run();
    await env.DB.prepare(
      "INSERT INTO session_revocations (sid_hash, revoked_at) VALUES ('old', ?), ('recent', ?)",
    )
      .bind(t0 - 31 * DAY_MS, t0 - DAY_MS)
      .run();
    stubFetch(statsRoute([]));

    await reconcile(env, () => t0);

    expect((await env.DB.prepare("SELECT * FROM oauth_states").all()).results).toHaveLength(0);
    expect((await env.DB.prepare("SELECT * FROM enrollment_tokens").all()).results).toHaveLength(0);
    const revocations = await env.DB.prepare("SELECT sid_hash FROM session_revocations").all<{
      sid_hash: string;
    }>();
    expect(revocations.results.map((r) => r.sid_hash)).toEqual(["recent"]);
  });
});
