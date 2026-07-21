/**
 * Narrow host operations exposed by the daemon. Credential installation is
 * delegated so lifecycle orchestration stays separate from secret handling.
 */
import {
  AGENTS,
  type Agent,
  type JobRequest,
  type ProvisionResult,
} from "@workbench/contract";
import { installScript } from "./agents.js";
import type { DaemonConfig } from "./config.js";
import { CredentialInstaller } from "./credential-installer.js";
import { containerName, homeVolumeName, shellQuote, type Incus } from "./incus.js";
import { renderMotd } from "./motd.js";

// The Worker’s `spec.cpu` is the public, presented allocation. Give every
// environment two vCPUs on the host so interactive development stays snappy.
const PROVISIONED_VCPU_FLOOR = 2;

export class Provisioner {
  private credentialInstaller: CredentialInstaller;

  constructor(
    private incus: Incus,
    private config: DaemonConfig,
  ) {
    this.credentialInstaller = new CredentialInstaller(incus, config.x25519PrivateKey);
  }

  async run(request: JobRequest): Promise<ProvisionResult | null> {
    const name = containerName(request.containerId);
    switch (request.op) {
      case "provision":
      case "rebuild":
        return this.provision(request, name);
      case "start": {
        await this.incus.start(name);
        // Optional fields preserve compatibility with older Workers during a
        // daemon-first rollout. Current Workers always send a full snapshot.
        if (request.sshKeys && request.dashboardUrl) {
          const credentials = this.credentialInstaller.unseal(request.sealedCredentials);
          const agents = await this.agentsOf(name);
          await this.writeAuthorizedKeys(name, request.sshKeys);
          await this.credentialInstaller.write(name, credentials, agents);
          await this.incus.writeFile(
            name,
            "/etc/motd",
            renderMotd({
              agents,
              credentials,
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
        await this.incus.setLimits(name, this.provisionedCpu(request.spec.cpu), request.spec.ramMb);
        await this.incus.setRootDiskLimit(name, request.spec.diskGb);
        await this.incus.resizeHomeVolume(
          this.config.storagePool,
          homeVolumeName(request.containerId),
          request.spec.diskGb,
        );
        return null;
      case "destroy": {
        if (await this.incus.exists(name)) await this.incus.delete(name);
        const volume = homeVolumeName(request.containerId);
        if (await this.incus.volumeExists(this.config.storagePool, volume)) {
          await this.incus.deleteHomeVolume(this.config.storagePool, volume);
        }
        return null;
      }
      case "sync-keys":
        await this.writeAuthorizedKeys(name, request.sshKeys);
        await this.refreshMotdKeysOnly(name, request.sshKeys.length, request.dashboardUrl);
        return null;
      case "refresh-credentials": {
        const credentials = this.credentialInstaller.unseal(request.sealedCredentials);
        const agents = await this.agentsOf(name);
        await this.credentialInstaller.write(name, credentials, agents);
        await this.incus.writeFile(
          name,
          "/etc/motd",
          renderMotd({
            agents,
            credentials,
            sshKeyCount: await this.authorizedKeyCount(name),
            dashboardUrl: request.dashboardUrl,
          }),
        );
        return null;
      }
    }
  }

  /** Provision a disposable rootfs while preserving the managed home volume. */
  private async provision(
    request: Extract<JobRequest, { op: "provision" | "rebuild" }>,
    name: string,
  ): Promise<ProvisionResult> {
    const { spec, sshKeys, dashboardUrl } = request;
    this.validateGithubRepositoryTargets(request.githubRepos);
    const credentials = this.credentialInstaller.unseal(request.sealedCredentials);
    const volume = homeVolumeName(request.containerId);

    // Rebuilds and interrupted first attempts both replace the rootfs. The
    // separately managed home volume survives either path.
    if (await this.incus.exists(name)) await this.incus.delete(name);
    if (!(await this.incus.volumeExists(this.config.storagePool, volume))) {
      await this.incus.createHomeVolume(this.config.storagePool, volume, spec.diskGb);
    }

    try {
      await this.incus.init(
        this.config.baseImage,
        name,
        request.containerId,
        this.provisionedCpu(spec.cpu),
        spec.ramMb,
      );
      await this.incus.setRootDiskLimit(name, spec.diskGb);
      await this.incus.attachHome(name, this.config.storagePool, volume);
      await this.incus.addSshProxy(name, spec.sshPort);
      await this.incus.start(name);
      await this.incus.waitReady(name);

      await this.incus.shell(
        name,
        [
          "chown dev:dev /home/dev",
          "chmod 750 /home/dev",
          'su - dev -c "test -f ~/.profile || cp -rT /etc/skel ~ 2>/dev/null || true"',
        ].join(" && "),
      );

      await this.writeAuthorizedKeys(name, sshKeys);
      await this.credentialInstaller.write(name, credentials, spec.agents);
      await this.cloneGithubRepositories(name, request.githubRepos);
      await this.incus.writeFile(name, "/etc/workbench-agents", spec.agents.join("\n") + "\n");
      await this.incus.writeFile(
        name,
        "/etc/motd",
        renderMotd({
          agents: spec.agents,
          credentials,
          sshKeyCount: sshKeys.length,
          dashboardUrl,
        }),
      );

      // Images contain all supported agents. This fallback only reaches npm
      // when an older or custom image is missing a requested binary.
      await this.incus.shell(name, installScript(spec.agents));
      return { hostKeyFingerprints: await this.incus.hostKeyFingerprints(name) };
    } catch (error) {
      try {
        if (await this.incus.exists(name)) await this.incus.delete(name);
      } catch (cleanupError) {
        console.error(
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

  private provisionedCpu(presentedCpu: number): number {
    return Math.max(PROVISIONED_VCPU_FLOOR, presentedCpu);
  }

  private validateGithubRepositoryTargets(repositories: readonly string[]): void {
    const destinations = new Set<string>();
    for (const repository of repositories) {
      const repo = repository.split("/")[1];
      if (!repo) throw new Error("invalid GitHub repository name");
      const destination = repo.toLocaleLowerCase();
      if (destinations.has(destination)) {
        throw new Error("selected GitHub repositories must have unique names");
      }
      destinations.add(destination);
    }
  }

  /** Clone requested repositories once into ~/repos/repository-name. */
  private async cloneGithubRepositories(name: string, repositories: string[]): Promise<void> {
    for (const repository of repositories) {
      const [owner, repo] = repository.split("/");
      if (!owner || !repo) throw new Error("invalid GitHub repository name");
      const parent = "/home/dev/repos";
      const destination = `${parent}/${repo}`;
      const clone = [
        `if test -e ${shellQuote(destination)}; then`,
        `  test -d ${shellQuote(`${destination}/.git`)} || { echo 'clone destination already exists and is not a git repository' >&2; exit 1; }`,
        "else",
        `  mkdir -p ${shellQuote(parent)} && gh repo clone ${shellQuote(repository)} ${shellQuote(destination)}`,
        "fi",
      ].join("\n");
      await this.incus.shell(name, `su - dev -c ${shellQuote(clone)}`);
    }
  }

  /** Pubkey-only SSH; no keys means no authorized_keys file. */
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

  /** sync-keys refreshes the MOTD from credential presence, never values. */
  private async refreshMotdKeysOnly(
    name: string,
    sshKeyCount: number,
    dashboardUrl: string,
  ): Promise<void> {
    const [agents, credentials] = await Promise.all([
      this.agentsOf(name),
      this.credentialInstaller.detectPresence(name),
    ]);
    await this.incus.writeFile(
      name,
      "/etc/motd",
      renderMotd({ agents, credentials, sshKeyCount, dashboardUrl }),
    );
  }

  /** Selected agents, with a binary scan fallback for pre-metadata containers. */
  private async agentsOf(name: string): Promise<Agent[]> {
    const { stdout } = await this.incus.shell(
      name,
      `if test -s /etc/workbench-agents; then
         cat /etc/workbench-agents
       else
         for a in ${AGENTS.join(" ")}; do command -v $a >/dev/null && echo $a; done
       fi
       true`,
    );
    const found = new Set(stdout.split("\n").map((line) => line.trim()));
    return AGENTS.filter((agent) => found.has(agent));
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
