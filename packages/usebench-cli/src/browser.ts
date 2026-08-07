import { spawn } from "node:child_process";

/** Open the platform's default browser, while leaving a copyable URL in the terminal. */
export function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // `spawn` reports a missing opener asynchronously. Without an error
    // listener Node treats that event as an uncaught exception and terminates
    // the TUI, even though the URL is already printed for manual use.
    child.once("error", () => undefined);
    child.unref();
  } catch {
    // The caller always prints the URL, so a missing desktop opener is recoverable.
  }
}
