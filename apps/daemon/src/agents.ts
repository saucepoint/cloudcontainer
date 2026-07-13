import type { Agent } from "@codestation/contract";

/**
 * Per-agent install shims (§9): each returns an idempotent root shell script
 * (upgrade-in-place if present, install if absent) so rebuilds can re-run
 * them safely. Node is baked system-wide into the base image.
 */
const AGENT_INSTALLERS: Record<Agent, string> = {
  pi: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g opencode-ai",
};

/** Binary name used for the MOTD "run <agent>" hint. */
export const AGENT_BINARIES: Record<Agent, string> = {
  pi: "pi",
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
};

export function installScript(agents: readonly Agent[]): string {
  const fallbacks = agents.map(
    (agent) =>
      `command -v ${AGENT_BINARIES[agent]} >/dev/null 2>&1 || ${AGENT_INSTALLERS[agent]}`,
  );
  return ["set -e", "export npm_config_loglevel=error", ...fallbacks].join("\n");
}
