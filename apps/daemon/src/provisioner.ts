/**
 * Job implementations: the ~9 narrow host operations the daemon exposes.
 * Sealed credential payloads are decrypted in memory and written straight
 * into the container's config files — never to host disk or logs.
 */
import {
  AGENTS,
  CredentialPayloadSchema,
  LLM_PROVIDERS,
  sealOpenJson,
  WranglerOauthSchema,
  type Agent,
  type CredentialPayload,
  type JobRequest,
  type LlmProvider,
  type ProvisionResult,
} from "@codestation/contract";
import { installScript } from "./agents.js";
import type { DaemonConfig } from "./config.js";
import { containerName, homeVolumeName, Incus, shellQuote } from "./incus.js";
import { renderMotd } from "./motd.js";

/**
 * Env var(s) each LLM credential is exported as inside the container. Single
 * source for both writing the env file and detecting credential presence.
 */
const LLM_ENV_VARS: Record<LlmProvider, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  opencode_go: ["OPENCODE_API_KEY"],
  claude_subscription_token: ["CLAUDE_CODE_OAUTH_TOKEN"],
  codex_subscription_token: [], // file-based: written to ~/.codex/auth.json, not an env var
  github_copilot: [], // file-based: merged into OpenCode's auth.json, not an env var
};

/** Where the Codex CLI keeps its subscription (ChatGPT sign-in) credentials. */
const CODEX_AUTH_PATH = "/home/dev/.codex/auth.json";
/** OpenCode's credential store; subscription entries are merged into it. */
const OPENCODE_AUTH_PATH = "/home/dev/.local/share/opencode/auth.json";
/** wrangler's login state. It checks the legacy ~/.wrangler location first. */
const WRANGLER_CONFIG_PATH = "/home/dev/.wrangler/config/default.toml";

export class Provisioner {
  constructor(
    private incus: Incus,
    private config: DaemonConfig,
  ) {}

  private unseal(sealedB64: string | undefined): CredentialPayload {
    if (!sealedB64) return {};
    const opened = sealOpenJson<unknown>(sealedB64, this.config.x25519PrivateKey);
    const parsed = CredentialPayloadSchema.safeParse(opened);
    if (!parsed.success) throw new Error("invalid sealed credential payload");
    return parsed.data;
  }

  async run(request: JobRequest): Promise<ProvisionResult | null> {
    const name = containerName(request.containerId);
    switch (request.op) {
      case "provision":
        return this.provision(request, name);
      case "rebuild":
        return this.provision(request, name);
      case "start": {
        await this.incus.start(name);
        // Current Workers attach a full configuration snapshot to start jobs.
        // This applies key/credential changes made while the container was
        // stopped before users can rely on the resumed SSH session. Optional
        // fields keep daemon-first rolling deploys compatible with old Workers.
        if (request.sshKeys && request.dashboardUrl) {
          const creds = this.unseal(request.sealedCredentials);
          await this.writeAuthorizedKeys(name, request.sshKeys);
          await this.writeCredentials(name, creds);
          await this.incus.writeFile(
            name,
            "/etc/motd",
            renderMotd({
              agents: await this.agentsOf(name),
              credentials: creds,
              sshKeyCount: request.sshKeys.length,
              dashboardUrl: request.dashboardUrl,
            }),
          );
        }
        return null;
      }
      case "export-window":
        await this.incus.start(name);
        return null;
      case "stop":
        await this.incus.stop(name);
        return null;
      case "resize":
        await this.incus.setLimits(name, request.spec.cpu, request.spec.ramMb);
        await this.incus.setRootDiskLimit(name, request.spec.diskGb);
        await this.incus.resizeHomeVolume(
          this.config.storagePool,
          homeVolumeName(request.containerId),
          request.spec.diskGb,
        );
        return null;
      case "destroy": {
        if (await this.incus.exists(name)) await this.incus.delete(name);
        const vol = homeVolumeName(request.containerId);
        if (await this.incus.volumeExists(this.config.storagePool, vol)) {
          await this.incus.deleteHomeVolume(this.config.storagePool, vol);
        }
        return null;
      }
      case "sync-keys":
        await this.writeAuthorizedKeys(name, request.sshKeys);
        await this.refreshMotdKeysOnly(name, request.sshKeys.length, request.dashboardUrl);
        return null;
      case "refresh-credentials": {
        const creds = this.unseal(request.sealedCredentials);
        await this.writeCredentials(name, creds);
        const agents = await this.agentsOf(name);
        const keyCount = await this.authorizedKeyCount(name);
        await this.incus.writeFile(
          name,
          "/etc/motd",
          renderMotd({ agents, credentials: creds, sshKeyCount: keyCount, dashboardUrl: request.dashboardUrl }),
        );
        return null;
      }
    }
  }

