import {
  CredentialPayloadSchema,
  LLM_PROVIDERS,
  sealOpenJson,
  WranglerOauthSchema,
  type Agent,
  type CredentialPayload,
  type LlmProvider,
} from "@codestation/contract";
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
  github_copilot: [],
};

const CODEX_AUTH_PATH = "/home/dev/.codex/auth.json";
const PI_AUTH_PATH = "/home/dev/.pi/agent/auth.json";
const CLAUDE_STATE_PATH = "/home/dev/.claude.json";
const OPENCODE_AUTH_PATH = "/home/dev/.local/share/opencode/auth.json";
const WRANGLER_CONFIG_PATH = "/home/dev/.wrangler/config/default.toml";

interface CodexAuthPayload {
  last_refresh?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
}

function parseCodexAuth(value: string): CodexAuthPayload {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed as CodexAuthPayload;
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
    const sharesCodexAuth = selectedAgents.has("pi") || selectedAgents.has("opencode");
    const codexAuth = llm.codex_subscription_token && sharesCodexAuth
      ? parseCodexAuth(llm.codex_subscription_token)
      : undefined;
    const lines: string[] = ["# managed by codestation — rewritten on credential changes"];
    const add = (envVar: string, value: string | undefined) => {
      if (value) lines.push(`export ${envVar}=${shellQuote(value)}`);
    };
    for (const provider of LLM_PROVIDERS) {
      for (const envVar of LLM_ENV_VARS[provider]) add(envVar, llm[provider]);
    }
    add("CLOUDFLARE_API_TOKEN", creds.cloudflareToken);

    // File-based dashboard credentials are write-only: absence preserves any
    // login the user completed from inside their persistent home directory.
    if (llm.codex_subscription_token) {
      await this.incus.writeFile(name, CODEX_AUTH_PATH, llm.codex_subscription_token.trim() + "\n", {
        owner: "dev:dev",
        mode: "0600",
      });
      await this.incus.shell(name, "chown dev:dev /home/dev/.codex");
    }

    await this.incus.writeFile(name, "/home/dev/.config/codestation/env", lines.join("\n") + "\n", {
      owner: "dev:dev",
      mode: "0600",
    });
    await this.incus.shell(
      name,
      [
        "chown -R dev:dev /home/dev/.config",
        `for rc in /home/dev/.profile /home/dev/.zshenv; do
           touch "$rc" && chown dev:dev "$rc"
           grep -q codestation/env "$rc" || printf '\\n[ -f ~/.config/codestation/env ] && . ~/.config/codestation/env\\n' >> "$rc"
         done`,
      ].join(" && "),
    );

    if (llm.claude_subscription_token) {
      const scriptPath = "/home/dev/.config/codestation/claude-state-merge.cjs";
      const script = [
        `const fs = require("fs");`,
        `const file = ${JSON.stringify(CLAUDE_STATE_PATH)};`,
        `let current = {};`,
        `try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}`,
        `current.hasCompletedOnboarding = true;`,
        `const temp = file + ".codestation-" + process.pid;`,
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
    if (llm.claude_subscription_token) {
      const oauth = {
        type: "oauth",
        refresh: llm.claude_subscription_token,
        access: llm.claude_subscription_token,
        expires: Number.MAX_SAFE_INTEGER,
      };
      if (selectedAgents.has("pi")) piEntries.anthropic = oauth;
      if (selectedAgents.has("opencode")) opencodeEntries.anthropic = oauth;
    }
    if (codexAuth) {
      const access = codexAuth.tokens?.access_token;
      const refresh = codexAuth.tokens?.refresh_token;
      if (typeof access !== "string" || typeof refresh !== "string") {
        throw new Error("invalid Codex subscription auth payload");
      }
      const refreshedAt =
        typeof codexAuth.last_refresh === "string"
          ? Date.parse(codexAuth.last_refresh)
          : Number.NaN;
      const oauth = {
        type: "oauth",
        refresh,
        access,
        expires: (Number.isFinite(refreshedAt) ? refreshedAt : Date.now()) + 60 * 60 * 1000,
      };
      if (selectedAgents.has("pi")) piEntries["openai-codex"] = oauth;
      if (selectedAgents.has("opencode")) {
        opencodeEntries.openai = {
          ...oauth,
          ...(typeof codexAuth.tokens?.account_id === "string"
            ? { accountId: codexAuth.tokens.account_id }
            : {}),
        };
      }
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
    await this.mergeAgentAuth(
      name,
      "opencode-auth-merge.cjs",
      OPENCODE_AUTH_PATH,
      opencodeEntries,
    );

    if (wrangler) {
      const tomlString = (value: string) => JSON.stringify(value);
      const toml = [
        "# managed by codestation — wrangler rotates these tokens itself",
        `oauth_token = ${tomlString(wrangler.oauth_token)}`,
        `refresh_token = ${tomlString(wrangler.refresh_token)}`,
        `expiration_time = ${tomlString(wrangler.expiration_time)}`,
        `scopes = [${wrangler.scopes.map(tomlString).join(", ")}]`,
      ].join("\n");
      await this.incus.writeFile(name, WRANGLER_CONFIG_PATH, toml + "\n", {
        owner: "dev:dev",
        mode: "0600",
      });
      await this.incus.shell(name, "chown -R dev:dev /home/dev/.wrangler");
    }

    if (creds.githubToken) {
      const ghHosts = [
        "github.com:",
        `    oauth_token: ${creds.githubToken}`,
        `    user: ${creds.githubLogin ?? "codestation"}`,
        "    git_protocol: https",
      ].join("\n");
      await this.incus.writeFile(name, "/home/dev/.config/gh/hosts.yml", ghHosts + "\n", {
        owner: "dev:dev",
        mode: "0600",
      });
      await this.incus.shell(name, "chown dev:dev /home/dev/.config/gh");
      await this.incus.writeFile(
        name,
        "/home/dev/.git-credentials",
        `https://x-access-token:${creds.githubToken}@github.com\n`,
        { owner: "dev:dev", mode: "0600" },
      );
      await this.incus.shell(name, 'su - dev -c "git config --global credential.helper store"');
    } else {
      await this.incus.shell(
        name,
        "rm -f /home/dev/.config/gh/hosts.yml /home/dev/.git-credentials",
      );
    }
  }

  /** Presence-only view; credential values are never read back from disk. */
  async detectPresence(name: string): Promise<CredentialPayload> {
    const creds: CredentialPayload = {};
    try {
      const { stdout } = await this.incus.shell(
        name,
        "grep -o '^export [A-Z_]*' /home/dev/.config/codestation/env 2>/dev/null | awk '{print $2}'; " +
          "test -f /home/dev/.config/gh/hosts.yml && echo GH_CONNECTED; " +
          `test -f ${CODEX_AUTH_PATH} && echo CODEX_AUTH_JSON; ` +
          `grep -q '"github-copilot"' ${OPENCODE_AUTH_PATH} 2>/dev/null && echo COPILOT_CONNECTED; ` +
          `test -f ${WRANGLER_CONFIG_PATH} && echo WRANGLER_CONNECTED || true`,
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
      if (vars.has("WRANGLER_CONNECTED")) creds.wranglerOauth = "1";
      if (vars.has("GH_CONNECTED")) creds.githubToken = "1";
    } catch {
      // Best effort: an unreadable MOTD source should never fail a job.
    }
    return creds;
  }

  private async mergeAgentAuth(
    name: string,
    scriptName: string,
    authPath: string,
    entries: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(entries).length === 0) return;
    const scriptPath = `/home/dev/.config/codestation/${scriptName}`;
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
}
