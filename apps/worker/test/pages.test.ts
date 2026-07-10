/**
 * Render smoke tests for the server-rendered pages: the inline <script>
 * payloads are plain strings that tsc never sees, so parse each one with the
 * Function constructor to catch syntax errors at test time.
 */
import { describe, expect, it } from "vitest";
import { DashboardPage } from "../src/pages/dashboard.js";
import { LandingPage, OnboardingPage } from "../src/pages/views.js";

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.trim());
}

const pages: Array<[string, () => unknown]> = [
  ["landing", () => LandingPage({ devAuth: false, worldIdEnvironment: "production" })],
  ["onboarding", () => OnboardingPage({})],
  ["dashboard", () => DashboardPage({})],
];

describe("inline page JS parses", () => {
  for (const [name, render] of pages) {
    it(name, () => {
      const html = String(render());
      const scripts = scriptsOf(html);
      expect(scripts.length).toBeGreaterThan(0);
      for (const s of scripts) {
        expect(() => new Function(s)).not.toThrow();
      }
    });
  }
});

describe("ChatGPT sign-in wiring", () => {
  it("onboarding shows the sign-in button and keeps auth.json behind Advanced options", () => {
    const html = String(OnboardingPage({}));
    expect(html).toContain("Sign in with ChatGPT");
    expect(html).toContain("codexDeviceFlow");
    const advanced = html.slice(html.indexOf("<summary>Advanced options</summary>"));
    expect(advanced).toContain('name="llm_codex_subscription_token"');
  });

  it("dashboard has the codex row and no codex option in the provider dropdown", () => {
    const html = String(DashboardPage({}));
    expect(html).toContain("Sign in with ChatGPT");
    expect(html).toContain("codexDeviceFlow");
    expect(html).not.toContain('<option value="codex_subscription_token">');
  });
});
