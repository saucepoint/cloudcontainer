import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Checkbox } from "@base-ui/react/checkbox";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { animate } from "motion/mini";
import * as React from "react";
import { createRoot } from "react-dom/client";

type Confirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
};

declare global {
  interface Window {
    requestConfirmation?: (confirmation: Confirmation) => void;
  }
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function reveal(elements: Element | Element[] | NodeListOf<Element>): void {
  if (reducedMotion.matches) return;
  const targets = elements instanceof Element ? [elements] : Array.from(elements);
  if (targets.length === 0) return;
  animate(
    targets,
    { opacity: [0, 1], transform: ["translateY(6px)", "translateY(0)"] },
    {
      duration: 0.28,
      delay: targets.length > 1 ? (index) => index * 0.035 : 0,
      ease: [0.22, 1, 0.36, 1],
    },
  );
}

const AGENTS = [
  { id: "pi", label: "Pi", hint: "A lightweight coding agent.", recommend: false },
  { id: "claude", label: "Claude Code", hint: "Anthropic's coding agent.", recommend: false },
  { id: "codex", label: "Codex", hint: "OpenAI's coding agent.", recommend: true },
  { id: "opencode", label: "OpenCode", hint: "An open model-agnostic agent.", recommend: false },
] as const;

function AgentSubscriptionSignin({
  id,
  button,
  connected,
}: {
  id: "claude" | "codex";
  button: string;
  connected: string;
}): React.JSX.Element {
  return (
    <>
      <div className="agent-signin">
        <button type="button" id={`${id}-signin`} className="btn secondary">
          {button}
        </button>
        <span id={`${id}-connected`} className="ok" style={{ display: "none" }} role="status" aria-live="polite">
          ✓ {connected}
        </span>
      </div>
      <div id={`${id}-flow`} role="status" aria-live="polite" />
    </>
  );
}

function savedAgentSelection(): string[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem("codestation-github-agents") || "[]");
    return Array.isArray(saved) ? saved.filter((agent): agent is string => typeof agent === "string") : [];
  } catch {
    return [];
  }
}

function AgentSelector(): React.JSX.Element {
  return (
    <CheckboxGroup
      aria-labelledby="agents-legend"
      defaultValue={savedAgentSelection()}
      className="agents"
    >
      {AGENTS.map((agent) => (
        <div className="agent" key={agent.id}>
          <label className="agent-choice">
            <Checkbox.Root name="agent" value={agent.id} className="agent-checkbox">
              <Checkbox.Indicator className="agent-checkbox-indicator">✓</Checkbox.Indicator>
            </Checkbox.Root>
            <span className="agent-copy">
              <span className="agent-title">
                {agent.label}
                {agent.recommend ? <span className="recommend">common choice</span> : null}
              </span>
              <small>{agent.hint}</small>
            </span>
          </label>
          {agent.id === "claude" ? (
            <AgentSubscriptionSignin id="claude" button="Sign in with Claude" connected="Claude connected" />
          ) : null}
          {agent.id === "codex" ? (
            <AgentSubscriptionSignin id="codex" button="Sign in with ChatGPT" connected="ChatGPT connected" />
          ) : null}
        </div>
      ))}
    </CheckboxGroup>
  );
}

function ConfirmationDialog(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState<Confirmation>({
    title: "Confirm action",
    description: "This action cannot be undone.",
    confirmLabel: "Continue",
    onConfirm: () => undefined,
  });

  React.useEffect(() => {
    window.requestConfirmation = (nextConfirmation) => {
      setConfirmation(nextConfirmation);
      setOpen(true);
    };
    return () => {
      delete window.requestConfirmation;
    };
  }, []);

  const confirm = () => {
    setOpen(false);
    confirmation.onConfirm();
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="dialog-backdrop" />
        <AlertDialog.Viewport className="dialog-viewport">
          <AlertDialog.Popup className="dialog-popup">
            <AlertDialog.Title className="dialog-title">{confirmation.title}</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              {confirmation.description}
            </AlertDialog.Description>
            <div className="dialog-actions">
              <AlertDialog.Close className="btn secondary">Cancel</AlertDialog.Close>
              <AlertDialog.Close className="btn" onClick={confirm}>
                {confirmation.confirmLabel}
              </AlertDialog.Close>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

const root = document.getElementById("ui-root");
if (root) createRoot(root).render(<ConfirmationDialog />);

const agentRoot = document.getElementById("agent-selector");
if (agentRoot) createRoot(agentRoot).render(<AgentSelector />);

reveal(document.querySelectorAll("main > h1, main > .lead, main > .card, main > form > .card"));
