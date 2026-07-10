import { AGENT_LABELS, type Agent, type CredentialPayload } from "@codestation/contract";
import { AGENT_BINARIES } from "./agents.js";

/**
 * First-login checklist (§5.4): which credentials are connected, which are
 * missing, and where to fix that. Rewritten on every provision /
 * refresh-credentials / sync-keys job.
 */
export function renderMotd(opts: {
  agents: Agent[];
  credentials: CredentialPayload;
  sshKeyCount: number;
  dashboardUrl: string;
}): string {
  const { agents, credentials, sshKeyCount, dashboardUrl } = opts;
  const llm = credentials.llmKeys ?? {};
  const llmProviders = Object.keys(llm).filter((k) => (llm as Record<string, string>)[k]);
  const agentList =
    agents.length > 0
      ? agents.map((a) => `${AGENT_LABELS[a]} (run: ${AGENT_BINARIES[a]})`).join(", ")
      : "(none detected)";

  const mark = (ok: boolean) => (ok ? "[x]" : "[ ]");
  const lines = [
    "",
    "  codestation — your cloud container",
    "  ----------------------------------",
    `  agents: ${agentList}`,
    "",
    `  ${mark(llmProviders.length > 0)} model access ${
      llmProviders.length > 0 ? `(${llmProviders.join(", ")})` : "— add an API key in the dashboard"
    }`,
    `  ${mark(Boolean(credentials.githubToken))} github ${
      credentials.githubToken
        ? `(${credentials.githubLogin ?? "connected"})`
        : "— connect in the dashboard"
    }`,
    `  ${mark(Boolean(credentials.cloudflareToken || credentials.wranglerOauth))} cloudflare ${
      credentials.wranglerOauth
        ? "(wrangler signed in)"
        : credentials.cloudflareToken
          ? "(token installed)"
          : "— connect in the dashboard"
    }`,
    `  ${mark(sshKeyCount > 0)} ssh keys (${sshKeyCount})`,
    "",
    `  dashboard: ${dashboardUrl}`,
    "  credentials are injected live — no restart needed after changes.",
    "",
  ];
  return lines.join("\n");
}
