import { AGENT_LABELS, type JobOp } from "@workbench/contract";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { createRoot } from "react-dom/client";

type ContainerView = {
  id: string;
  status: string;
  statusDetail: string | null;
  agents: Array<keyof typeof AGENT_LABELS>;
  tier: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  sshCommand: string | null;
  hostKeyFingerprints: string[];
  job: { id: string; op: JobOp; status: string; error: string | null } | null;
  allowedOps: JobOp[];
};

type SshKey = {
  id: number;
  label: string;
  pubkey: string;
  created_at: number;
};

type DashboardSnapshot = {
  container: ContainerView | null;
  keys: SshKey[];
};

type Enrollment = { endpoint: string; token: string };
type EnrollmentMode = "agent" | "manual";
type ContainerAction = JobOp | "retry";

const STATUS_LABELS: Record<string, string> = {
  waitlisted: "Waiting for capacity",
  provisioning: "Building",
  running: "Ready",
  stopped: "Stopped",
  suspended: "Suspended",
  upgrade_pending: "Upgrade pending",
  error: "Needs attention",
  destroying: "Deleting",
};

const KEY_HELP = "ssh-keygen -t ed25519\ncat ~/.ssh/id_ed25519.pub";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const json = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(json.error || `request failed: ${response.status}`);
  return json;
}

function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return message && message !== "internal error" ? message : fallback;
}

function redirectIfSignedOut(error: unknown): boolean {
  if (errorMessage(error, "").includes("unauthenticated")) {
    location.href = "/";
    return true;
  }
  return false;
}

function isBusy(container: ContainerView | null): boolean {
  return Boolean(container && (
    container.status === "provisioning" ||
    container.status === "destroying" ||
    container.job?.status === "queued" ||
    container.job?.status === "running"
  ));
}

function canManageSshKeys(container: ContainerView | null): boolean {
  return container?.status === "running";
}

function pollDelay(container: ContainerView | null, refreshNeeded = false): number | null {
  if (refreshNeeded) return 5_000;
  if (!container) return null;
  if (container.status === "waitlisted") return 30_000;
  if (isBusy(container)) return 5_000;
  return null;
}

function askConfirmation(
  title: string,
  description: string,
  confirmLabel: string,
  onConfirm: () => void,
): void {
  if (window.requestConfirmation) {
    window.requestConfirmation({ title, description, confirmLabel, onConfirm });
  } else if (confirm(description)) {
    onConfirm();
  }
}

async function copyValue(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
}

