import { Cli, z } from "incur";
import { clearSession, loadOrAuthenticate, reauthenticate } from "./session.js";
import { formatFailure, runOnboarding } from "./onboarding.js";

const cli = Cli.create("usebench", {
  version: "0.1.0",
  description: "Onboard onto usebench.dev from a keyboard-driven terminal wizard.",
  options: z.object({
    baseUrl: z.string().url().default(process.env.USEBENCH_BASE_URL ?? "https://usebench.dev").describe("usebench deployment URL"),
    clearSession: z.boolean().default(false).describe("clear the locally cached sign-in session and exit"),
  }),
  async run({ options, agent }) {
    if (options.clearSession) {
      await clearSession();
      console.log("Cleared the locally cached usebench session.");
      return { status: "session_cleared" };
    }
    if (agent || !process.stdin.isTTY || !process.stdout.isTTY) {
      return {
        status: "interactive_required",
        message: "usebench onboarding requires an interactive TTY; rerun npx usebench in a terminal.",
      };
    }
    try {
      const { api, state } = await loadOrAuthenticate(options.baseUrl, false);
      return await runOnboarding(api, state, () => reauthenticate(api));
    } catch (error) {
      throw new Error(formatFailure(error));
    }
  },
});

cli.serve();

export default cli;
