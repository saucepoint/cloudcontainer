import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

const PRODUCTION_URL = "https://usebench.dev";
const STAGING_URL = "https://staging.usebench.dev";

type InviteDeployment = "production" | "staging";

interface InviteProcessEnvironment {
  [key: string]: string | undefined;
  CODESTATION_URL?: string;
  INVITE_ADMIN_SECRET?: string;
  USEBENCH_STAGING_ENV_FILE?: string;
  USEBENCH_URL?: string;
  WORKBENCH_URL?: string;
}

export interface InviteCommand {
  baseUrl: string;
  deployment: InviteDeployment;
  secret: string | undefined;
  secretSource: string;
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function stagingSecret(
  environment: InviteProcessEnvironment,
): Pick<InviteCommand, "secret" | "secretSource"> {
  const envFile = environment.USEBENCH_STAGING_ENV_FILE?.trim()
    || join(homedir(), ".config", "usebench", "staging.env");
  let contents: string;
  try {
    contents = readFileSync(envFile, "utf8");
  } catch {
    throw new Error(`Could not read staging invite credentials from ${envFile}.`);
  }

  let secret: string | undefined;
  try {
    secret = parseEnv(contents).INVITE_ADMIN_SECRET;
  } catch {
    throw new Error(`Could not parse staging invite credentials from ${envFile}.`);
  }
  if (!secret) {
    throw new Error(`Set INVITE_ADMIN_SECRET in ${envFile}.`);
  }
  return { secret, secretSource: envFile };
}

export function resolveInviteCommand(
  args: readonly string[],
  environment: InviteProcessEnvironment,
): InviteCommand {
  const requestedDeployment = argument(args, "--environment") ?? "production";
  if (requestedDeployment !== "production" && requestedDeployment !== "staging") {
    throw new Error("Pass --environment production or --environment staging.");
  }
  const deployment = requestedDeployment;
  const baseUrl = (argument(args, "--url")
    ?? (deployment === "staging"
      ? STAGING_URL
      : environment.USEBENCH_URL
        ?? environment.WORKBENCH_URL
        ?? environment.CODESTATION_URL
        ?? PRODUCTION_URL)).replace(/\/$/, "");
  const credentials = deployment === "staging"
    ? stagingSecret(environment)
    : {
        secret: environment.INVITE_ADMIN_SECRET,
        secretSource: "INVITE_ADMIN_SECRET",
      };

  return { baseUrl, deployment, ...credentials };
}
