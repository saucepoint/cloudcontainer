import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CheckIcon, CopyIcon, Pencil1Icon, TrashIcon } from "@radix-ui/react-icons";
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

/** Briefly animates transient button feedback such as "Copied ✓". */
function SwapText({ swapped, swappedText, children }: { swapped: boolean; swappedText: React.ReactNode; children: React.ReactNode }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.span
      key={swapped ? "swapped" : "idle"}
      initial={swapped && !reducedMotion ? { opacity: 0, y: 3 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
    >
      {swapped ? swappedText : children}
    </motion.span>
  );
}

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
    return (
      <div className="ssh-connection-gate">
        <strong>SSH details are hidden until you add a key.</strong>
        <span>Your host, port, and connection command will appear here once a device has access.</span>
      </div>
    );
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
      <div className="ssh-command">
        <div className="ssh-command-heading">
          <strong>Connect from your terminal</strong>
          <span className="muted">One command is all you need.</span>
        </div>
        <div className="command-row"><pre className="ssh">{container.sshCommand}</pre><button type="button" className="btn secondary icon-btn" aria-label="Copy SSH command" title="Copy SSH command" onClick={() => void copy()}><SwapText swapped={copied} swappedText={<CheckIcon aria-hidden="true" />}><CopyIcon aria-hidden="true" /></SwapText></button></div>
        {copyError ? <p className="err" role="alert">{copyError}</p> : null}
        {container.hostKeyFingerprints.length ? <details><summary>Verify this workbench on your first connection</summary><p className="muted">SSH may ask whether you trust this host. The fingerprint it shows must match one below.</p><pre className="ssh">{container.hostKeyFingerprints.join("\n")}</pre></details> : null}
      </div>
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
  const [keyLabel, setKeyLabel] = React.useState("");
  const [enrollment, setEnrollment] = React.useState<Enrollment | null>(null);
  const [renamingId, setRenamingId] = React.useState<number | null>(null);
  const [renameLabel, setRenameLabel] = React.useState("");
  const [githubImportOpen, setGithubImportOpen] = React.useState(false);
  const [githubUsername, setGithubUsername] = React.useState("");
  const [githubLabel, setGithubLabel] = React.useState("");
  const [githubStatus, setGithubStatus] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState("");
  const [agentPromptOpen, setAgentPromptOpen] = React.useState(false);
  const [showAllKeys, setShowAllKeys] = React.useState(false);
  const pendingPanelScroll = React.useRef<number | null>(null);
  const panelScrollY = React.useRef<number | null>(null);
  const previousKeyCount = React.useRef(keys.length);

  React.useLayoutEffect(() => {
    if (pendingPanelScroll.current === null) return;
    const scrollY = pendingPanelScroll.current;
    pendingPanelScroll.current = null;
    window.scrollTo({ top: scrollY, behavior: "auto" });
  });

  React.useEffect(() => {
    if (previousKeyCount.current !== keys.length) {
      previousKeyCount.current = keys.length;
      setShowAllKeys(false);
    }
  }, [keys.length]);

  React.useEffect(() => {
    if (!ready) {
      setEnrollment(null);
      setEnrollmentMode(null);
      setGithubImportOpen(false);
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

  const preservePanelScroll = (update: () => void) => {
    const scrollY = window.scrollY;
    pendingPanelScroll.current = scrollY;
    panelScrollY.current = scrollY;
    update();
  };

  const restorePanelScroll = () => {
    if (panelScrollY.current === null) return;
    window.scrollTo({ top: panelScrollY.current, behavior: "auto" });
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

  const startRename = (key: SshKey) => {
    setRenamingId(key.id);
    setRenameLabel(key.label);
    setError("");
  };

  const rename = (key: SshKey) => void withBusy(`rename-${key.id}`, async () => {
    await api(`/api/keys/${key.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: renameLabel }),
    });
    setRenamingId(null);
    await refresh();
  });

  const save = () => void withBusy("save", async () => {
    await api("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey: publicKey, label: keyLabel }),
    });
    setPublicKey("");
    setKeyLabel("");
    preservePanelScroll(() => {
      setEnrollment(null);
      setEnrollmentMode(null);
      setAgentPromptOpen(false);
    });
    await refresh();
  });

  const importGithub = () => void withBusy("github", async () => {
    setGithubStatus("");
    const result = await api<{ found: number; imported: number; duplicates: number }>("/api/keys/import/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: githubUsername.trim(), label: githubLabel }),
    });
    setGithubStatus(
      !result.found
        ? "That GitHub account has no usable public SSH keys."
        : result.imported
          ? `Imported ${result.imported} public key${result.imported === 1 ? "" : "s"}${result.duplicates ? `; ${result.duplicates} already saved` : ""}.`
          : "Those public keys are already saved.",
    );
    setGithubUsername("");
    setGithubLabel("");
    await refresh();
  });

  const openAgentEnrollment = () => {
    preservePanelScroll(() => {
      setGithubImportOpen(false);
      setEnrollmentMode("agent");
      if (enrollmentMode !== "agent") setAgentPromptOpen(false);
    });
    if (enrollment) return;
    void withBusy("mint", async () => {
      const nextEnrollment = await api<Enrollment>("/api/enrollment", { method: "POST" });
      preservePanelScroll(() => setEnrollment(nextEnrollment));
    });
  };

  const openManualEnrollment = () => {
    preservePanelScroll(() => {
      setGithubImportOpen(false);
      setEnrollmentMode("manual");
      setAgentPromptOpen(false);
    });
  };

  const openGithubImport = () => {
    preservePanelScroll(() => {
      setEnrollment(null);
      setEnrollmentMode(null);
      setGithubImportOpen(true);
      setGithubStatus("");
      setAgentPromptOpen(false);
    });
  };

  const refreshEnrollment = () => void withBusy("refresh", async () => {
    await refresh();
    preservePanelScroll(() => {
      setEnrollment(null);
      setEnrollmentMode(null);
      setAgentPromptOpen(false);
    });
  });

  const prompt = enrollment ? [
    "Set up SSH access to my usebench.dev cloud workbench:",
    "",
    "1. Ensure an ed25519 SSH keypair exists at ~/.ssh/workbench_ed25519 (create it with ssh-keygen, no passphrase, if missing). Never read or transmit the private key file — only the .pub file is needed.",
    `2. Send a POST request to ${enrollment.endpoint} with header "content-type: application/json" and JSON body:`,
    `   {"token": "${enrollment.token}", "pubkey": "<full contents of ~/.ssh/workbench_ed25519.pub>"}`,
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
      {!ready ? <p className="notice"><strong>SSH setup unlocks after the workbench is ready.</strong></p> : (
        <>
          <div className="ssh-key-toolbar">
            <div className="ssh-key-toolbar-copy">
              <strong>Add a device</strong>
              <span className="muted">Choose how to register its public key.</span>
            </div>
            <div className="ssh-key-toolbar-actions">
              <button type="button" className={`btn primary ${enrollmentMode === "manual" ? "is-active" : ""}`} aria-label={keys.length ? "Add another key manually" : "Add a key manually"} aria-pressed={enrollmentMode === "manual"} disabled={Boolean(busy)} onClick={openManualEnrollment}>{keys.length ? "Add key" : "Add a key"}</button>
              <button type="button" className={`btn secondary ${githubImportOpen ? "is-active" : ""}`} aria-pressed={githubImportOpen} disabled={Boolean(busy)} onClick={openGithubImport}>Import from GitHub</button>
              <button type="button" className={`link-btn ssh-agent-link ${enrollmentMode === "agent" ? "is-active" : ""}`} aria-label={keys.length ? "Enroll another device with an agent" : "Set up SSH with an agent"} aria-pressed={enrollmentMode === "agent"} disabled={Boolean(busy)} onClick={openAgentEnrollment}><BusyLabel busy={busy === "mint"}>{keys.length ? "Use an agent" : "Set up with an agent"}</BusyLabel></button>
            </div>
          </div>
          <div className="ssh-enrollment-panel">
          <AnimatePresence initial={false} mode="sync" onExitComplete={restorePanelScroll}>
            {githubImportOpen ? (
              <motion.div
                key="github-import"
                className="ssh-enrollment-view"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                {...(reducedMotion ? {} : { exit: { opacity: 0 } })}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.14, ease: "easeOut" }}
              >
                <p className="muted">Import every public key listed at <code>github.com/username.keys</code>.</p>
                <label htmlFor="github-ssh-username">GitHub username</label>
                <input id="github-ssh-username" value={githubUsername} onChange={(event) => setGithubUsername(event.target.value)} placeholder="octocat" autoComplete="off" />
                <label htmlFor="github-ssh-label">Name imported keys <span className="muted">optional</span></label>
                <input id="github-ssh-label" value={githubLabel} maxLength={64} onChange={(event) => setGithubLabel(event.target.value)} placeholder="e.g. personal laptop" />
                <div className="row"><button type="button" className="btn primary" disabled={Boolean(busy) || !githubUsername.trim()} onClick={importGithub}><BusyLabel busy={busy === "github"}>Import public keys</BusyLabel></button></div>
                {githubStatus ? <p className="muted" role="status" aria-live="polite">{githubStatus}</p> : null}
              </motion.div>
            ) : enrollmentMode === "agent" && enrollment ? (
              <motion.div
                key="agent-enrollment"
                className="ssh-enrollment-view"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                {...(reducedMotion ? {} : { exit: { opacity: 0 } })}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.14, ease: "easeOut" }}
              >
                <div className="notice">
                  <strong>Paste this <button type="button" className="link-btn ssh-prompt-link" aria-expanded={agentPromptOpen} aria-controls="enrollprompt" onClick={() => setAgentPromptOpen((visible) => !visible)}>prompt</button> into your local coding agent</strong>
                  <p className="muted">It creates a dedicated key, registers only the public half, and configures the short command <code>ssh workbench</code>.</p>
                </div>
                <div className="row">
                  <button type="button" className="btn secondary" onClick={() => void copy("prompt", prompt)}><SwapText swapped={copied === "prompt"} swappedText="Copied">Copy Prompt</SwapText></button>
                  <button type="button" className="btn secondary" disabled={Boolean(busy)} onClick={refreshEnrollment}><BusyLabel busy={busy === "refresh"}>I finished — refresh keys</BusyLabel></button>
                </div>
                <AnimatePresence initial={false}>
                  {agentPromptOpen ? (
                    <motion.div
                      key="agent-prompt"
                      initial={reducedMotion ? false : { opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                      transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: "easeOut" }}
                    >
                      <pre className="ssh prompt" id="enrollprompt">{prompt}</pre>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            ) : enrollmentMode === "manual" ? (
              <motion.div
                key="manual-enrollment"
                id="keyform"
                className="ssh-enrollment-view"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                {...(reducedMotion ? {} : { exit: { opacity: 0 } })}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.14, ease: "easeOut" }}
              >
                <p className="muted">First create a key if needed, then print the public half:</p>
                <div className="command-row">
                  <pre className="ssh">{KEY_HELP}</pre>
                  <button type="button" className="btn secondary icon-btn" aria-label="Copy commands" title="Copy commands" onClick={() => void copy("commands", KEY_HELP)}><SwapText swapped={copied === "commands"} swappedText={<CheckIcon aria-hidden="true" />}><CopyIcon aria-hidden="true" /></SwapText></button>
                </div>
                <p className="muted">Paste only the output from the <code>.pub</code> file. Never paste your private key.</p>
                <label htmlFor="newkey-name">Key name <span className="muted">optional</span></label>
                <input id="newkey-name" value={keyLabel} maxLength={64} onChange={(event) => setKeyLabel(event.target.value)} placeholder="e.g. personal laptop" />
                <label htmlFor="newkey">SSH public key</label>
                <textarea id="newkey" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" spellCheck={false} />
                <div className="row"><button type="button" className="btn primary" disabled={Boolean(busy)} onClick={save}><BusyLabel busy={busy === "save"}>Save key</BusyLabel></button></div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          </div>
          <div id="enroll"></div>
        </>
      )}
      <div className="ssh-keys-heading">
        <div>
          <h3>Saved devices <span className="ssh-key-count">{keys.length}</span></h3>
          <p className="muted">Each device uses one of these public keys to connect.</p>
        </div>
      </div>
      {keys.length === 0 && ready ? (
        <div className="ssh-empty">
          <strong>No devices added yet</strong>
          <span className="muted">Add a public key below to reveal your connection details.</span>
        </div>
      ) : keys.length ? (
        <>
          <motion.ul layout={!reducedMotion} className="ssh-key-list">
            <AnimatePresence initial={false}>
            {(showAllKeys ? keys : keys.slice(0, 4)).map((key, index) => (
            <motion.li
              className="ssh-key"
              key={key.id}
              layout={!reducedMotion}
              initial={showAllKeys && index >= 4 && !reducedMotion ? { opacity: 0, y: -8 } : false}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
              transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }}
            >
              <div className="ssh-key-copy">
                <div className="ssh-key-title">
                  <span className="ssh-key-indicator" aria-hidden="true" />
                  <strong>{key.label || "Unnamed device"}</strong>
                </div>
                <div className="ssh-key-public">
                  <code className="ssh-key-meta">{key.pubkey}</code>
                </div>
                {renamingId === key.id ? (
                  <div className="ssh-key-rename">
                    <label htmlFor={`rename-key-${key.id}`}>Device name</label>
                    <input id={`rename-key-${key.id}`} value={renameLabel} maxLength={64} onChange={(event) => setRenameLabel(event.target.value)} />
                    <div className="row">
                      <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={() => rename(key)}><BusyLabel busy={busy === `rename-${key.id}`}>Save name</BusyLabel></button>
                      <button type="button" className="btn secondary" disabled={Boolean(busy)} onClick={() => setRenamingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : null}
              </div>
              {ready ? <div className="ssh-key-actions"><button type="button" className="link-btn icon-btn" aria-label="Copy public SSH key" title="Copy public SSH key" disabled={Boolean(busy)} onClick={() => void copy(`key-${key.id}`, key.pubkey)}><SwapText swapped={copied === `key-${key.id}`} swappedText={<CheckIcon aria-hidden="true" />}><CopyIcon aria-hidden="true" /></SwapText></button><button type="button" className="link-btn icon-btn" aria-label={`Rename ${key.label || "SSH key"}`} title="Rename key" disabled={Boolean(busy)} onClick={() => startRename(key)}><Pencil1Icon aria-hidden="true" /></button><button type="button" className="link-btn icon-btn danger-icon" aria-label={`Remove ${key.label || "SSH key"}`} title="Remove key" disabled={Boolean(busy)} onClick={() => remove(key)}><BusyLabel busy={busy === `remove-${key.id}`}><TrashIcon aria-hidden="true" /></BusyLabel></button></div> : null}
            </motion.li>
            ))}
            </AnimatePresence>
          </motion.ul>
          {keys.length > 4 ? <button type="button" className="ssh-see-more" aria-label={showAllKeys ? "Show fewer SSH keys" : `See ${keys.length - 4} more SSH keys`} onClick={() => setShowAllKeys((visible) => !visible)}>{showAllKeys ? "Show less" : "See more"}</button> : null}
        </>
      ) : null}
      <div className="err" role="alert" aria-live="assertive">{error}</div>
    </>
  );
}
