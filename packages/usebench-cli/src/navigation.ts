interface PromptContext {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearPromptOnDone?: boolean;
  signal?: AbortSignal;
}

interface Prompt<Value, Config> {
  (config: Config, context?: PromptContext): Promise<Value>;
}

interface Keypress {
  name?: string;
  shift?: boolean;
}

/** The prompt result used to move to the previous onboarding section. */
export const BACK = Symbol("back");
export type Back = typeof BACK;

function isBackKey(key: unknown): key is Keypress {
  if (!key || typeof key !== "object") return false;
  const candidate = key as Keypress;
  return candidate.name === "left" && candidate.shift === true;
}

/**
 * Run an Inquirer prompt with a consistent section-level back shortcut.
 * Inquirer already turns terminal escape sequences into keypress events; the
 * wrapper only needs to abort the active prompt when Shift+Left is pressed.
 */
export async function promptWithBack<Value, Config>(
  prompt: Prompt<Value, Config>,
  config: Config,
  context: PromptContext = {},
): Promise<Value | Back> {
  const controller = new AbortController();
  const input = context.input ?? process.stdin;
  let backRequested = false;
  const onKeypress = (_input: string, key: unknown): void => {
    if (!isBackKey(key)) return;
    backRequested = true;
    controller.abort();
  };
  const onAbort = (): void => controller.abort(context.signal?.reason);

  input.on("keypress", onKeypress);
  if (context.signal) {
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await prompt(config, { ...context, signal: controller.signal });
  } catch (error) {
    if (backRequested) return BACK;
    throw error;
  } finally {
    input.removeListener("keypress", onKeypress);
    context.signal?.removeEventListener("abort", onAbort);
  }
}
