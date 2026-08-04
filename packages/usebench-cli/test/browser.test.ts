import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { openBrowser } from "../src/browser.js";

describe("browser opener", () => {
  it("swallows an asynchronous missing-opener error", () => {
    const child = new EventEmitter() as ChildProcess;
    const unref = vi.fn();
    child.unref = unref;
    spawnMock.mockReturnValueOnce(child);

    expect(() => openBrowser("https://usebench.dev/cli/auth")).not.toThrow();
    expect(unref).toHaveBeenCalledOnce();
    expect(() => child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }))).not.toThrow();
  });
});