function BusyLabel({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return <>{busy ? <span className="spinner" aria-hidden="true" /> : null}{children}</>;
}

function ContainerCard({
  container,
  action,
  actionBusy,
}: {
  container: ContainerView | null;
  action: (operation: ContainerAction) => void;
  actionBusy: boolean;
}) {
  if (!container) {
    return <div className="card"><h2>No workbench yet</h2><a className="btn" href="/onboarding">Set up a workbench →</a></div>;
  }

  const busy = isBusy(container);
  const runAction = (operation: ContainerAction) => {
    if (operation === "destroy" || operation === "rebuild") {
      askConfirmation(
        operation === "destroy" ? "Destroy workbench?" : "Rebuild workbench?",
        operation === "destroy"
          ? "Destroy the workbench and ALL its data? This cannot be undone."
          : "Rebuild resets everything outside /home/dev. Continue?",
        operation === "destroy" ? "Destroy workbench" : "Rebuild workbench",
        () => action(operation),
      );
      return;
    }
    action(operation);
  };

  return (
    <div className="card" aria-live="polite" aria-busy={busy}>
      <div className="card-head">
        <h2>{container.agents.map((agent) => AGENT_LABELS[agent] ?? agent).join(" + ")} workbench</h2>
        <span className={`badge ${container.status}`} aria-label={`Workbench status: ${STATUS_LABELS[container.status] ?? container.status}`}>
          <BusyLabel busy={busy}>{STATUS_LABELS[container.status] ?? container.status}</BusyLabel>
        </span>
      </div>
      <p className="muted">{container.cpu} vCPU · {Math.round(container.ramMb / 1024)} GB RAM · {container.diskGb} GB persistent disk · {container.tier}</p>
      {container.status === "provisioning" ? <p><BusyLabel busy>Building. Usually under 3 minutes.</BusyLabel></p> : null}
      {container.status === "waitlisted" ? <p>All hosts are full. Your place is saved.</p> : null}
      {container.status === "stopped" ? <p>Files are safe. Start the workbench to use SSH.</p> : null}
      {container.status === "suspended" ? <p className="notice error">This workbench is suspended. Your files are not currently accessible.</p> : null}
      {container.status === "upgrade_pending" ? <p className="notice warning">Your upgrade is waiting for host capacity. No action is needed.</p> : null}
      {container.status === "destroying" ? <p><BusyLabel busy>Deleting…</BusyLabel></p> : null}
      {container.status === "error" ? (
        <>
          <p className="notice error">The last operation did not finish successfully.</p>
          {container.statusDetail ? <details><summary>Technical details</summary><pre className="ssh prompt">{container.statusDetail}</pre></details> : null}
          <button type="button" className="btn" disabled={actionBusy} onClick={() => runAction("retry")}>Try again</button>
        </>
      ) : null}
      {container.allowedOps.length ? (
        <div className="row">
          {container.allowedOps.map((operation) => (
            <button
              type="button"
              className={`btn ${operation === "destroy" ? "danger" : operation === "stop" || operation === "rebuild" ? "secondary" : ""}`}
              disabled={actionBusy}
              key={operation}
              onClick={() => runAction(operation)}
            >
              {operation[0]?.toUpperCase()}{operation.slice(1)}
            </button>
          ))}
        </div>
      ) : null}
      {container.job?.status === "failed" && container.status !== "error" ? (
        <p className="notice error">Last operation ({container.job.op}) failed: {container.job.error || "unknown error"}</p>
      ) : null}
    </div>
  );
}

function Connection({ container, hasKeys }: { container: ContainerView | null; hasKeys: boolean }) {
  const [copied, setCopied] = React.useState(false);
  if (!container) return <p className="muted">Connection details appear after you create a workbench.</p>;
  if (container.status === "running" && !hasKeys) {
    return <p className="notice warning"><strong>Add an SSH key to reveal your connection command.</strong> You cannot see the SSH host or port until a key has been added. Choose “Set up SSH with an agent” below for a copyable coding-agent prompt, or add a public key manually.</p>;
  }
  if (container.sshCommand) {
    const copy = async () => {
      await copyValue(container.sshCommand ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    };
    return (
      <>
        <p><strong>Run this in your terminal</strong></p>
        <div className="command-row"><pre className="ssh">{container.sshCommand}</pre><button type="button" className="btn secondary" onClick={copy}>{copied ? "Copied ✓" : "Copy SSH command"}</button></div>
        {container.hostKeyFingerprints.length ? <details><summary>Verify this workbench on your first connection</summary><p className="muted">SSH may ask whether you trust this host. The fingerprint it shows must match one below.</p><pre className="ssh">{container.hostKeyFingerprints.join("\n")}</pre></details> : null}
      </>
    );
  }
  if (container.status === "stopped") return <p className="muted">Start the workbench to see its SSH command.</p>;
  if (container.status === "provisioning" || container.status === "waitlisted") return <p className="muted">Your SSH command and SSH setup options will appear here when the workbench is ready.</p>;
  return <p className="muted">SSH is not available in the current workbench state.</p>;
}

function SshKeys({
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
    try { await work(); } catch (caught) { setError(errorMessage(caught, "That SSH key action did not complete.")); } finally { setBusy(""); }
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
    "Set up SSH access to my Workbench cloud workbench:",
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
    await copyValue(value);
    setCopied(name);
    setTimeout(() => setCopied(""), 2_000);
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
                  <button type="button" className="btn" onClick={() => copy("prompt", prompt)}>{copied === "prompt" ? "Copied ✓" : "Copy prompt"}</button>
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
                  <button type="button" className="btn secondary" onClick={() => copy("commands", KEY_HELP)}>{copied === "commands" ? "Copied ✓" : "Copy commands"}</button>
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

function DashboardApp() {
  const [loaded, setLoaded] = React.useState(false);
  const [container, setContainer] = React.useState<ContainerView | null>(null);
  const [keys, setKeys] = React.useState<SshKey[]>([]);
  const [pageError, setPageError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [actionBusy, setActionBusy] = React.useState(false);
  const [pollVersion, setPollVersion] = React.useState(0);
  const pollInFlight = React.useRef(false);
  const refreshNeeded = React.useRef(false);
  const containerRef = React.useRef<ContainerView | null>(null);

  const applyContainer = React.useCallback((next: ContainerView | null) => {
    containerRef.current = next;
    setContainer(next);
  }, []);

  const loadDashboard = React.useCallback(async () => {
    setPageError("");
    setActionError("");
    try {
      const snapshot = await api<DashboardSnapshot>("/api/dashboard");
      refreshNeeded.current = false;
      applyContainer(snapshot.container);
      setKeys(snapshot.keys);
      setLoaded(true);
    } catch (error) {
      if (!redirectIfSignedOut(error)) setPageError(errorMessage(error, "We could not load your dashboard. Check your connection and try again."));
      setLoaded(true);
    }
  }, [applyContainer]);

  React.useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pollContainer = async () => {
      if (pollInFlight.current || document.hidden) return;
      pollInFlight.current = true;
      try {
        const result = await api<{ container: ContainerView | null }>("/api/container");
        refreshNeeded.current = false;
        applyContainer(result.container);
        setActionError("");
      } catch (error) {
        if (!redirectIfSignedOut(error)) setActionError("Could not refresh the workbench status. We will try again automatically.");
      } finally {
        pollInFlight.current = false;
        setPollVersion((version) => version + 1);
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      const delay = pollDelay(containerRef.current, refreshNeeded.current);
      if (delay !== null && !document.hidden) timer = setTimeout(pollContainer, delay);
    };
    const visibilityChanged = () => document.hidden ? timer && clearTimeout(timer) : schedule();
    schedule();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [applyContainer, container, pollVersion]);

  const act = async (operation: ContainerAction) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError("");
    try {
      await api(`/api/container/${operation}`, { method: "POST" });
      refreshNeeded.current = true;
      const result = await api<{ container: ContainerView | null }>("/api/container");
      refreshNeeded.current = false;
      applyContainer(result.container);
    } catch (error) {
      if (!redirectIfSignedOut(error)) {
        setActionError(refreshNeeded.current
          ? "The action started, but its latest status is unavailable. We will try again automatically."
          : errorMessage(error, "That action did not complete. Please try again."));
      }
      setPollVersion((version) => version + 1);
    } finally {
      setActionBusy(false);
    }
  };

  const refreshKeysAndConnection = async () => {
    const [keyResult, containerResult] = await Promise.all([
      api<{ keys: SshKey[] }>("/api/keys"),
      api<{ container: ContainerView | null }>("/api/container"),
    ]);
    setKeys(keyResult.keys);
    applyContainer(containerResult.container);
  };

  const deleteAccount = () => askConfirmation(
    "Delete account?",
    "This permanently deletes your credentials, keys, and account. There is no grace period.",
    "Delete account",
    () => void api("/api/account/delete", { method: "POST" }).then(() => { location.href = "/"; }).catch((error) => setActionError(errorMessage(error, "Could not delete the account."))),
  );

  if (!loaded) return <><h1>Your workbench.</h1><div className="card" aria-live="polite" aria-busy="true"><p className="muted"><BusyLabel busy>Loading your workbench…</BusyLabel></p></div></>;

  return (
    <>
      <h1>Your workbench.</h1>
      {pageError ? <div className="notice error" role="alert" aria-live="assertive">{pageError} <button type="button" className="link-btn" onClick={() => void loadDashboard()}>Try again</button></div> : null}
      {pageError ? null : <ContainerCard container={container} action={(operation) => void act(operation)} actionBusy={actionBusy} />}
      {actionError ? <div className="notice error" role="alert" aria-live="assertive">{actionError}</div> : null}
      <section className="card" aria-labelledby="ssh-heading"><h2 id="ssh-heading">SSH access</h2><div role="status" aria-live="polite"><Connection container={container} hasKeys={keys.length > 0} /></div><SshKeys container={container} keys={keys} refresh={refreshKeysAndConnection} /><div className="sr-only" role="status" aria-live="polite" /></section>
      <section className="card" aria-labelledby="danger-heading"><h2 id="danger-heading">Account</h2><button type="button" className="btn danger" disabled={Boolean(container && container.status !== "waitlisted")} onClick={deleteAccount}>Delete account</button><p className="muted" style={{ marginTop: "0.6rem" }}>{container && container.status !== "waitlisted" ? "Destroy your workbench first. When deletion finishes, you can delete the account." : "Purges all credentials and keys, and removes your account."}</p></section>
    </>
  );
}

const root = document.getElementById("dashboard-root");
if (root) createRoot(root).render(<DashboardApp />);
