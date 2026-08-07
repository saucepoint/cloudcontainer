import { createHash } from "node:crypto";
import {
  CredentialPayloadSchema,
  LLM_PROVIDERS,
  sealOpenJson,
  WranglerOauthSchema,
  type Agent,
  type CredentialPayload,
  type LlmProvider,
} from "@workbench/contract";
import { shellQuote, type Incus } from "./incus.js";

/** Environment variables managed for each LLM credential provider. */
const LLM_ENV_VARS: Record<LlmProvider, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  opencode_go: ["OPENCODE_API_KEY"],
  claude_subscription_token: ["CLAUDE_CODE_OAUTH_TOKEN"],
  codex_subscription_token: [],
  pi_claude_subscription_token: [],
  pi_codex_subscription_token: [],
  opencode_claude_subscription_token: [],
  opencode_codex_subscription_token: [],
  github_copilot: [],
  deepseek: ["DEEPSEEK_API_KEY"],
  // Keep both names for the Open Platform and Kimi Code ecosystems.
  kimi: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  zai: ["ZAI_API_KEY"],
  vercel_ai_gateway: ["AI_GATEWAY_API_KEY"],
};

const CODEX_AUTH_PATH = "/home/dev/.codex/auth.json";
const PI_AUTH_PATH = "/home/dev/.pi/agent/auth.json";
const CLAUDE_STATE_PATH = "/home/dev/.claude.json";
const OPENCODE_AUTH_PATH = "/home/dev/.local/share/opencode/auth.json";
const WRANGLER_CONFIG_PATH = "/home/dev/.wrangler/config/default.toml";
const CONVEX_CONFIG_PATH = "/home/dev/.convex/config.json";
const GIT_SIGNING_KEY_PATH = "/home/dev/.ssh/workbench_github_signing_key";
const MANAGED_CREDENTIAL_STATE_PATH = "/home/dev/.config/workbench/credential-state.json";

type CodexAuthOwner = "pi" | "codex" | "opencode";

interface ManagedCredentialState {
  version: 2;
  chatgpt?: Partial<Record<CodexAuthOwner, { fingerprint: string }>>;
  wrangler?: {
    fingerprint: string;
  };
  convex?: {
    fingerprint: string;
  };
}

interface StoredManagedCredentialState {
  /** False for legacy homes that do not yet have per-agent fingerprints. */
  exists: boolean;
  state: ManagedCredentialState;
}

interface CodexAuthPayload {
  last_refresh?: unknown;
  tokens: {
    access_token: string;
    refresh_token: string;
    account_id?: unknown;
  };
}

function parseCodexAuth(value: string): CodexAuthPayload {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") throw new Error();
    const auth = parsed as {
      last_refresh?: unknown;
      tokens?: {
        access_token?: unknown;
        refresh_token?: unknown;
        account_id?: unknown;
      };
    };
    if (
      typeof auth.tokens?.access_token !== "string" ||
      typeof auth.tokens.refresh_token !== "string"
    ) {
      throw new Error();
    }
    return {
      last_refresh: auth.last_refresh,
      tokens: {
        access_token: auth.tokens.access_token,
        refresh_token: auth.tokens.refresh_token,
        account_id: auth.tokens.account_id,
      },
    };
  } catch {
    // Parser diagnostics must never echo credential fragments into job errors.
    throw new Error("invalid Codex subscription auth payload");
  }
}

function parseWranglerOauth(value: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("invalid Wrangler OAuth payload");
  }
  const parsed = WranglerOauthSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid Wrangler OAuth payload");
  return parsed.data;
}

function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Installs sealed credentials into a container without persisting them on the host. */
export class CredentialInstaller {
  constructor(
    private incus: Incus,
    private privateKey: string,
  ) {}

  unseal(sealedB64: string | undefined): CredentialPayload {
    if (!sealedB64) return {};
    const opened = sealOpenJson<unknown>(sealedB64, this.privateKey);
    const parsed = CredentialPayloadSchema.safeParse(opened);
    if (!parsed.success) throw new Error("invalid sealed credential payload");
    return parsed.data;
  }

