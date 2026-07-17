/**
 * GitHub App installation and user authorization (§9). Installation grants
 * repository access; the user-to-server token is short-lived (~8 h), and the
 * reconciler refreshes it control-plane-side before expiry. The refresh token
 * never leaves the control plane. Hosts only receive the short-lived token via
 * `refresh-credentials` jobs.
 */
import { Hono } from "hono";
import { encryptJsonAtRest, GithubRepoNameSchema, toHex } from "@codestation/contract";
import {
  CREDENTIALS_LOCKED_ERROR,
  credentialsCanBeChanged,
  requireCredentialSetup,
  requireUser,
} from "./auth.js";
import { decryptString, getCredentialsRow } from "./credentials.js";
import { enqueueJobForUser } from "./jobs.js";
import type { AppContext, Bindings } from "./types.js";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
}

export interface GithubRepository {
  fullName: string;
  private: boolean;
  archived: boolean;
  description: string | null;
}

interface GithubRepositoryResponse {
  full_name?: string;
  private?: boolean;
  archived?: boolean;
  description?: string | null;
}

export function githubConfigured(env: Bindings): boolean {
  return Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET);
}

export function githubInstallationConfigured(env: Bindings): boolean {
  return Boolean(
    githubConfigured(env) &&
      typeof env.GITHUB_APP_SLUG === "string" &&
      /^[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i.test(env.GITHUB_APP_SLUG),
  );
}

/** POST to GitHub's token endpoint: `{ code }` for the OAuth callback, `{ grant_type, refresh_token }` for refresh. */
export async function exchangeGithubTokens(
  env: Bindings,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      ...params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`github token endpoint ${res.status}`);
  return (await res.json()) as TokenResponse;
}

async function fetchGithubLogin(token: string): Promise<string | null> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "codestation",
      accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { login?: string };
  return json.login ?? null;
}

/** Return a usable access token, refreshing it control-plane-side when needed. */
export async function githubAccessToken(env: Bindings, userId: string): Promise<string | null> {
  const row = await getCredentialsRow(env, userId);
  if (!row?.github_token) return null;
  const current = decryptString(env, row.github_token) ?? null;
  if (
    !row.github_refresh_token ||
    !row.github_expires_at ||
    row.github_expires_at > Date.now() + 60_000
  ) {
    return current;
  }

  const refreshToken = decryptString(env, row.github_refresh_token);
  if (!refreshToken) return current;
  const refreshed = await exchangeGithubTokens(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (refreshed.error || !refreshed.access_token) {
    throw new Error(`github token refresh failed${refreshed.error ? `: ${refreshed.error}` : ""}`);
  }
  await storeGithubTokens(env, userId, refreshed);
  return refreshed.access_token;
}

function githubApiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "user-agent": "codestation",
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
}

function githubRepository(row: GithubRepositoryResponse): GithubRepository | null {
  if (!row.full_name) return null;
  return {
    fullName: row.full_name,
    private: Boolean(row.private),
    archived: Boolean(row.archived),
    description: row.description ?? null,
  };
}