  /**
   * Provision (or rebuild: same flow against a fresh rootfs with the existing
   * home volume re-attached — §10 rebuild semantics). Ordered so SSH works as
   * early as possible; the agent install lands before the job completes.
   */
  private async provision(
    request: Extract<JobRequest, { op: "provision" | "rebuild" }>,
    name: string,
  ): Promise<ProvisionResult> {
    const { spec, sshKeys, dashboardUrl } = request;
    const creds = this.unseal(request.sealedCredentials);
    const vol = homeVolumeName(request.containerId);

    // Both rebuilds and retries of an interrupted fresh provision replace the
    // disposable rootfs. The separately managed home volume always survives.
    if (await this.incus.exists(name)) {
      await this.incus.delete(name);
    }
    if (!(await this.incus.volumeExists(this.config.storagePool, vol))) {
      await this.incus.createHomeVolume(this.config.storagePool, vol, spec.diskGb);
    }

    try {
      await this.incus.init(this.config.baseImage, name, request.containerId, spec.cpu, spec.ramMb);
      // The user has passwordless sudo, so the disposable rootfs needs the
      // same hard cap as the persistent home volume to protect the host pool.
      await this.incus.setRootDiskLimit(name, spec.diskGb);
      await this.incus.attachHome(name, this.config.storagePool, vol);
      await this.incus.addSshProxy(name, spec.sshPort);
      await this.incus.start(name);
      await this.incus.waitReady(name);

      // The mounted home volume starts empty (or carries a previous home on
      // rebuild): make sure it belongs to dev and has a shell skeleton.
      await this.incus.shell(
        name,
        [
          "chown dev:dev /home/dev",
          "chmod 750 /home/dev",
          'su - dev -c "test -f ~/.profile || cp -rT /etc/skel ~ 2>/dev/null || true"',
        ].join(" && "),
      );

      await this.writeAuthorizedKeys(name, sshKeys);
      await this.writeCredentials(name, creds);
      await this.incus.writeFile(
        name,
        "/etc/codestation-agents",
        spec.agents.join("\n") + "\n",
      );
      await this.incus.writeFile(
        name,
        "/etc/motd",
        renderMotd({ agents: spec.agents, credentials: creds, sshKeyCount: sshKeys.length, dashboardUrl }),
      );

      // Images contain all supported agents. This single fallback script only
      // reaches npm when an older/custom image is missing a requested binary.
      await this.incus.shell(name, installScript(spec.agents));

      return { hostKeyFingerprints: await this.incus.hostKeyFingerprints(name) };
    } catch (error) {
      // A failed personalization must not leave an SSH proxy or disposable
      // rootfs behind. Never delete the separately managed home volume.
      try {
        if (await this.incus.exists(name)) await this.incus.delete(name);
      } catch (cleanupError) {
        console.log(
          JSON.stringify({
            event: "provision_cleanup_failed",
            containerId: request.containerId,
            error: cleanupError instanceof Error ? cleanupError.message : "cleanup failed",
          }),
        );
      }
      throw error;
    }
  }

