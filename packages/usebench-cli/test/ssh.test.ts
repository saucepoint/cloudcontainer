import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  accessMock,
  chmodMock,
  execFileMock,
  mkdirMock,
  readFileMock,
  renameMock,
  selectMock,
  writeFileMock,
} = vi.hoisted(() => ({
  accessMock: vi.fn(),
  chmodMock: vi.fn(),
  execFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  renameMock: vi.fn(),
  selectMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:fs/promises", () => ({
  access: accessMock,
  chmod: chmodMock,
  mkdir: mkdirMock,
  readFile: readFileMock,
  rename: renameMock,
  writeFile: writeFileMock,
}));
vi.mock("node:os", () => ({ homedir: () => "/home/test" }));
vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
  select: selectMock,
}));

import { chooseSshKey, renderSshConfigBlock } from "../src/ssh.js";

describe("SSH setup helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accessMock.mockRejectedValue(new Error("missing"));
    readFileMock.mockRejectedValue(new Error("missing"));
    mkdirMock.mockResolvedValue(undefined);
  });

  it("recognizes the dedicated managed block format", () => {
    const block = renderSshConfigBlock("host.example", 30500, "/home/dev/.ssh/id_ed25519");
    expect(block).toContain("# >>> usebench managed >>>");
    expect(block).toContain("Host workbench");
    expect(block).toContain("Port 30500");
    expect(block).toContain("IdentityFile /home/dev/.ssh/id_ed25519");
  });

  it("refuses to overwrite an existing dedicated private key", async () => {
    const privatePath = "/home/test/.ssh/workbench_id_ed25519";
    accessMock.mockImplementation(async (path: string) => {
      if (path === privatePath) return undefined;
      throw new Error("missing");
    });
    selectMock.mockResolvedValue("dedicated");

    await expect(chooseSshKey()).rejects.toThrow("Refusing to overwrite an existing SSH key");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reuses a complete existing dedicated keypair without generating it", async () => {
    const privatePath = "/home/test/.ssh/workbench_id_ed25519";
    const publicPath = `${privatePath}.pub`;
    const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest usebench";
    accessMock.mockImplementation(async (path: string) => {
      if (path === privatePath || path === publicPath) return undefined;
      throw new Error("missing");
    });
    readFileMock.mockImplementation(async (path: string) => {
      if (path === publicPath) return publicKey;
      throw new Error("missing");
    });
    selectMock.mockResolvedValue("dedicated");

    await expect(chooseSshKey()).resolves.toEqual({ publicKey, privatePath });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
