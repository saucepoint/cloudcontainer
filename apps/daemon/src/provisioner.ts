/**
 * Job implementations: the ~9 narrow host operations the daemon exposes.
 * Sealed credential payloads are decrypted in memory and written straight
 * into the container's config files — never to host disk or logs.
 */
import {
  AGENTS,
  LLM_PROVIDERS,
  sealOpenJson,
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
  claude_subscription_token: ["CLAUDE_CODE_OAUTH_TOKEN"],
  codex_subscription_token: [], // file-based: written to ~/.codex/auth.json, not an env var
};

/** Where the Codex CLI keeps its subscription (ChatGPT sign-in) credentials. */
const CODEX_AUTH_PATH = "/home/dev/.codex/auth.json";

export class Provisioner {
  constructor(
    private incus: Incus,
    private config: DaemonConfig,
  ) {}

  private unseal(sealedB64: string | undefined): CredentialPayload {
    if (!sealedB64) return {};
    return sealOpenJson<CredentialPayload>(sealedB64, this.config.x25519PrivateKey);
  }

  async run(request: JobRequest): Promise<ProvisionResult | null> {
    const name = containerName(request.containerId);
    switch (request.op) {
      case "provision":
        return this.provision(request, name, false);
      case "rebuild":
        return this.provision(request, name, true);
      case "start":
      case "export-window":
        await this.incus.start(name);
        return null;
      case "stop":
        await this.incus.stop(name);
        return null;
      case "resize":
        await this.incus.setLimits(name, request.spec.cpu, request.spec.ramMb);
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
    rebuild: boolean,
  ): Promise<ProvisionResult> {
    const { spec, sshKeys, dashboardUrl } = request;
    const creds = this.unseal(request.sealedCredentials);
    const vol = homeVolumeName(request.containerId);

    if (rebuild && (await this.incus.exists(name))) {
      await this.incus.delete(name); // rootfs is disposable; home volume survives
    }
    if (!(await this.incus.volumeExists(this.config.storagePool, vol))) {
      await this.incus.createHomeVolume(this.config.storagePool, vol, spec.diskGb);
    }

    await this.incus.init(this.config.baseImage, name, request.containerId, spec.cpu, spec.ramMb);
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
      "/etc/motd",
      renderMotd({ agents: spec.agents, credentials: creds, sshKeyCount: sshKeys.length, dashboardUrl }),
    );

    // Idempotent agent installs (upgrade-in-place if present).
    await this.incus.shell(name, installScript(spec.agents));

    return { hostKeyFingerprints: await this.incus.hostKeyFingerprints(name) };
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

    // Codex subscription auth is the pasted contents of ~/.codex/auth.json
    // (produced by `codex login` on the user's machine). Write-only: when the
    // dashboard credential is absent we leave the file alone so an in-shell
    // `codex login` survives credential refreshes.
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
          `test -f ${CODEX_AUTH_PATH} && echo CODEX_AUTH_JSON || true`,
      );
      const vars = new Set(stdout.split("\n").map((l) => l.trim()));
      const llm: CredentialPayload["llmKeys"] = {};
      for (const provider of LLM_PROVIDERS) {
        if (LLM_ENV_VARS[provider].some((v) => vars.has(v))) llm[provider] = "1";
      }
      if (vars.has("CODEX_AUTH_JSON")) llm.codex_subscription_token = "1";
      if (Object.keys(llm).length) creds.llmKeys = llm;
      if (vars.has("CLOUDFLARE_API_TOKEN")) creds.cloudflareToken = "1";
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
        `for a in ${AGENTS.join(" ")}; do command -v $a >/dev/null && echo $a; done; true`,
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
