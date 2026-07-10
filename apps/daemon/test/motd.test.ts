import { describe, expect, it } from "vitest";
import { renderMotd } from "../src/motd.js";

const base = {
  agents: ["claude" as const],
  credentials: {},
  sshKeyCount: 0,
  dashboardUrl: "https://codestation.example",
};

describe("renderMotd (first-login checklist, §5.4)", () => {
  it("shows everything unchecked for a bare container", () => {
    const motd = renderMotd(base);
    expect(motd).toContain("[ ] model access — add an API key in the dashboard");
    expect(motd).toContain("[ ] github — connect in the dashboard");
    expect(motd).toContain("[ ] cloudflare — connect in the dashboard");
    expect(motd).toContain("[ ] ssh keys (0)");
    expect(motd).toContain("https://codestation.example");
  });

  it("distinguishes a wrangler sign-in from a pasted API token", () => {
    expect(renderMotd({ ...base, credentials: { wranglerOauth: "1" } })).toContain(
      "[x] cloudflare (wrangler signed in)",
    );
    expect(renderMotd({ ...base, credentials: { cloudflareToken: "1" } })).toContain(
      "[x] cloudflare (token installed)",
    );
  });

  it("checks each line once its credential is connected", () => {
    const motd = renderMotd({
      ...base,
      credentials: {
        llmKeys: { anthropic: "1", openai: "1" },
        githubToken: "1",
        githubLogin: "octocat",
        cloudflareToken: "1",
      },
      sshKeyCount: 2,
    });
    expect(motd).toContain("[x] model access (anthropic, openai)");
    expect(motd).toContain("[x] github (octocat)");
    expect(motd).toContain("[x] cloudflare (token installed)");
    expect(motd).toContain("[x] ssh keys (2)");
  });

  it("labels agents with their run command", () => {
    const motd = renderMotd({ ...base, agents: ["claude", "opencode"] });
    expect(motd).toContain("Claude Code (run: claude)");
    expect(motd).toContain("OpenCode (run: opencode)");
  });

  it("says so when no agent is detected", () => {
    expect(renderMotd({ ...base, agents: [] })).toContain("(none detected)");
  });

  it("never leaks credential values, only presence", () => {
    const motd = renderMotd({
      ...base,
      credentials: {
        llmKeys: { anthropic: "CANARY-secret-key" },
        cloudflareToken: "CANARY-cf",
        wranglerOauth: "CANARY-wrangler",
        githubToken: "CANARY-gh",
      },
    });
    expect(motd).not.toContain("CANARY");
  });
});
