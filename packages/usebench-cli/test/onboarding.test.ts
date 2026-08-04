import { describe, expect, it, vi } from "vitest";

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
import type { ApiClient } from "../src/http.js";

describe("onboarding navigation", () => {
  it("can change the signed-in account and go back to revise an earlier section", async () => {
    const selectAnswers = [
      "change", // account
      "next", // verification
      "next", // agents
      "back", // agent sign-ins -> agents
      "next", // agents
      "next", // agent sign-ins
      "next", // GitHub
      "skip", // Cloudflare
      "skip", // Convex
      "next", // optional tools
      "next", // SSH
      "create", // review
    ];
    const checkboxAnswers = [
      ["pi"], // initial agent selection
      [], // initial agent sign-ins
      ["codex"], // revised agent selection
      [], // revised agent sign-ins
      [], // model API keys
    ];
    selectMock.mockImplementation(async () => selectAnswers.shift());
    checkboxMock.mockImplementation(async () => checkboxAnswers.shift() ?? []);
    confirmMock.mockResolvedValue(false);
    chooseSshKeyMock.mockResolvedValue({ publicKey: undefined, privatePath: undefined });
    maybeConfigureSshShortcutMock.mockResolvedValue({ configured: false, conflict: false, path: "/tmp/config" });

    const api = {
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
    const changeAccount = vi.fn(async () => ({
      verified: true,
      worldIdAvailable: false,
      githubAvailable: false,
      hasWorkbench: false,
      redirect: "/onboarding" as const,
    }));

    const result = await runOnboarding(api, {
      verified: true,
      worldIdAvailable: false,
      githubAvailable: false,
      hasWorkbench: false,
      redirect: "/onboarding",
    }, changeAccount);

    expect(changeAccount).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "ready", agents: ["codex"] });
    expect(api.post).toHaveBeenCalledWith("/api/provision", expect.objectContaining({ agents: ["codex"] }));
    expect(selectMock.mock.calls[0]?.[0]).toMatchObject({
      message: "usebench account",
      choices: expect.arrayContaining([
        expect.objectContaining({ value: "change" }),
      ]),
    });
    expect(selectMock.mock.calls[3]?.[0]?.choices).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "← Back", value: "back" }),
    ]));
  });
});