  /** Write credential files and merge selected subscription auth stores. */
  async write(name: string, creds: CredentialPayload, agents: readonly Agent[]): Promise<void> {
    const llm = creds.llmKeys ?? {};
    const selectedAgents = new Set(agents);
    // Validate nested serialized formats before making any container changes.
    const wrangler = creds.wranglerOauth ? parseWranglerOauth(creds.wranglerOauth) : undefined;
    const chatgptCredentials: Partial<
      Record<CodexAuthOwner, { serialized: string; auth: CodexAuthPayload }>
    > = {};
    for (const [owner, serialized] of [
      ["pi", llm.pi_codex_subscription_token],
      ["codex", llm.codex_subscription_token],
      ["opencode", llm.opencode_codex_subscription_token],
    ] as const) {
      if (serialized && selectedAgents.has(owner)) {
        chatgptCredentials[owner] = { serialized, auth: parseCodexAuth(serialized) };
      }
    }
    const managed = await this.readManagedCredentialState(name);
    const lines: string[] = ["# managed by workbench — rewritten on credential changes"];
    const add = (envVar: string, value: string | undefined) => {
      if (value) lines.push(`export ${envVar}=${shellQuote(value)}`);
    };
    for (const provider of LLM_PROVIDERS) {
      for (const envVar of LLM_ENV_VARS[provider]) add(envVar, llm[provider]);
    }
    add("CLOUDFLARE_API_TOKEN", creds.cloudflareToken);
    add("SUPABASE_ACCESS_TOKEN", creds.supabaseToken);

    await this.incus.writeFile(name, "/home/dev/.config/workbench/env", lines.join("\n") + "\n", {
      owner: "dev:dev",
      mode: "0600",
    });
    await this.incus.shell(
      name,
      [
        "chown -R dev:dev /home/dev/.config",
        `for rc in /home/dev/.profile /home/dev/.zshenv; do
           touch "$rc" && chown dev:dev "$rc"
           grep -q workbench/env "$rc" || printf '\\n[ -f ~/.config/workbench/env ] && . ~/.config/workbench/env\\n' >> "$rc"
         done`,
      ].join(" && "),
    );

    if (llm.claude_subscription_token && selectedAgents.has("claude")) {
      const scriptPath = "/home/dev/.config/workbench/claude-state-merge.cjs";
      const script = [
        `const fs = require("fs");`,
        `const file = ${JSON.stringify(CLAUDE_STATE_PATH)};`,
        `let current = {};`,
        `try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}`,
        `current.hasCompletedOnboarding = true;`,
        `const temp = file + ".workbench-" + process.pid;`,
        `fs.writeFileSync(temp, JSON.stringify(current, null, 2) + "\\n", { mode: 0o600 });`,
        `fs.renameSync(temp, file);`,
        `fs.chmodSync(file, 0o600);`,
        `fs.rmSync(__filename);`,
      ].join("\n");
      await this.incus.writeFile(name, scriptPath, script, { owner: "dev:dev", mode: "0600" });
      await this.incus.shell(name, `su - dev -c ${shellQuote(`node ${scriptPath}`)}`);
    }

    const piEntries: Record<string, unknown> = {};
    const opencodeEntries: Record<string, unknown> = {};
    if (llm.pi_claude_subscription_token && selectedAgents.has("pi")) {
      piEntries.anthropic = {
        type: "oauth",
        refresh: llm.pi_claude_subscription_token,
        access: llm.pi_claude_subscription_token,
        expires: Number.MAX_SAFE_INTEGER,
      };
    }
    await this.mergeAgentAuth(name, "pi-auth-merge.cjs", PI_AUTH_PATH, piEntries);

    if (llm.github_copilot) {
      opencodeEntries["github-copilot"] = {
        type: "oauth",
        refresh: llm.github_copilot,
        access: "",
        expires: 0,
      };
    }
    if (llm.opencode_go) {
      opencodeEntries.opencode = { type: "api", key: llm.opencode_go };
    }
    if (llm.opencode_claude_subscription_token && selectedAgents.has("opencode")) {
      opencodeEntries.anthropic = {
        type: "oauth",
        refresh: llm.opencode_claude_subscription_token,
        access: llm.opencode_claude_subscription_token,
        expires: Number.MAX_SAFE_INTEGER,
      };
    }
    await this.mergeAgentAuth(
      name,
      "opencode-auth-merge.cjs",
      OPENCODE_AUTH_PATH,
      opencodeEntries,
    );

    if (creds.githubToken) {
      const ghHosts = [
        "github.com:",
        `    oauth_token: ${creds.githubToken}`,
        `    user: ${creds.githubLogin ?? "workbench"}`,
        "    git_protocol: https",
      ].join("\n");
      await this.incus.writeFile(name, "/home/dev/.config/gh/hosts.yml", ghHosts + "\n", {
        owner: "dev:dev",
        mode: "0600",
      });
      await this.incus.shell(name, "chown dev:dev /home/dev/.config/gh");
      await this.incus.shell(
        name,
        'rm -f /home/dev/.git-credentials && su - dev -c "gh auth setup-git --hostname github.com"',
      );
      await this.configureGitSigning(name, creds.githubLogin?.trim() || "workbench");
    } else {
      await this.incus.shell(
        name,
        "rm -f /home/dev/.config/gh/hosts.yml /home/dev/.git-credentials",
      );
    }

    // CLI-owned OAuth stores rotate refresh tokens locally. Reconcile each
    // dashboard grant independently so an unchanged lifecycle snapshot never
    // replaces the newer local token, while reconnects and disconnects still
    // apply after a stopped instance starts again.
    await this.reconcileChatgptAuth(
      name,
      managed,
      selectedAgents,
      chatgptCredentials,
    );
    // Persist each provider decision before touching the next rotating store.
    // A later provider failure can then retry without replaying this grant.
    await this.writeManagedCredentialState(name, managed.state);
    await this.reconcileWranglerAuth(name, managed, creds.wranglerOauth, wrangler);
    await this.writeManagedCredentialState(name, managed.state);
    await this.reconcileConvexAuth(name, managed, creds.convexToken);
    await this.writeManagedCredentialState(name, managed.state);
  }

