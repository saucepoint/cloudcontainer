import { EnterIcon, GitHubLogoIcon, LockClosedIcon } from "@radix-ui/react-icons";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { authClient } from "./auth-client.js";
import { errorMessage, requestJson } from "./http.js";
import { GoogleIcon } from "./icons.js";
import {
  LANDING_TERMINAL_PROMPT,
  terminalFrameAt,
  type TerminalFrame,
  type TerminalRow,
} from "./landing-terminal-model.js";

type SocialProvider = "google" | "github";

function TerminalPrompt({ row }: { row: Extract<TerminalRow, { type: "prompt" }> }): React.JSX.Element {
  return (
    <div className="terminal-line">
      <span className="terminal-prompt-label">{row.label}</span>{" "}
      <span className="terminal-command">{row.command}</span>
      {row.cursor ? <span className="terminal-cursor" aria-hidden="true">▌</span> : null}
    </div>
  );
}

function ShellScreen({ frame }: { frame: Extract<TerminalFrame, { mode: "shell" }> }): React.JSX.Element {
  return (
    <div className="terminal-shell-screen" key="shell">
      {frame.rows.map((row, index) => row.type === "prompt"
        ? <TerminalPrompt key={`${row.label}-${index}`} row={row} />
        : <div className={`terminal-line terminal-output ${row.tone}`} key={`${row.text}-${index}`}>{row.text}</div>)}
    </div>
  );
}

function CodexScreen({ frame }: { frame: Extract<TerminalFrame, { mode: "codex" }> }): React.JSX.Element {
  return (
    <div className="terminal-codex-screen" key="codex">
      {frame.submitted ? (
        <div className="terminal-codex-conversation">
          <div className="terminal-codex-user-prompt">
            <span className="terminal-codex-chevron" aria-hidden="true">›</span>
            <span>{frame.prompt}</span>
          </div>
          <div className="terminal-codex-working">
            <span className="terminal-codex-working-dot" aria-hidden="true">•</span>
            <strong>Working</strong>
            <span>({frame.workingSeconds}s • esc to interrupt)</span>
          </div>
          {frame.resultLines.map((line) => <div className="terminal-codex-result" key={line}>{line}</div>)}
        </div>
      ) : (
        <>
          <div className="terminal-codex-card">
            <div className="terminal-codex-card-heading">
              <span className="terminal-codex-glyph">&gt;_</span>
              <strong>OpenAI Codex</strong>
              <span className="terminal-codex-version">(v0.146.0)</span>
            </div>
            <div className="terminal-codex-card-spacer" aria-hidden="true" />
            <div className="terminal-codex-card-row">
              <span>model:</span>
              <strong>gpt-5.6-luna xhigh</strong>
              <span className="terminal-codex-card-help">/model to change</span>
            </div>
            <div className="terminal-codex-card-row">
              <span>directory:</span>
              <span className="terminal-codex-directory">{frame.path}</span>
            </div>
          </div>
          <div className="terminal-codex-tip">
            <strong>Tip:</strong> Start a fresh idea with /new; the previous session stays in history.
          </div>
          <div className="terminal-codex-input">
            <span className="terminal-codex-chevron" aria-hidden="true">›</span>
            {frame.prompt ? (
              <span>{frame.prompt}</span>
            ) : (
              <span className="terminal-placeholder">Improve documentation in @filename</span>
            )}
            <span className="terminal-cursor" aria-hidden="true">▌</span>
          </div>
        </>
      )}
      <div className="terminal-codex-footer">
        <span>gpt-5.6-luna xhigh · {frame.path}</span>
      </div>
    </div>
  );
}

function TerminalDemo(): React.JSX.Element {
  const reducedMotion = useReducedMotion() === true;
  const terminalRef = React.useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = React.useState(0);
  const [visible, setVisible] = React.useState(true);

  React.useEffect(() => {
    const node = terminalRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry?.isIntersecting ?? true);
    }, { threshold: 0.1 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (reducedMotion || !visible) return;
    const startedAt = performance.now();
    let animationFrame = 0;
    const tick = (now: number) => {
      setElapsed(now - startedAt);
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [reducedMotion, visible]);

  const frame = terminalFrameAt(elapsed, reducedMotion);
  return (
    <div ref={terminalRef} className="landing-terminal-stage">
      <motion.div
        className="landing-terminal-window"
        role="img"
        aria-label="Animated terminal demo: SSH into workbench, open a project repository, launch Codex, and type a prompt."
        initial={reducedMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="terminal-titlebar">
          <span className="terminal-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="terminal-title">ssh workbench</span>
          <span className="terminal-title-status">{frame.mode === "shell" ? "bash" : "codex"}</span>
        </div>
        <div className="terminal-screen" aria-hidden="true">
          <motion.div
            key={frame.mode}
            initial={reducedMotion ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {frame.mode === "shell" ? <ShellScreen frame={frame} /> : <CodexScreen frame={frame} />}
          </motion.div>
        </div>
      </motion.div>
      <p className="sr-only">{LANDING_TERMINAL_PROMPT}</p>
    </div>
  );
}

function LandingAuth(): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [status, setStatus] = React.useState("");

  const socialSignIn = async (provider: SocialProvider): Promise<void> => {
    setPending(true);
    setStatus("Opening sign-in…");
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: "/account/continue",
      });
      if (result.error) throw new Error(result.error.message);
    } catch (error) {
      setStatus(errorMessage(error, "Sign-in could not be started."));
      setPending(false);
    }
  };

  const createPasskey = async (): Promise<void> => {
    setPending(true);
    setStatus("Preparing a new passkey…");
    try {
      const { context } = await requestJson<{ context: string }>("/account/passkey/context");
      const result = await authClient.passkey.addPasskey({ name: "Primary passkey", context });
      if (result.error) throw new Error(result.error.message);
      window.location.assign("/account/continue");
    } catch (error) {
      setStatus(errorMessage(error, "The passkey could not be created."));
      setPending(false);
    }
  };

  const usePasskey = async (): Promise<void> => {
    setPending(true);
    setStatus("Waiting for your passkey…");
    try {
      const result = await authClient.signIn.passkey({ autoFill: false });
      if (result.error) throw new Error(result.error.message);
      window.location.assign("/account/continue");
    } catch (error) {
      setStatus(errorMessage(error, "Passkey sign-in failed."));
      setPending(false);
    }
  };

  return (
    <div className="auth-provider-list">
      <button
        className="btn auth-provider"
        type="button"
        disabled={pending}
        onClick={() => void socialSignIn("google")}
      >
        <GoogleIcon />Sign in with Google
      </button>
      <button
        className="btn auth-provider"
        type="button"
        disabled={pending}
        onClick={() => void socialSignIn("github")}
      >
        <GitHubLogoIcon aria-hidden="true" />Sign in with GitHub
      </button>
      <div className="auth-divider"><span>passkeys</span></div>
      <button
        className="btn auth-provider"
        type="button"
        disabled={pending}
        onClick={() => void createPasskey()}
      >
        <LockClosedIcon aria-hidden="true" />Create passkey
      </button>
      <button
        className="btn auth-provider"
        type="button"
        disabled={pending}
        onClick={() => void usePasskey()}
      >
        <EnterIcon aria-hidden="true" />Use passkey
      </button>
      <p className="muted auth-status" role="status" aria-live="polite">{status}</p>
    </div>
  );
}

const root = document.getElementById("landing-auth-root");
if (root) createRoot(root).render(<LandingAuth />);

const terminalRoot = document.getElementById("landing-terminal-root");
if (terminalRoot) createRoot(terminalRoot).render(<TerminalDemo />);
