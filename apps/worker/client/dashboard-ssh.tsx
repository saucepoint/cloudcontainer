import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { BusyLabel } from "./busy-label.js";
import { copyText } from "./clipboard.js";
import { askConfirmation } from "./confirmation.js";
import {
  canManageSshKeys,
  displayError,
  type ContainerView,
  type SshKey,
} from "./dashboard-model.js";
import { requestJson as api } from "./http.js";

type Enrollment = { endpoint: string; token: string };
type EnrollmentMode = "agent" | "manual";

const KEY_HELP = "ssh-keygen -t ed25519\ncat ~/.ssh/id_ed25519.pub";

export function Connection({
  container,
  hasKeys,
}: {
  container: ContainerView | null;
  hasKeys: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState("");
  if (!container) {
    return <p className="muted">Connection details appear after you create a workbench.</p>;
  }
  if (container.status === "running" && !hasKeys) {
    return <p className="notice warning"><strong>Add an SSH key to reveal your connection command.</strong> You cannot see the SSH host or port until a key has been added. Choose “Set up SSH with an agent” below for a copyable coding-agent prompt, or add a public key manually.</p>;
  }
  if (container.sshCommand) {
    const copy = async () => {
      setCopyError("");
      try {
        await copyText(container.sshCommand ?? "");
        setCopied(true);
        setTimeout(() => setCopied(false), 2_000);
      } catch {
        setCopyError("Could not copy the command. Select it and copy it manually.");
      }
    };
    return (
      <>
        <p><strong>Run this in your terminal</strong></p>
        <div className="command-row"><pre className="ssh">{container.sshCommand}</pre><button type="button" className="btn secondary" onClick={() => void copy()}>{copied ? "Copied ✓" : "Copy SSH command"}</button></div>
        {copyError ? <p className="err" role="alert">{copyError}</p> : null}
        {container.hostKeyFingerprints.length ? <details><summary>Verify this workbench on your first connection</summary><p className="muted">SSH may ask whether you trust this host. The fingerprint it shows must match one below.</p><pre className="ssh">{container.hostKeyFingerprints.join("\n")}</pre></details> : null}
      </>
    );
  }
  if (container.status === "stopped") return <p className="muted">Start the workbench to see its SSH command.</p>;
  if (container.status === "provisioning" || container.status === "waitlisted") {
    return <p className="muted">Your SSH command and SSH setup options will appear here when the workbench is ready.</p>;
  }
  return <p className="muted">SSH is not available in the current workbench state.</p>;
}

export function SshKeys({
  container,
  keys,
  refresh,
}: {
  container: ContainerView | null;
  keys: SshKey[];
  refresh: () => Promise<void>;
}) {
  const ready = canManageSshKeys(container);
  const reducedMotion = useReducedMotion();
  const [enrollmentMode, setEnrollmentMode] = React.useState<EnrollmentMode | null>(null);
  const [publicKey, setPublicKey] = React.useState("");
  const [enrollment, setEnrollment] = React.useState<Enrollment | null>(null);
  const [busy, setBusy] = React.useState("");
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState("");

  React.useEffect(() => {
    if (!ready) {
      setEnrollment(null);
      setEnrollmentMode(null);
    }
  }, [ready]);

  const withBusy = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await work();
    } catch (caught) {
      setError(displayError(caught, "That SSH key action did not complete."));
    } finally {
      setBusy("");
    }
  };

  const remove = (key: SshKey) => askConfirmation(
    "Remove SSH key?",
    "This device will lose access within a minute.",
    "Remove key",
    () => void withBusy(`remove-${key.id}`, async () => {
      await api(`/api/keys/${key.id}`, { method: "DELETE" });
      await refresh();
    }),
  );

  const save = () => void withBusy("save", async () => {
    await api("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey: publicKey }),
    });
    setPublicKey("");
    setEnrollment(null);
    setEnrollmentMode(null);
    await refresh();
  });

  const openAgentEnrollment = () => {
    setEnrollmentMode("agent");
    if (enrollment) return;
    void withBusy("mint", async () => {
      setEnrollment(await api<Enrollment>("/api/enrollment", { method: "POST" }));
    });
  };

  const openManualEnrollment = () => {
    setEnrollmentMode("manual");
  };

  const refreshEnrollment = () => void withBusy("refresh", async () => {
    await refresh();
    setEnrollment(null);
    setEnrollmentMode(null);
  });

  const prompt = enrollment ? [
    "Set up SSH access to my usebench.dev cloud workbench:",
    "",
    "1. Ensure an ed25519 SSH keypair exists at ~/.ssh/workbench_ed25519 (create it with ssh-keygen, no passphrase, if missing). Never read or transmit the private key file — only the .pub file is needed.",
    `2. Send a POST request to ${enrollment.endpoint} with header \"content-type: application/json\" and JSON body:`,
    `   {\"token\": \"${enrollment.token}\", \"pubkey\": \"<full contents of ~/.ssh/workbench_ed25519.pub>\"}`,
    "3. The JSON response includes \"sshCommand\" in the form \"ssh -p PORT dev@HOSTNAME\". Using its port and hostname, append this block to ~/.ssh/config (replace any existing \"Host workbench\" block):",
    "",
    "   Host workbench",
    "     HostName <hostname>",
    "     Port <port>",
    "     User dev",
    "     IdentityFile ~/.ssh/workbench_ed25519",
    "     IdentitiesOnly yes",
    "",
    "4. Verify the connection: ssh workbench \"echo connected\"",
    "5. Confirm to me that connecting is now just: ssh workbench",
    "",
    "The token is single-use and expires in 1 hour. If the API returns 403, stop and tell me to mint a fresh token.",
  ].join("\n") : "";

  const copy = async (name: string, value: string) => {
    try {
      await copyText(value);
      setCopied(name);
      setTimeout(() => setCopied(""), 2_000);
    } catch {
      setError("Could not copy that value. Select it and copy it manually.");
    }
  };

  return (
    <>
      {keys.length === 0 && ready ? <p className="notice warning"><strong>Add a public key to use SSH.</strong></p> : (
        <ul className="check">
          {keys.map((key) => <li key={key.id}><span style={{ fontFamily: "var(--mono)", fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "75%" }}>{key.pubkey.slice(0, 60)}…</span>{ready ? <button type="button" className="link-btn" disabled={Boolean(busy)} onClick={() => remove(key)}><BusyLabel busy={busy === `remove-${key.id}`}>Remove</BusyLabel></button> : null}</li>)}
        </ul>
      )}
      {!ready ? <p className="notice"><strong>SSH setup unlocks after the workbench is ready.</strong></p> : (
        <>
          <div className="row">
            <button
              type="button"
              className={`btn ${enrollmentMode === "agent" ? "" : "secondary"}`}
              data-active={enrollmentMode === "agent" ? "true" : undefined}
              aria-pressed={enrollmentMode === "agent"}
              disabled={Boolean(busy)}
              onClick={openAgentEnrollment}
            >
              <BusyLabel busy={busy === "mint"}>{keys.length ? "Enroll another device" : "Set up SSH with an agent"}</BusyLabel>
            </button>
            <button
              type="button"
              className={`btn ${enrollmentMode === "manual" ? "" : "secondary"}`}
              data-active={enrollmentMode === "manual" ? "true" : undefined}
              aria-pressed={enrollmentMode === "manual"}
              disabled={Boolean(busy)}
              onClick={openManualEnrollment}
            >
              {keys.length ? "Add another key manually" : "Add a key manually"}
            </button>
          </div>
          <AnimatePresence initial={false} mode="wait">
            {enrollmentMode === "agent" && enrollment ? (
              <motion.div
                key="agent-enrollment"
                initial={reducedMotion ? false : { opacity: 0, height: 0, y: 4 }}
                animate={{ opacity: 1, height: "auto", y: 0 }}
                {...(reducedMotion ? {} : { exit: { opacity: 0, height: 0, y: -4 } })}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
                style={{ overflow: "hidden" }}
              >
                <div className="notice">
                  <strong>Paste this prompt into your local coding agent</strong>
                  <p className="muted">It creates a dedicated key, registers only the public half, and configures the short command <code>ssh workbench</code>.</p>
                </div>
                <div className="row">
                  <button type="button" className="btn" onClick={() => void copy("prompt", prompt)}>{copied === "prompt" ? "Copied ✓" : "Copy prompt"}</button>
                  <button type="button" className="btn secondary" disabled={Boolean(busy)} onClick={refreshEnrollment}><BusyLabel busy={busy === "refresh"}>I finished — refresh keys</BusyLabel></button>
                </div>
                <details>
                  <summary>Review the setup prompt</summary>
                  <pre className="ssh prompt" id="enrollprompt">{prompt}</pre>
                </details>
              </motion.div>
            ) : enrollmentMode === "manual" ? (
              <motion.div
                key="manual-enrollment"
                id="keyform"
                initial={reducedMotion ? false : { opacity: 0, height: 0, y: 4 }}
                animate={{ opacity: 1, height: "auto", y: 0 }}
                {...(reducedMotion ? {} : { exit: { opacity: 0, height: 0, y: -4 } })}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
                style={{ overflow: "hidden" }}
              >
                <p className="muted">First create a key if needed, then print the public half:</p>
                <div className="command-row">
                  <pre className="ssh">{KEY_HELP}</pre>
                  <button type="button" className="btn secondary" onClick={() => void copy("commands", KEY_HELP)}>{copied === "commands" ? "Copied ✓" : "Copy commands"}</button>
                </div>
                <p className="muted">Paste only the output from the <code>.pub</code> file. Never paste your private key.</p>
                <label htmlFor="newkey">SSH public key</label>
                <textarea id="newkey" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} />
                <div className="row"><button type="button" className="btn" disabled={Boolean(busy)} onClick={save}><BusyLabel busy={busy === "save"}>Save key</BusyLabel></button></div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <div id="enroll"></div>
        </>
      )}
      <div className="err" role="alert" aria-live="assertive">{error}</div>
    </>
  );
}
