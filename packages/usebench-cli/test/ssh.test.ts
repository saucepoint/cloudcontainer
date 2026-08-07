import { describe, expect, it } from "vitest";
import { renderSshConfigBlock } from "../src/ssh.js";

describe("SSH setup helpers", () => {
  it("recognizes the dedicated managed block format", () => {
    const block = renderSshConfigBlock("host.example", 30500, "/home/dev/.ssh/id_ed25519");
    expect(block).toContain("# >>> usebench managed >>>");
    expect(block).toContain("Host workbench");
    expect(block).toContain("Port 30500");
    expect(block).toContain("IdentityFile /home/dev/.ssh/id_ed25519");
  });
});
