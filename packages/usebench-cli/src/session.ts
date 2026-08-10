import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { select } from "@inquirer/prompts";
import { ApiClient, ApiError } from "./http.js";
import { openBrowser } from "./browser.js";

type Provider = "google" | "github";

interface StoredSession {
  baseUrl: string;
  cookie: string;
  savedAt: string;
}

export interface SessionState {
  verified: boolean;
  worldIdAvailable: boolean;
  githubAvailable: boolean;
  hasWorkbench: boolean;
  redirect: "/dashboard";
}

export function sessionPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "usebench", "session.json");
}

async function readStoredSession(baseUrl: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(sessionPath(), "utf8")) as Partial<StoredSession>;
    if (parsed.baseUrl !== baseUrl || typeof parsed.cookie !== "string" || !parsed.cookie) return null;
    return parsed.cookie;
  } catch {
    return null;
  }
}

export async function saveSession(baseUrl: string, cookie: string): Promise<void> {
  const path = sessionPath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify({ baseUrl, cookie, savedAt: new Date().toISOString() } satisfies StoredSession), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temp, path);
}

export async function clearSession(): Promise<void> {
  await rm(sessionPath(), { force: true });
}

async function browserAuthentication(api: ApiClient): Promise<string> {
  const provider = await select<Provider>({
    message: "Create or sign in to your usebench account",
    choices: [
      { name: "Google", value: "google" },
      { name: "GitHub", value: "github" },
    ],
  });
  const state = randomBytes(24).toString("base64url");
  const server = createServer();
  const callback = await new Promise<{ uri: string; server: ReturnType<typeof createServer> }>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not start the local browser callback."));
        return;
      }
      resolve({ uri: `http://127.0.0.1:${address.port}/callback`, server });
    });
  });

  let callbackResolve: ((value: string) => void) | undefined;
  let callbackReject: ((error: Error) => void) | undefined;
  const callbackCode = new Promise<string>((resolve, reject) => {
    callbackResolve = resolve;
    callbackReject = reject;
  });
  callback.server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const returnedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (returnedState !== state || !code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid sign-in response. Return to the terminal.");
      callbackReject?.(new Error("The browser returned an invalid sign-in response."));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
      "<h1>usebench sign-in complete</h1><p>Return to your terminal.</p>",
    );
    callbackResolve?.(code);
  });

  try {
    const start = await api.post<{ browserUrl: string; expiresInSec: number }>("/api/cli/auth/start", {
      provider,
      callbackUri: callback.uri,
      state,
    });
    console.log(`\nOpening ${provider} sign-in in your browser…`);
    console.log(`If it does not open, visit:\n${start.browserUrl}\n`);
    openBrowser(start.browserUrl);
    const code = await Promise.race([
      callbackCode,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Browser sign-in expired.")), start.expiresInSec * 1_000)),
    ]);
    return await api.exchangeSession(code);
  } finally {
    callback.server.close();
  }
}

export async function loadOrAuthenticate(baseUrl: string, forceClear: boolean): Promise<{ api: ApiClient; state: SessionState }> {
  if (forceClear) await clearSession();
  let api = new ApiClient(baseUrl, await readStoredSession(baseUrl));
  let state: SessionState;
  try {
    state = await api.get<SessionState>("/api/cli/session");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    await clearSession();
    api = new ApiClient(baseUrl);
    await browserAuthentication(api);
    state = await api.get<SessionState>("/api/cli/session");
  }
  if (api.sessionCookie) await saveSession(baseUrl, api.sessionCookie);
  return { api, state };
}
