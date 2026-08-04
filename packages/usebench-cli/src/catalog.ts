export const AGENTS = ["pi", "opencode", "codex", "claude"] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<Agent, string> = {
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
};

export const AGENT_DESCRIPTIONS: Record<Agent, string> = {
  pi: "A minimal agent harness you can adapt to your workflows.",
  opencode: "An open-source AI coding agent.",
  codex: "OpenAI's coding agent.",
  claude: "Anthropic's coding agent.",
};

export const PASTEABLE_PROVIDERS = [
  "opencode_go",
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "deepseek",
  "kimi",
  "minimax",
  "zai",
  "vercel_ai_gateway",
] as const;
export type PasteableProvider = (typeof PASTEABLE_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<PasteableProvider, string> = {
  opencode_go: "OpenCode Go",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  kimi: "Kimi",
  minimax: "MiniMax",
  zai: "Z.AI",
  vercel_ai_gateway: "Vercel AI Gateway",
};

export const GITHUB_REPOSITORY_LIMIT = 20;