  /** Presence-only view; credential values are never read back from disk. */
  async detectPresence(name: string): Promise<CredentialPayload> {
    const creds: CredentialPayload = {};
    try {
      const { stdout } = await this.incus.shell(
        name,
        "grep -o '^export [A-Z_]*' /home/dev/.config/workbench/env 2>/dev/null | awk '{print $2}'; " +
          "test -f /home/dev/.config/gh/hosts.yml && echo GH_CONNECTED; " +
          `(test -f ${CODEX_AUTH_PATH} || ` +
          `grep -q '"openai-codex"' ${PI_AUTH_PATH} 2>/dev/null || ` +
          `grep -q '"openai"' ${OPENCODE_AUTH_PATH} 2>/dev/null) && echo CODEX_AUTH_JSON; ` +
          `grep -q '"github-copilot"' ${OPENCODE_AUTH_PATH} 2>/dev/null && echo COPILOT_CONNECTED; ` +
          `test -f ${WRANGLER_CONFIG_PATH} && echo WRANGLER_CONNECTED; ` +
          `test -f ${CONVEX_CONFIG_PATH} && echo CONVEX_CONNECTED || true`,
      );
      const vars = new Set(stdout.split("\n").map((line) => line.trim()));
      const llm: CredentialPayload["llmKeys"] = {};
      for (const provider of LLM_PROVIDERS) {
        if (LLM_ENV_VARS[provider].some((envVar) => vars.has(envVar))) llm[provider] = "1";
      }
      if (vars.has("CODEX_AUTH_JSON")) llm.codex_subscription_token = "1";
      if (vars.has("COPILOT_CONNECTED")) llm.github_copilot = "1";
      if (Object.keys(llm).length) creds.llmKeys = llm;
      if (vars.has("CLOUDFLARE_API_TOKEN")) creds.cloudflareToken = "1";
      if (vars.has("SUPABASE_ACCESS_TOKEN")) creds.supabaseToken = "1";
      if (vars.has("WRANGLER_CONNECTED")) creds.wranglerOauth = "1";
      if (vars.has("CONVEX_CONNECTED")) creds.convexToken = "1";
      if (vars.has("GH_CONNECTED")) creds.githubToken = "1";
    } catch {
      // Best effort: an unreadable MOTD source should never fail a job.
    }
    return creds;
  }

  /** Configure GitHub identity, then create and register a persistent SSH signing key. */
  private async configureGitSigning(name: string, githubLogin: string): Promise<void> {
    const publicKeyPath = `${GIT_SIGNING_KEY_PATH}.pub`;
    const script = [
      "install -d -m 700 /home/dev/.ssh",
      `if test ! -f ${GIT_SIGNING_KEY_PATH}; then rm -f ${publicKeyPath}; ssh-keygen -q -t ed25519 -N '' -C 'workbench commit signing' -f ${GIT_SIGNING_KEY_PATH}; fi`,
      `if test ! -f ${publicKeyPath}; then ssh-keygen -y -f ${GIT_SIGNING_KEY_PATH} > ${publicKeyPath}; fi`,
      `public_key="$(cut -d ' ' -f 1-2 ${publicKeyPath})"`,
      `if ! gh api --paginate user/ssh_signing_keys --jq '.[].key' | cut -d ' ' -f 1-2 | grep -Fqx "$public_key"; then gh api --method POST user/ssh_signing_keys -f title='usebench.dev instance' -F key=@${publicKeyPath} --silent; fi`,
      `git config --global user.name ${shellQuote(githubLogin)}`,
      `git config --global user.email ${shellQuote(`${githubLogin}@users.noreply.github.com`)}`,
      `git config --global gpg.format ssh`,
      `git config --global user.signingkey ${GIT_SIGNING_KEY_PATH}`,
      "git config --global commit.gpgsign true",
      `chmod 600 ${GIT_SIGNING_KEY_PATH} && chmod 644 ${publicKeyPath}`,
    ].join(" && ");
    await this.incus.shell(name, `su - dev -c ${shellQuote(script)}`);
  }