  /** Pubkey-only SSH; no keys -> no authorized_keys file (fail closed, §13). */
  private async writeAuthorizedKeys(name: string, keys: string[]): Promise<void> {
    if (keys.length === 0) {
      await this.incus.shell(name, "rm -f /home/dev/.ssh/authorized_keys");
      return;
    }
    await this.incus.writeFile(name, "/home/dev/.ssh/authorized_keys", keys.join("\n") + "\n", {
      owner: "dev:dev",
      mode: "0600",
    });
    await this.incus.shell(name, "chown dev:dev /home/dev/.ssh && chmod 700 /home/dev/.ssh");
  }

  /**
   * Write agent credential files (0600, owned by dev) and wire them into the
   * login shell. Config files over process-wide env vars where possible (§13).
   */
  private async writeCredentials(name: string, creds: CredentialPayload): Promise<void> {
    const llm = creds.llmKeys ?? {};
    const lines: string[] = ["# managed by codestation — rewritten on credential changes"];
    const add = (envVar: string, value: string | undefined) => {
      if (value) lines.push(`export ${envVar}=${shellQuote(value)}`);
    };
    for (const provider of LLM_PROVIDERS) {
      for (const envVar of LLM_ENV_VARS[provider]) add(envVar, llm[provider]);
    }
    add("CLOUDFLARE_API_TOKEN", creds.cloudflareToken);

    // Codex subscription auth is the ~/.codex/auth.json blob assembled by the
    // control-plane ChatGPT sign-in. Write-only: when the dashboard credential
    // is absent we leave the file alone so an in-shell `codex login` survives
    // credential refreshes.
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
        // Source the env file from both login shells, once.
        `for rc in /home/dev/.profile /home/dev/.zshenv; do
           touch "$rc" && chown dev:dev "$rc"
           grep -q codestation/env "$rc" || printf '\\n[ -f ~/.config/codestation/env ] && . ~/.config/codestation/env\\n' >> "$rc"
         done`,
      ].join(" && "),
    );

    // GitHub Copilot and OpenCode Go live in OpenCode's auth store. Merged in
    // by a short node script (node is baked into the base image) so providers
    // connected in-shell via `opencode auth login` survive; write-only like
    // the Codex file. The script embeds the tokens, so it is dev-owned 0600
    // and removes itself after the merge. Runs after the chown -R above so
    // dev can delete it from its directory.
    const opencodeEntries: Record<string, unknown> = {};
    if (llm.github_copilot) {
      // OpenCode's github-copilot provider keeps the GitHub OAuth token as
      // "refresh" and mints short-lived Copilot API tokens from it on demand.
      opencodeEntries["github-copilot"] = {
        type: "oauth",
        refresh: llm.github_copilot,
        access: "",
        expires: 0,
      };
    }
    if (llm.opencode_go) {
      opencodeEntries["opencode"] = { type: "api", key: llm.opencode_go };
    }
    if (Object.keys(opencodeEntries).length > 0) {
      const scriptPath = "/home/dev/.config/codestation/opencode-auth-merge.cjs";
      const script = [
        `const fs = require("fs");`,
        `const file = ${JSON.stringify(OPENCODE_AUTH_PATH)};`,
        `const add = ${JSON.stringify(opencodeEntries)};`,
        `fs.mkdirSync(require("path").dirname(file), { recursive: true });`,
        `let current = {};`,
        `try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}`,
        `fs.writeFileSync(file, JSON.stringify({ ...current, ...add }, null, 2) + "\\n", { mode: 0o600 });`,
        `fs.rmSync(__filename);`,
      ].join("\n");
      await this.incus.writeFile(name, scriptPath, script, { owner: "dev:dev", mode: "0600" });
      await this.incus.shell(name, `su - dev -c ${shellQuote(`node ${scriptPath}`)}`);
    }

    // wrangler reads its login from config/default.toml and refreshes the
    // tokens itself from inside the container. Write-only, like the Codex
    // file: an absent dashboard credential leaves an in-shell `wrangler
    // login` untouched.
    if (creds.wranglerOauth) {
      const wrangler = WranglerOauthSchema.parse(JSON.parse(creds.wranglerOauth));
      const tomlStr = (value: string) => JSON.stringify(value); // JSON escaping is valid TOML
      const toml = [
        "# managed by codestation — wrangler rotates these tokens itself",
        `oauth_token = ${tomlStr(wrangler.oauth_token)}`,
        `refresh_token = ${tomlStr(wrangler.refresh_token)}`,
        `expiration_time = ${tomlStr(wrangler.expiration_time)}`,
        `scopes = [${wrangler.scopes.map(tomlStr).join(", ")}]`,
      ].join("\n");
      await this.incus.writeFile(name, WRANGLER_CONFIG_PATH, toml + "\n", {
        owner: "dev:dev",
        mode: "0600",
      });
      await this.incus.shell(name, "chown -R dev:dev /home/dev/.wrangler");
    }

    if (creds.githubToken) {
      // gh CLI + git credential helper read from daemon-managed files (§9).
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
      await this.incus.writeFile(
        name,
        "/home/dev/.git-credentials",
        `https://x-access-token:${creds.githubToken}@github.com\n`,
        { owner: "dev:dev", mode: "0600" },
      );
      await this.incus.shell(
        name,
        'su - dev -c "git config --global credential.helper store"',
      );
    } else {
      await this.incus.shell(
        name,
        "rm -f /home/dev/.config/gh/hosts.yml /home/dev/.git-credentials",
      );
    }
  }

  /** sync-keys touched only keys; refresh the MOTD from on-disk credential *presence*. */
  private async refreshMotdKeysOnly(
    name: string,
    sshKeyCount: number,
    dashboardUrl: string,
  ): Promise<void> {
    const agents = await this.agentsOf(name);
    const credentials = await this.detectCredentialPresence(name);
    await this.incus.writeFile(
      name,
      "/etc/motd",
      renderMotd({ agents, credentials, sshKeyCount, dashboardUrl }),
    );
  }

  /**
   * Presence-only view of installed credentials, derived from which managed
   * files/vars exist. Values are never read back; "1" is a truthy marker.
   */
  private async detectCredentialPresence(name: string): Promise<CredentialPayload> {
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
      const vars = new Set(stdout.split("\n").map((l) => l.trim()));
      const llm: CredentialPayload["llmKeys"] = {};
      for (const provider of LLM_PROVIDERS) {
        if (LLM_ENV_VARS[provider].some((v) => vars.has(v))) llm[provider] = "1";
      }
      if (vars.has("CODEX_AUTH_JSON")) llm.codex_subscription_token = "1";
      if (vars.has("COPILOT_CONNECTED")) llm.github_copilot = "1";
      if (Object.keys(llm).length) creds.llmKeys = llm;
      if (vars.has("CLOUDFLARE_API_TOKEN")) creds.cloudflareToken = "1";
      if (vars.has("WRANGLER_CONNECTED")) creds.wranglerOauth = "1";
      if (vars.has("GH_CONNECTED")) creds.githubToken = "1";
    } catch {
      // best effort — an unreadable MOTD source should never fail the job
    }
    return creds;
  }

  /** All agents whose binary is installed in the container (MOTD source of truth). */
  private async agentsOf(name: string): Promise<Agent[]> {
    try {
      const { stdout } = await this.incus.shell(
        name,
        `if test -s /etc/codestation-agents; then
           cat /etc/codestation-agents
         else
           for a in ${AGENTS.join(" ")}; do command -v $a >/dev/null && echo $a; done
         fi
         true`,
      );
      const found = new Set(stdout.split("\n").map((l) => l.trim()));
      return AGENTS.filter((a) => found.has(a));
    } catch {
      return [];
    }
  }

  private async authorizedKeyCount(name: string): Promise<number> {
    try {
      const { stdout } = await this.incus.shell(
        name,
        "grep -c . /home/dev/.ssh/authorized_keys 2>/dev/null || echo 0",
      );
      return Number(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }
}
