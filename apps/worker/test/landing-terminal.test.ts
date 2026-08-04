import { describe, expect, it } from "vitest";
import {
  LANDING_TERMINAL_CYCLE_MS,
  LANDING_TERMINAL_PROMPT,
  terminalFrameAt,
} from "../client/landing-terminal-model.js";

function shellRowsAt(elapsedMs: number): string[] {
  const frame = terminalFrameAt(elapsedMs);
  if (frame.mode !== "shell") throw new Error("expected a shell frame");
  return frame.rows.map((row) => row.type === "prompt"
    ? `${row.label} ${row.command}`
    : row.text);
}

describe("landing terminal timeline", () => {
  it("types the SSH command before showing the remote Bash session", () => {
    expect(shellRowsAt(0)).toEqual(["you@laptop:~$ "]);
    expect(shellRowsAt(700)[0]).toContain("ssh ");
    expect(shellRowsAt(1_100)).toContain("Connecting to workbench...");
    expect(shellRowsAt(2_200)).toContain("Welcome to Debian GNU/Linux 13 (trixie)");
    expect(shellRowsAt(2_200)).toContain("dev@workbench:~$ ");
  });

  it("navigates to the repo and launches Codex from the remote shell", () => {
    expect(shellRowsAt(3_300).some((row) => row.includes("cd ~/repos/lantern"))).toBe(true);
    expect(shellRowsAt(3_600)).toContain("dev@workbench:~/repos/lantern$ ");
    expect(shellRowsAt(4_200)).toContain("dev@workbench:~/repos/lantern$ codex");
    expect(shellRowsAt(4_500)).toContain("Loading Codex...");
  });

  it("types the complete silly prompt in the Codex screen", () => {
    const typing = terminalFrameAt(6_000);
    expect(typing.mode).toBe("codex");
    if (typing.mode === "codex") {
      expect(typing.prompt).toBe(LANDING_TERMINAL_PROMPT.slice(0, typing.prompt.length));
      expect(typing.promptComplete).toBe(false);
    }

    const complete = terminalFrameAt(12_000);
    expect(complete).toMatchObject({
      mode: "codex",
      path: "~/repos/lantern",
      prompt: LANDING_TERMINAL_PROMPT,
      promptComplete: true,
    });
  });

  it("submits the prompt, shows Working, and streams initial results", () => {
    const working = terminalFrameAt(9_300);
    expect(working).toMatchObject({
      mode: "codex",
      prompt: LANDING_TERMINAL_PROMPT,
      promptComplete: true,
      submitted: true,
      working: true,
      resultLines: [],
    });

    const results = terminalFrameAt(12_500);
    expect(results).toMatchObject({
      mode: "codex",
      submitted: true,
      working: true,
      resultLines: [
        "Found the app entrypoint",
        "Mapped reusable UI components",
      ],
    });
  });

  it("shows the finished frame for reduced-motion users and resets the loop", () => {
    expect(terminalFrameAt(0, true)).toMatchObject({
      mode: "codex",
      prompt: LANDING_TERMINAL_PROMPT,
      promptComplete: true,
      submitted: true,
      working: true,
      resultLines: [
        "Found the app entrypoint",
        "Mapped reusable UI components",
        "Planning a tiny raccoon component heist",
      ],
    });
    expect(terminalFrameAt(LANDING_TERMINAL_CYCLE_MS).mode).toBe("shell");
    expect(terminalFrameAt(LANDING_TERMINAL_CYCLE_MS)).toEqual(terminalFrameAt(0));
  });
});