  private async mergeAgentAuth(
    name: string,
    scriptName: string,
    authPath: string,
    entries: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(entries).length === 0) return;
    const scriptPath = `/home/dev/.config/workbench/${scriptName}`;
    const script = [
      `const fs = require("fs");`,
      `const file = ${JSON.stringify(authPath)};`,
      `const add = ${JSON.stringify(entries)};`,
      `fs.mkdirSync(require("path").dirname(file), { recursive: true });`,
      `let current = {};`,
      `try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}`,
      `fs.writeFileSync(file, JSON.stringify({ ...current, ...add }, null, 2) + "\\n", { mode: 0o600 });`,
      `fs.chmodSync(file, 0o600);`,
      `fs.rmSync(__filename);`,
    ].join("\n");
    await this.incus.writeFile(name, scriptPath, script, { owner: "dev:dev", mode: "0600" });
    await this.incus.shell(name, `su - dev -c ${shellQuote(`node ${scriptPath}`)}`);
  }

  private async deleteAgentAuth(
    name: string,
    scriptName: string,
    authPath: string,
    provider: string,
  ): Promise<void> {
    const scriptPath = `/home/dev/.config/workbench/${scriptName}`;
    const script = [
      `const fs = require("fs");`,
      `const file = ${JSON.stringify(authPath)};`,
      `let current = {};`,
      `try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}`,
      `delete current[${JSON.stringify(provider)}];`,
      `fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\\n", { mode: 0o600 });`,
      `fs.chmodSync(file, 0o600);`,
      `fs.rmSync(__filename);`,
    ].join("\n");
    await this.incus.writeFile(name, scriptPath, script, { owner: "dev:dev", mode: "0600" });
    await this.incus.shell(name, `su - dev -c ${shellQuote(`node ${scriptPath}`)}`);
  }

  private async readManagedCredentialState(name: string): Promise<StoredManagedCredentialState> {
    const { stdout } = await this.incus.shell(
      name,
      `if test -f ${shellQuote(MANAGED_CREDENTIAL_STATE_PATH)}; then ` +
        `printf 'present\\n'; cat ${shellQuote(MANAGED_CREDENTIAL_STATE_PATH)}; fi`,
    );
    if (!stdout.startsWith("present\n")) return { exists: false, state: { version: 2 } };

    try {
      const parsed = JSON.parse(stdout.slice("present\n".length)) as Record<string, unknown>;
      if (parsed.version !== 1 && parsed.version !== 2) throw new Error();
      const state: ManagedCredentialState = { version: 2 };
      if (parsed.version === 2 && parsed.chatgpt !== undefined) {
        const raw = parsed.chatgpt as Record<string, unknown>;
        const chatgpt: Partial<Record<CodexAuthOwner, { fingerprint: string }>> = {};
        for (const owner of ["pi", "codex", "opencode"] as const) {
          if (raw[owner] === undefined) continue;
          const credential = raw[owner] as Record<string, unknown>;
          if (!isFingerprint(credential.fingerprint)) throw new Error();
          chatgpt[owner] = { fingerprint: credential.fingerprint };
        }
        if (Object.keys(chatgpt).length > 0) state.chatgpt = chatgpt;
      }
      if (parsed.wrangler !== undefined) {
        const wrangler = parsed.wrangler as Record<string, unknown>;
        if (!isFingerprint(wrangler.fingerprint)) throw new Error();
        state.wrangler = { fingerprint: wrangler.fingerprint };
      }
      if (parsed.convex !== undefined) {
        const convex = parsed.convex as Record<string, unknown>;
        if (!isFingerprint(convex.fingerprint)) throw new Error();
        state.convex = { fingerprint: convex.fingerprint };
      }
      // Version 1 tracked one shared OpenAI grant. Treat those stores as
      // unmanaged during migration so a per-agent rollout never deletes a
      // locally refreshed login. Wrangler's independent marker is retained.
      return { exists: parsed.version === 2, state };
    } catch {
      // A corrupt or unrecognized marker must fail closed rather than risk
      // replaying a stale rotating token over a valid local session.
      throw new Error("invalid managed credential state");
    }
  }

  private async writeManagedCredentialState(
    name: string,
    state: ManagedCredentialState,
  ): Promise<void> {
    await this.incus.writeFile(
      name,
      MANAGED_CREDENTIAL_STATE_PATH,
      JSON.stringify(state, null, 2) + "\n",
      { owner: "dev:dev", mode: "0600" },
    );
  }

  private async localCodexCredentials(
    name: string,
  ): Promise<Map<CodexAuthOwner, string | undefined>> {
    const script = [
      `const crypto = require("crypto");`,
      `const fs = require("fs");`,
      `const credentialPairs = [`,
      `  ["codex", ${JSON.stringify(CODEX_AUTH_PATH)}, (value) => value.tokens],`,
      `  ["pi", ${JSON.stringify(PI_AUTH_PATH)}, (value) => value["openai-codex"]],`,
      `  ["opencode", ${JSON.stringify(OPENCODE_AUTH_PATH)}, (value) => value.openai],`,
      `];`,
      `for (const [owner, file, select] of credentialPairs) {`,
      `  try {`,
      `    const credential = select(JSON.parse(fs.readFileSync(file, "utf8")));`,
      `    if (typeof credential?.access !== "string" && typeof credential?.access_token !== "string") continue;`,
      `    if (typeof credential?.refresh !== "string" && typeof credential?.refresh_token !== "string") continue;`,
      `    const access = credential.access ?? credential.access_token;`,
      `    const refresh = credential.refresh ?? credential.refresh_token;`,
      `    const fingerprint = crypto.createHash("sha256").update(access + "\\0" + refresh).digest("hex");`,
      `    console.log(owner + " " + fingerprint);`,
      `  } catch {}`,
      `}`,
    ].join("\n");
    const { stdout } = await this.incus.shell(
      name,
      `su - dev -c ${shellQuote(`node -e ${shellQuote(script)}`)}`,
    );
    const found = new Map<CodexAuthOwner, string | undefined>();
    for (const line of stdout.split("\n")) {
      const [owner, fingerprint] = line.trim().split(/\s+/, 2);
      if (owner !== "pi" && owner !== "codex" && owner !== "opencode") continue;
      found.set(owner, isFingerprint(fingerprint) ? fingerprint : undefined);
    }
    return found;
  }

  private async reconcileChatgptAuth(
    name: string,
    managed: StoredManagedCredentialState,
    selectedAgents: ReadonlySet<Agent>,
    credentials: Partial<
      Record<CodexAuthOwner, { serialized: string; auth: CodexAuthPayload }>
    >,
  ): Promise<void> {
    const localCredentials = await this.localCodexCredentials(name);
    const state = managed.state.chatgpt ?? {};
    for (const owner of ["pi", "codex", "opencode"] as const) {
      if (!selectedAgents.has(owner)) continue;
      const credential = credentials[owner];
      const current = state[owner];
      if (!credential) {
        if (current) {
          await this.removeCodexAuth(name, owner);
          delete state[owner];
        }
        continue;
      }

      const fingerprint = credentialFingerprint(credential.serialized.trim());
      if (current?.fingerprint === fingerprint && localCredentials.has(owner)) continue;
      // Homes without a per-agent marker may already contain a refreshed or
      // manually created login. Adopt it instead of replaying a D1 snapshot.
      if (!current && localCredentials.has(owner)) {
        state[owner] = { fingerprint };
        continue;
      }
      await this.installCodexAuth(name, owner, credential.serialized, credential.auth);
      state[owner] = { fingerprint };
    }
    if (Object.keys(state).length > 0) managed.state.chatgpt = state;
    else delete managed.state.chatgpt;
  }

  private async installCodexAuth(
    name: string,
    owner: CodexAuthOwner,
    serialized: string,
    auth: CodexAuthPayload,
  ): Promise<void> {
    if (owner === "codex") {
      await this.incus.writeFile(name, CODEX_AUTH_PATH, serialized.trim() + "\n", {
        owner: "dev:dev",
        mode: "0600",
      });
      await this.incus.shell(name, "chown dev:dev /home/dev/.codex");
      return;
    }

    const access = auth.tokens.access_token;
    const refresh = auth.tokens.refresh_token;
    const refreshedAt = typeof auth.last_refresh === "string"
      ? Date.parse(auth.last_refresh)
      : Number.NaN;
    const oauth = {
      type: "oauth",
      refresh,
      access,
      expires: (Number.isFinite(refreshedAt) ? refreshedAt : Date.now()) + 60 * 60 * 1000,
    };
    if (owner === "pi") {
      await this.mergeAgentAuth(
        name,
        "pi-auth-merge.cjs",
        PI_AUTH_PATH,
        { "openai-codex": oauth },
      );
      return;
    }
    await this.mergeAgentAuth(
      name,
      "opencode-auth-merge.cjs",
      OPENCODE_AUTH_PATH,
      {
        openai: {
          ...oauth,
          ...(typeof auth.tokens?.account_id === "string"
            ? { accountId: auth.tokens.account_id }
            : {}),
        },
      },
    );
  }

  private async removeCodexAuth(name: string, owner: CodexAuthOwner): Promise<void> {
    if (owner === "codex") {
      await this.incus.shell(name, `rm -f ${shellQuote(CODEX_AUTH_PATH)}`);
    } else if (owner === "pi") {
      await this.deleteAgentAuth(name, "pi-auth-delete.cjs", PI_AUTH_PATH, "openai-codex");
    } else {
      await this.deleteAgentAuth(name, "opencode-auth-delete.cjs", OPENCODE_AUTH_PATH, "openai");
    }
  }

  private async reconcileWranglerAuth(
    name: string,
    managed: StoredManagedCredentialState,
    serialized: string | undefined,
    auth: ReturnType<typeof parseWranglerOauth> | undefined,
  ): Promise<void> {
    const current = managed.state.wrangler;
    if (!serialized || !auth) {
      if (current) {
        await this.incus.shell(name, `rm -f ${shellQuote(WRANGLER_CONFIG_PATH)}`);
        delete managed.state.wrangler;
      }
      return;
    }

    const fingerprint = credentialFingerprint(serialized);
    const { stdout } = await this.incus.shell(
      name,
      `test -f ${shellQuote(WRANGLER_CONFIG_PATH)} && echo present || true`,
    );
    const localExists = stdout.split("\n").some((line) => line.trim() === "present");
    if (current?.fingerprint === fingerprint && localExists) return;
    if (!managed.exists && !current && localExists) {
      managed.state.wrangler = { fingerprint };
      return;
    }

    const tomlString = (value: string) => JSON.stringify(value);
    const toml = [
      "# managed by workbench — wrangler rotates these tokens itself",
      `oauth_token = ${tomlString(auth.oauth_token)}`,
      `refresh_token = ${tomlString(auth.refresh_token)}`,
      `expiration_time = ${tomlString(auth.expiration_time)}`,
      `scopes = [${auth.scopes.map(tomlString).join(", ")}]`,
    ].join("\n");
    await this.incus.writeFile(name, WRANGLER_CONFIG_PATH, toml + "\n", {
      owner: "dev:dev",
      mode: "0600",
    });
    await this.incus.shell(name, "chown -R dev:dev /home/dev/.wrangler");
    managed.state.wrangler = { fingerprint };
  }

  private async reconcileConvexAuth(
    name: string,
    managed: StoredManagedCredentialState,
    token: string | undefined,
  ): Promise<void> {
    const current = managed.state.convex;
    if (!token) {
      if (current) {
        await this.incus.shell(name, `rm -f ${shellQuote(CONVEX_CONFIG_PATH)}`);
        delete managed.state.convex;
      }
      return;
    }

    const fingerprint = credentialFingerprint(token);
    const { stdout } = await this.incus.shell(
      name,
      `test -f ${shellQuote(CONVEX_CONFIG_PATH)} && echo present || true`,
    );
    const localExists = stdout.split("\n").some((line) => line.trim() === "present");
    if (current?.fingerprint === fingerprint && localExists) return;
    if (!managed.exists && !current && localExists) {
      managed.state.convex = { fingerprint };
      return;
    }

    await this.incus.writeFile(
      name,
      CONVEX_CONFIG_PATH,
      JSON.stringify({ accessToken: token }, null, 2) + "\n",
      { owner: "dev:dev", mode: "0600" },
    );
    await this.incus.shell(name, "chown -R dev:dev /home/dev/.convex");
    managed.state.convex = { fingerprint };
  }
}
