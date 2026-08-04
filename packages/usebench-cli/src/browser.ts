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
    child.unref();
  } catch {
    // The caller always prints the URL, so a missing desktop opener is recoverable.
  }
}
