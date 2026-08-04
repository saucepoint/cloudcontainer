export const LANDING_TERMINAL_PROMPT =
  "Add a little mischievous raccoon to the web app; animate it as if it were stealing components from the app.";
export const LANDING_TERMINAL_CYCLE_MS = 18_000;

const SSH_COMMAND = "ssh workbench";
const REPO_COMMAND = "cd ~/repos/lantern";
const CODEX_COMMAND = "codex";
const PROMPT_CHAR_MS = 28;
const SSH_COMMAND_START_MS = 420;
const SSH_OUTPUT_START_MS = 1_020;
const BASH_PROMPT_START_MS = 2_050;
const REPO_COMMAND_START_MS = 2_650;
const REPO_PROMPT_START_MS = 3_450;
const CODEX_COMMAND_START_MS = 3_850;
const CODEX_LOADING_START_MS = 4_360;
const CODEX_START_MS = 5_050;
const PROMPT_START_MS = 5_450;
const PROMPT_SUBMIT_DELAY_MS = 650;
const PROMPT_COMPLETE_MS = PROMPT_START_MS + LANDING_TERMINAL_PROMPT.length * PROMPT_CHAR_MS;
const SUBMIT_START_MS = PROMPT_COMPLETE_MS + PROMPT_SUBMIT_DELAY_MS;
const RESULTS_START_MS = SUBMIT_START_MS + 2_400;
const RESULT_LINE_DELAY_MS = 520;
const RESET_START_MS = 16_500;
const CODEX_RESULT_LINES = [
  "Found the app entrypoint",
  "Mapped reusable UI components",
  "Planning a tiny raccoon component heist",
];

export type TerminalTone = "default" | "dim" | "green" | "yellow";

export type TerminalRow =
  | {
    type: "prompt";
    label: string;
    command: string;
    cursor: boolean;
  }
  | {
    type: "output";
    text: string;
    tone: TerminalTone;
  };

export type TerminalFrame =
  | {
    mode: "shell";
    rows: TerminalRow[];
  }
  | {
    mode: "codex";
    path: string;
    prompt: string;
    promptComplete: boolean;
    submitted: boolean;
    working: boolean;
    workingSeconds: number;
    resultLines: string[];
  };

function cycleTime(elapsedMs: number): number {
  const normalized = elapsedMs % LANDING_TERMINAL_CYCLE_MS;
  return normalized < 0 ? normalized + LANDING_TERMINAL_CYCLE_MS : normalized;
}

function typedText(text: string, startMs: number, elapsedMs: number): string {
  if (elapsedMs < startMs) return "";
  const characterCount = Math.min(
    text.length,
    Math.floor((elapsedMs - startMs) / PROMPT_CHAR_MS) + 1,
  );
  return text.slice(0, characterCount);
}

function localShellRow(command: string, cursor: boolean): TerminalRow {
  return { type: "prompt", label: "you@laptop:~$", command, cursor };
}

function remoteShellRow(path: string, command: string, cursor: boolean): TerminalRow {
  return { type: "prompt", label: `dev@workbench:${path}$`, command, cursor };
}

function initialShellFrame(elapsedMs: number): TerminalFrame {
  const time = cycleTime(elapsedMs);
  return {
    mode: "shell",
    rows: [localShellRow(
      typedText(SSH_COMMAND, SSH_COMMAND_START_MS, time),
      time < SSH_OUTPUT_START_MS,
    )],
  };
}

export function terminalFrameAt(elapsedMs: number, reducedMotion = false): TerminalFrame {
  if (reducedMotion) {
    return {
      mode: "codex",
      path: "~/repos/lantern",
      prompt: LANDING_TERMINAL_PROMPT,
      promptComplete: true,
      submitted: true,
      working: true,
      workingSeconds: 4,
      resultLines: CODEX_RESULT_LINES,
    };
  }

  const time = cycleTime(elapsedMs);
  if (time >= RESET_START_MS) return initialShellFrame(time - RESET_START_MS);

  const rows: TerminalRow[] = [localShellRow(
    SSH_COMMAND,
    time < SSH_OUTPUT_START_MS,
  )];
  if (time < SSH_OUTPUT_START_MS) {
    rows[0] = localShellRow(
      typedText(SSH_COMMAND, SSH_COMMAND_START_MS, time),
      true,
    );
    return { mode: "shell", rows };
  }

  rows.push({ type: "output", text: "Connecting to workbench...", tone: "yellow" });
  if (time < BASH_PROMPT_START_MS) {
    return { mode: "shell", rows };
  }

  rows.push(
    { type: "output", text: "Welcome to Debian GNU/Linux 13 (trixie)", tone: "default" },
    { type: "output", text: "bash 5.2.37 · x86_64", tone: "dim" },
  );
  if (time < REPO_COMMAND_START_MS) {
    rows.push(remoteShellRow("~", "", true));
    return { mode: "shell", rows };
  }

  if (time < REPO_PROMPT_START_MS) {
    rows.push(remoteShellRow(
      "~",
      typedText(REPO_COMMAND, REPO_COMMAND_START_MS, time),
      true,
    ));
    return { mode: "shell", rows };
  }

  rows.push(
    remoteShellRow("~", REPO_COMMAND, false),
    remoteShellRow("~/repos/lantern", "", true),
  );
  if (time < CODEX_COMMAND_START_MS) {
    return { mode: "shell", rows };
  }

  rows[rows.length - 1] = remoteShellRow(
    "~/repos/lantern",
    typedText(CODEX_COMMAND, CODEX_COMMAND_START_MS, time),
    true,
  );
  if (time < CODEX_LOADING_START_MS) {
    return { mode: "shell", rows };
  }

  rows.push({ type: "output", text: "Loading Codex...", tone: "green" });
  if (time < CODEX_START_MS) {
    return { mode: "shell", rows };
  }

  if (time < PROMPT_START_MS) {
    return {
      mode: "codex",
      path: "~/repos/lantern",
      prompt: "",
      promptComplete: false,
      submitted: false,
      working: false,
      workingSeconds: 0,
      resultLines: [],
    };
  }

  const prompt = typedText(LANDING_TERMINAL_PROMPT, PROMPT_START_MS, time);
  if (time < SUBMIT_START_MS) {
    return {
      mode: "codex",
      path: "~/repos/lantern",
      prompt,
      promptComplete: prompt.length === LANDING_TERMINAL_PROMPT.length,
      submitted: false,
      working: false,
      workingSeconds: 0,
      resultLines: [],
    };
  }

  const resultElapsedMs = time - RESULTS_START_MS;
  const resultCount = resultElapsedMs < 0
    ? 0
    : Math.min(CODEX_RESULT_LINES.length, Math.floor(resultElapsedMs / RESULT_LINE_DELAY_MS) + 1);
  return {
    mode: "codex",
    path: "~/repos/lantern",
    prompt,
    promptComplete: true,
    submitted: true,
    working: true,
    workingSeconds: Math.max(1, Math.floor((time - SUBMIT_START_MS) / 1_000) + 1),
    resultLines: CODEX_RESULT_LINES.slice(0, resultCount),
  };
}
