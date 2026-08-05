import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  checkboxMock,
  chooseSshKeyMock,
  confirmMock,
  maybeConfigureSshShortcutMock,
  passwordMock,
  selectMock,
} = vi.hoisted(() => ({
  checkboxMock: vi.fn(),
  chooseSshKeyMock: vi.fn(),
  confirmMock: vi.fn(),
  maybeConfigureSshShortcutMock: vi.fn(),
  passwordMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  checkbox: checkboxMock,
  confirm: confirmMock,
  input: vi.fn(),
  password: passwordMock,
  select: selectMock,
}));
vi.mock("../src/ssh.js", () => ({
  chooseSshKey: chooseSshKeyMock,
  maybeConfigureSshShortcut: maybeConfigureSshShortcutMock,
}));
vi.mock("../src/world-id.js", () => ({ verifyWithWorldId: vi.fn() }));

import { runOnboarding } from "../src/onboarding.js";
import { BACK } from "../src/navigation.js";
import type { ApiClient } from "../src/http.js";

function makeApi(): ApiClient {
  return {
    baseUrl: "https://usebench.dev",
    get: vi.fn(async () => ({
      container: {
        status: "running",
        statusDetail: null,
        sshCommand: null,
        hostKeyFingerprints: [],
      },
    })),
    post: vi.fn(async () => ({})),
  } as unknown as ApiClient;
}

function configureSimpleFlow(): void {
  const selectAnswers: unknown[] = ["create"];
  const checkboxAnswers = [["codex"], [], [], []];
  selectMock.mockImplementation(async () => selectAnswers.shift());
  checkboxMock.mockImplementation(async () => checkboxAnswers.shift() ?? []);
  confirmMock.mockResolvedValue(false);
  passwordMock.mockResolvedValue("");
  chooseSshKeyMock.mockResolvedValue({ publicKey: undefined, privatePath: undefined });
  maybeConfigureSshShortcutMock.mockResolvedValue({ configured: false, conflict: false, path: "/tmp/config" });
}

const state = {
  verified: true,
  worldIdAvailable: false,
  githubAvailable: false,
  hasWorkbench: false,
  redirect: "/onboarding" as const,
};

describe("onboarding navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advances directly without continue screens", async () => {
    configureSimpleFlow();
    const api = makeApi();

    const result = await runOnboarding(api, state);

    expect(result).toMatchObject({ status: "ready", agents: ["codex"] });
    expect(api.post).toHaveBeenCalledWith("/api/provision", expect.objectContaining({ agents: ["codex"] }));
    expect(checkboxMock.mock.calls.map(([config]) => config.message)).toContain("Optional integrations");
    expect(checkboxMock.mock.calls.find(([config]) => config.message === "Optional integrations")?.[0]).toMatchObject({
      choices: [
        expect.objectContaining({ name: "Cloudflare", value: "cloudflare" }),
        expect.objectContaining({ name: "Supabase", value: "supabase" }),
        expect.objectContaining({ name: "Convex", value: "convex" }),
      ],
    });
    expect(selectMock.mock.calls.map(([config]) => config.message)).toEqual(["Create this workbench?"]);
    expect(selectMock.mock.calls.every(([config]) => config.message !== "Setup wizard")).toBe(true);
  });

  it("moves to the previous section when a section returns Back", async () => {
    const selectAnswers: unknown[] = ["create"];
    const checkboxAnswers = [["pi"], [], [], BACK, []];
    selectMock.mockImplementation(async () => selectAnswers.shift());
    checkboxMock.mockImplementation(async () => checkboxAnswers.shift() ?? []);
    confirmMock.mockResolvedValue(false);
    passwordMock.mockResolvedValue("");
    chooseSshKeyMock.mockResolvedValue({ publicKey: undefined, privatePath: undefined });
    maybeConfigureSshShortcutMock.mockResolvedValue({ configured: false, conflict: false, path: "/tmp/config" });

    const api = makeApi();
    const result = await runOnboarding(api, state);

    expect(result).toMatchObject({ status: "ready", agents: ["pi"] });
    expect(checkboxMock.mock.calls.filter(([config]) => config.message === "Optional integrations")).toHaveLength(2);
  });

  it("configures only the selected optional integrations", async () => {
    const selectAnswers: unknown[] = ["token", "token", "create"];
    const checkboxAnswers = [["codex"], [], [], ["cloudflare", "supabase", "convex"]];
    selectMock.mockImplementation(async () => selectAnswers.shift());
    checkboxMock.mockImplementation(async () => checkboxAnswers.shift() ?? []);
    confirmMock.mockResolvedValue(false);
    passwordMock.mockResolvedValue("integration-token");
    chooseSshKeyMock.mockResolvedValue({ publicKey: undefined, privatePath: undefined });
    maybeConfigureSshShortcutMock.mockResolvedValue({ configured: false, conflict: false, path: "/tmp/config" });

    const api = makeApi();
    await runOnboarding(api, state);

    expect(api.post).toHaveBeenCalledWith("/api/provision", expect.objectContaining({
      cloudflareToken: "integration-token",
      supabaseToken: "integration-token",
      convexToken: "integration-token",
    }));
    expect(selectMock.mock.calls.map(([config]) => config.message)).toEqual([
      "Cloudflare access",
      "Convex access",
      "Create this workbench?",
    ]);
  });
});
