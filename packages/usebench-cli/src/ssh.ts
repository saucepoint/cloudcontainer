import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { confirm, select } from "@inquirer/prompts";
import { BACK, promptWithBack, type Back } from "./navigation.js";

const execFile = promisify(execFileCallback);
const PUBLIC_KEY_PATTERN = /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+(?: [^\n]*)?$/;

export interface SelectedSshKey {
  publicKey: string | undefined;
  privatePath: string | undefined;
}

export interface SshConfigResult {
  configured: boolean;
  conflict: boolean;
  path: string;
}

function sshDirectory(): string {
  return join(homedir(), ".ssh");
}

function validPublicKey(value: string): boolean {
  return PUBLIC_KEY_PATTERN.test(value.trim());
}

async function readPublicKey(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return validPublicKey(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function generateDedicatedKey(): Promise<SelectedSshKey> {
  const privatePath = join(sshDirectory(), "workbench_id_ed25519");
  const publicPath = `${privatePath}.pub`;
  await mkdir(sshDirectory(), { recursive: true, mode: 0o700 });
  const privateExists = await pathExists(privatePath);
  const publicExists = await pathExists(publicPath);
  const existing = await readPublicKey(publicPath);
  if (privateExists || publicExists) {
    if (privateExists && existing) return { publicKey: existing, privatePath };
    throw new Error(`Refusing to overwrite an existing SSH key at ${privatePath}; remove it or restore its matching public key first.`);
  }

  try {
    await execFile("ssh-keygen", [
      "-t", "ed25519",
      "-f", privatePath,
      "-N", "",
      "-C", "usebench workbench",
    ], { maxBuffer: 16 * 1024 });
  } catch {
    throw new Error(`Could not generate ${privatePath}; make sure ssh-keygen is installed.`);
  }
  const generated = await readPublicKey(publicPath);
  if (!generated) throw new Error(`ssh-keygen did not create a valid public key at ${publicPath}.`);
  await chmod(privatePath, 0o600);
  await chmod(publicPath, 0o644);
  return { publicKey: generated, privatePath };
}

export async function chooseSshKey(): Promise<SelectedSshKey | Back> {
  const defaultPrivatePath = join(sshDirectory(), "id_ed25519");
  const defaultPublicPath = `${defaultPrivatePath}.pub`;
  const defaultPublic = await readPublicKey(defaultPublicPath);
  const choices = [
    ...(defaultPublic
      ? [{ name: `Reuse ${defaultPublicPath}`, value: "default" as const, description: "Only the public key is sent to usebench." }]
      : []),
    { name: `Generate ${join(sshDirectory(), "workbench_id_ed25519.pub")}`, value: "dedicated" as const, description: "Creates a new local ed25519 keypair without overwriting an existing one." },
    { name: "Skip SSH for now", value: "none" as const, description: "SSH remains disabled until you add a key later." },
  ];
  const selection = await promptWithBack(select, { message: "SSH access", choices });
  if (selection === BACK) return BACK;
  if (selection === "default") return { publicKey: defaultPublic, privatePath: defaultPrivatePath };
  if (selection === "dedicated") return generateDedicatedKey();
  return { publicKey: undefined, privatePath: undefined };
}

export function renderSshConfigBlock(host: string, port: number, privatePath: string): string {
  return [
    "# >>> usebench managed >>>",
    "Host workbench",
    `  HostName ${host}`,
    "  User dev",
    `  Port ${port}`,
    `  IdentityFile ${privatePath}`,
    "  IdentitiesOnly yes",
    "# <<< usebench managed <<<",
  ].join("\n");
}

export async function maybeConfigureSshShortcut(
  sshCommand: string,
  privatePath: string | undefined,
): Promise<SshConfigResult> {
  const path = join(sshDirectory(), "config");
  if (!privatePath) return { configured: false, conflict: false, path };
  const parsed = sshCommand.match(/^ssh -p (\d+) (?:[^@\s]+@)?([^\s]+)$/);
  if (!parsed) return { configured: false, conflict: false, path };
  const shouldConfigure = await confirm({
    message: "Add an `ssh workbench` shortcut to ~/.ssh/config?",
    default: true,
  });
  if (!shouldConfigure) return { configured: false, conflict: false, path };

  await mkdir(sshDirectory(), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    // The file is created below.
  }
  const host = parsed[2];
  const port = parsed[1];
  if (!host || !port) return { configured: false, conflict: false, path };
  const block = renderSshConfigBlock(host, Number(port), privatePath);
  const managed = /# >>> usebench managed >>>[\s\S]*?# <<< usebench managed <<</;
  if (managed.test(current)) {
    current = current.replace(managed, block);
  } else if (/^\s*Host\s+workbench(?:\s|$)/m.test(current)) {
    return { configured: false, conflict: true, path };
  } else {
    current = `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  }

  const temp = `${path}.usebench-${process.pid}.tmp`;
  await writeFile(temp, current, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
  return { configured: true, conflict: false, path };
}
