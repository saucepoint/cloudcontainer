import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  checkboxMock,
  chooseSshKeyMock,
  confirmMock,
  maybeConfigureSshShortcutMock,
  selectMock,
} = vi.hoisted(() => ({
  checkboxMock: vi.fn(),
  chooseSshKeyMock: vi.fn(),
  confirmMock: vi.fn(),
  maybeConfigureSshShortcutMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  checkbox: checkboxMock,
  confirm: confirmMock,
  input: vi.fn(),
  password: vi.fn(),
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
  const selectAnswers: unknown[] = ["skip", "skip", "create"];
  const checkboxAnswers = [["codex"], [], []];
  selectMock.mockImplementation(async () => selectAnswers.shift());
  checkboxMock.mockImplementation(async () => checkboxAnswers.shift() ?? []);
  confirmMock.mockResolvedValue(false);
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
    expect(selectMock.mock.calls.map(([config]) => config.message)).toEqual([
      "Cloudflare access",
      "Convex access",
      "Create this workbench?",
    ]);
    expect(selectMock.mock.calls.every(([config]) => config.message !== "Setup wizard")).toBe(true);
  });

  it("moves to the previous section when a section returns Back", async () => {
    const selectAnswers: unknown[] = [BACK, "skip", "skip", "create"];
    const checkboxAnswers = [["pi"], [], [], []];
    selectMock.mockImplementation(async () => selectAnswers.shift());
    checkboxMock.mockImplementation(async () => checkboxAnswers.shift() ?? []);
    confirmMock.mockResolvedValue(false);
    chooseSshKeyMock.mockResolvedValue({ publicKey: undefined, privatePath: undefined });
    maybeConfigureSshShortcutMock.mockResolvedValue({ configured: false, conflict: false, path: "/tmp/config" });

    const api = makeApi();
    const result = await runOnboarding(api, state);

    expect(result).toMatchObject({ status: "ready", agents: ["pi"] });
    expect(selectMock.mock.calls.map(([config]) => config.message)).toEqual([
      "Cloudflare access",
      "Cloudflare access",
      "Convex access",
      "Create this workbench?",
    ]);
  });
});