/** Fetch one repository when the user token and App installation can access it. */
export async function fetchGithubRepository(
  token: string,
  fullName: string,
): Promise<GithubRepository | null> {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) return null;
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  const res = await fetch(url, {
    headers: githubApiHeaders(token),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github repository endpoint ${res.status}`);
  return githubRepository((await res.json()) as GithubRepositoryResponse);
}

/** Search every repository visible to the authenticated GitHub App user token. */
export async function searchGithubRepositories(
  token: string,
  query: string,
): Promise<GithubRepository[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (GithubRepoNameSchema.safeParse(trimmed).success) {
    const exact = await fetchGithubRepository(token, trimmed);
    return exact ? [exact] : [];
  }

  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", `${trimmed} in:name`);
  url.searchParams.set("per_page", "20");
  const res = await fetch(url, {
    headers: githubApiHeaders(token),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`github repository search endpoint ${res.status}`);
  const body = (await res.json()) as { items?: GithubRepositoryResponse[] };
  const repositories = (body.items ?? [])
    .map(githubRepository)
    .filter((repository): repository is GithubRepository => repository !== null);
  const needle = trimmed.toLocaleLowerCase();
  return repositories
    .sort((left, right) => {
      const leftName = left.fullName.split("/").at(-1)?.toLocaleLowerCase() ?? "";
      const rightName = right.fullName.split("/").at(-1)?.toLocaleLowerCase() ?? "";
      const relevance = (name: string) => name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
      return (
        relevance(leftName) - relevance(rightName) ||
        left.fullName.localeCompare(right.fullName)
      );
    })
    .slice(0, 20);
}

/** Verify selected names directly so access checks have no repository-list cutoff. */
export async function verifyGithubRepositories(
  token: string,
  fullNames: string[],
): Promise<Set<string>> {
  const repositories = await Promise.all(
    fullNames.map((fullName) => fetchGithubRepository(token, fullName)),
  );
  return new Set(fullNames.filter((_fullName, index) => repositories[index] !== null));
}

export async function storeGithubTokens(
  env: Bindings,
  userId: string,
  tokens: TokenResponse,
): Promise<void> {
  if (!tokens.access_token) throw new Error("github token response missing access_token");
  const key = env.CREDENTIAL_MASTER_KEY;
  const expiresAt = Date.now() + (tokens.expires_in ?? 8 * 3600) * 1000;
  const login = await fetchGithubLogin(tokens.access_token);
  await env.DB.prepare(
    `INSERT INTO credentials_encrypted (user_id, github_token, github_refresh_token, github_expires_at, github_login, rotated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id) DO UPDATE SET
       github_token = ?2,
       github_refresh_token = COALESCE(?3, github_refresh_token),
       github_expires_at = ?4, github_login = COALESCE(?5, github_login), rotated_at = ?6`,
  )
    .bind(
      userId,
      encryptJsonAtRest(tokens.access_token, key),
      tokens.refresh_token ? encryptJsonAtRest(tokens.refresh_token, key) : null,
      expiresAt,
      login,
      Date.now(),
    )
    .run();
}

/** Push refreshed credentials into the user's container, if there is one. */
export async function pushCredentialsToContainer(env: Bindings, userId: string): Promise<void> {
  await enqueueJobForUser(env, userId, "refresh-credentials");
}

async function createGithubState(
  env: Bindings,
  userId: string,
  returnTo: string,
): Promise<string> {
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = toHex(stateBytes);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO oauth_states (state, user_id, created_at, expires_at, return_to) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(state, userId, now, now + 10 * 60 * 1000, returnTo)
    .run();
  return state;
}

async function beginGithubAuthorization(
  env: Bindings,
  userId: string,
  returnTo: string,
): Promise<string> {
  const state = await createGithubState(env, userId, returnTo);
  const params = new URLSearchParams({
    client_id: env.GITHUB_APP_CLIENT_ID,
    redirect_uri: `${env.BASE_URL}/auth/github/callback`,
    state,
    prompt: "select_account",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

/** Start GitHub's account/repository chooser, which continues into OAuth when configured. */
async function beginGithubInstallation(
  env: Bindings,
  userId: string,
  returnTo: string,
): Promise<string> {
  const state = await createGithubState(env, userId, returnTo);
  const url = new URL(
    `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`,
  );
  url.searchParams.set("state", state);
  return url.toString();
}

/** Revoke every user token and grant issued by this GitHub App for this user. */
async function revokeGithubAuthorization(env: Bindings, token: string): Promise<void> {
  const basicCredentials = btoa(`${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET!}`);
  const res = await fetch(
    `https://api.github.com/applications/${encodeURIComponent(env.GITHUB_APP_CLIENT_ID)}/grant`,
    {
      method: "DELETE",
      headers: {
        authorization: `Basic ${basicCredentials}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "codestation",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`github authorization revocation endpoint ${res.status}`);
}

export const githubRoutes = new Hono<AppContext>()
  .get("/auth/github/install", requireUser, async (c) => {
    if (!githubInstallationConfigured(c.env)) {
      return c.text("GitHub App installation not configured", 404);
    }
    if (!(await credentialsCanBeChanged(c.env, c.get("user").id))) {
      return c.text(CREDENTIALS_LOCKED_ERROR, 409);
    }
    const returnTo = c.req.query("return_to") === "/onboarding" ? "/onboarding" : "/dashboard";
    return c.redirect(await beginGithubInstallation(c.env, c.get("user").id, returnTo));
  })
  .get("/auth/github", requireUser, async (c) => {
    if (!githubConfigured(c.env)) return c.text("GitHub App not configured", 404);
    if (!(await credentialsCanBeChanged(c.env, c.get("user").id))) {
      return c.text(CREDENTIALS_LOCKED_ERROR, 409);
    }
    const returnTo = c.req.query("return_to") === "/onboarding" ? "/onboarding" : "/dashboard";
    return c.redirect(await beginGithubAuthorization(c.env, c.get("user").id, returnTo));
  })
  .post("/auth/github/reauth", requireUser, requireCredentialSetup, async (c) => {
    if (!githubConfigured(c.env)) return c.json({ error: "GitHub App not configured" }, 404);
    const userId = c.get("user").id;
    try {
      const token = await githubAccessToken(c.env, userId);
      if (token) await revokeGithubAuthorization(c.env, token);
      await c.env.DB.prepare(
        `UPDATE credentials_encrypted
         SET github_token = NULL, github_refresh_token = NULL, github_expires_at = NULL,
             github_login = NULL, rotated_at = ?
         WHERE user_id = ?`,
      )
        .bind(Date.now(), userId)
        .run();
      const returnTo = c.req.query("return_to") === "/onboarding" ? "/onboarding" : "/dashboard";
      return c.json({ authorizationUrl: await beginGithubAuthorization(c.env, userId, returnTo) });
    } catch (err) {
      console.log(JSON.stringify({ event: "github_reauthorize_failed", error: String(err) }));
      return c.json({ error: "Could not reset GitHub authorization. Please retry." }, 502);
    }
  })
  .get("/auth/github/callback", requireUser, async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("Invalid GitHub callback", 400);
    const row = await c.env.DB.prepare(
      "SELECT user_id, expires_at, return_to FROM oauth_states WHERE state = ?",
    )
      .bind(state)
      .first<{ user_id: string; expires_at: number; return_to: string }>();
    await c.env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
    if (!row || row.expires_at < Date.now() || row.user_id !== c.get("user").id) {
      return c.text("Expired or invalid state", 400);
    }
    if (!(await credentialsCanBeChanged(c.env, row.user_id))) {
      return c.text(CREDENTIALS_LOCKED_ERROR, 409);
    }
    try {
      const tokens = await exchangeGithubTokens(c.env, { code });
      if (tokens.error) throw new Error(`github oauth error: ${tokens.error}`);
      await storeGithubTokens(c.env, row.user_id, tokens);
      await pushCredentialsToContainer(c.env, row.user_id);
    } catch (err) {
      // Log the credential *kind* only, never values (§10 secrets hygiene).
      console.log(JSON.stringify({ event: "github_connect_failed", error: String(err) }));
      return c.text("GitHub authorization failed. Please retry from the dashboard.", 502);
    }
    return c.redirect(row.return_to === "/onboarding" ? "/onboarding" : "/dashboard");
  })
  .get("/api/github/repos", requireUser, requireCredentialSetup, async (c) => {
    if (!githubConfigured(c.env)) return c.json({ error: "GitHub App not configured" }, 404);
    try {
      const token = await githubAccessToken(c.env, c.get("user").id);
      if (!token) return c.json({ error: "connect GitHub first" }, 409);
      const query = (c.req.query("q") ?? "").trim().slice(0, 256);
      if (!query) return c.json({ repositories: [] });
      const repositories = await searchGithubRepositories(token, query);
      return c.json({ repositories });
    } catch (err) {
      console.log(JSON.stringify({ event: "github_repositories_failed", error: String(err) }));
      return c.json({ error: "Could not load GitHub repositories. Reconnect GitHub and retry." }, 502);
    }
  });
