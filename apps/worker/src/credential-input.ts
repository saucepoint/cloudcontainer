import {
  INPUT_LIMITS,
  LLM_PROVIDER_LABELS,
  LLM_PROVIDERS,
  OAUTH_ONLY_LLM_PROVIDERS,
  type LlmProvider,
} from "@workbench/contract";

const OAUTH_ONLY_PROVIDER_SET: ReadonlySet<LlmProvider> = new Set(OAUTH_ONLY_LLM_PROVIDERS);

export interface CredentialInput {
  llmKeys?: Record<string, unknown>;
  cloudflareToken?: unknown;
  wranglerOauth?: unknown;
}

interface NormalizedCredentialInput {
  llmKeys: Record<string, string>;
  cloudflareToken?: string;
  wranglerOauth?: "";
}

function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

/** Validate credential names, types, and sizes before encrypting user input. */
export function normalizeCredentialInput(
  input: CredentialInput,
): { value: NormalizedCredentialInput } | { error: string } {
  if (
    input.llmKeys !== undefined &&
    (!input.llmKeys || typeof input.llmKeys !== "object" || Array.isArray(input.llmKeys))
  ) {
    return { error: "llmKeys must be an object" };
  }

  const llmKeys: Record<string, string> = {};
  for (const [provider, raw] of Object.entries(input.llmKeys ?? {})) {
    if (!isLlmProvider(provider)) {
      return { error: `unknown model provider: ${provider || "(empty)"}` };
    }
    if (typeof raw !== "string") return { error: `credential for ${provider} must be text` };
    const value = raw.trim();
    // OAuth-only credentials enter through their sign-in flows; only the
    // empty string (disconnect) is accepted here.
    if (value && OAUTH_ONLY_PROVIDER_SET.has(provider)) {
      return {
        error: `${LLM_PROVIDER_LABELS[provider]} connects via its sign-in button, not a pasted value`,
      };
    }
    if (value.length > INPUT_LIMITS.tokenBytes) {
      return { error: `credential for ${provider} is too large` };
    }
    llmKeys[provider] = value;
  }

  if (input.cloudflareToken !== undefined && typeof input.cloudflareToken !== "string") {
    return { error: "Cloudflare token must be text" };
  }
  const cloudflareToken =
    typeof input.cloudflareToken === "string" ? input.cloudflareToken.trim() : undefined;
  if (cloudflareToken && cloudflareToken.length > INPUT_LIMITS.cloudflareTokenBytes) {
    return { error: "Cloudflare token is too large" };
  }
  // Wrangler sign-in connects via /api/wrangler/oauth; only disconnection is
  // accepted through this generic input endpoint.
  if (input.wranglerOauth !== undefined && input.wranglerOauth !== "") {
    return { error: "Cloudflare wrangler connects via its sign-in button, not a pasted value" };
  }
  return {
    value: {
      llmKeys,
      ...(cloudflareToken !== undefined ? { cloudflareToken } : {}),
      ...(input.wranglerOauth !== undefined ? { wranglerOauth: "" as const } : {}),
    },
  };
}
