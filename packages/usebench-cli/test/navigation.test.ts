import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { BACK, promptWithBack } from "../src/navigation.js";

describe("prompt navigation", () => {
  it("turns Shift+Left into a Back result", async () => {
    const input = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const prompt = vi.fn((_config: { message: string }, context?: { signal?: AbortSignal }) => (
      new Promise<string>((_resolve, reject) => {
        context?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    ));

    const resultPromise = promptWithBack(prompt, { message: "Choose something" }, { input });
    input.emit("keypress", "", { name: "left", shift: true, ctrl: false });

    await expect(resultPromise).resolves.toBe(BACK);
    expect(prompt).toHaveBeenCalledOnce();
  });
});
