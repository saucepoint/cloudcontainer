import { AGENT_LABELS } from "@workbench/contract";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { BusyLabel } from "./busy-label.js";
import { askConfirmation } from "./confirmation.js";
import {
  STATUS_LABELS,
  displayError,
  isBusy,
  pollDelay,
  type ContainerAction,
  type ContainerView,
  type DashboardSnapshot,
  type SshKey,
} from "./dashboard-model.js";
import { Connection, SshKeys } from "./dashboard-ssh.js";
import { isUnauthorized, requestJson as api } from "./http.js";

function redirectIfSignedOut(error: unknown): boolean {
  if (!isUnauthorized(error)) return false;
  location.href = "/";
  return true;
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
    return <div className="card"><h2>No workbench yet</h2><a className="btn primary" href="/onboarding">Set up a workbench →</a></div>;
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
        true,
      );
      return;
    }
    action(operation);
  };

  return (
    <div className="card" aria-live="polite" aria-busy={busy}>
      <div className="card-head">
        <h2>{container.agents.map((agent) => AGENT_LABELS[agent]).join(" + ")} workbench</h2>
        <span className={`badge ${container.status}`} aria-label={`Workbench status: ${STATUS_LABELS[container.status]}`}>
          <BusyLabel busy={busy}>{STATUS_LABELS[container.status]}</BusyLabel>
        </span>
      </div>
      <p className="muted">{container.cpu} vCPU · {Math.round(container.ramMb / 1024)} GB RAM · {container.diskGb} GB Storage · {container.tier}</p>
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
      if (!redirectIfSignedOut(error)) {
        setPageError(displayError(error, "We could not load your dashboard. Check your connection and try again."));
      }
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
        if (!redirectIfSignedOut(error)) {
          setActionError("Could not refresh the workbench status. We will try again automatically.");
        }
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
          : displayError(error, "That action did not complete. Please try again."));
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
    () => void api("/api/account/delete", { method: "POST" })
      .then(() => { location.href = "/"; })
      .catch((error) => setActionError(displayError(error, "Could not delete the account."))),
    true,
  );

  if (!loaded) {
    return <><h1>Your workbench.</h1><div className="card" aria-live="polite" aria-busy="true"><span className="sr-only">Loading your workbench…</span><div className="skel skel-title" /><div className="skel skel-line" /><div className="skel skel-line short" /></div></>;
  }

  return (
    <>
      <h1>Your workbench.</h1>
      {pageError ? <div className="notice error" role="alert" aria-live="assertive">{pageError} <button type="button" className="link-btn" onClick={() => void loadDashboard()}>Try again</button></div> : null}
      {pageError ? null : <ContainerCard container={container} action={(operation) => void act(operation)} actionBusy={actionBusy} />}
      {actionError ? <div className="notice error" role="alert" aria-live="assertive">{actionError}</div> : null}
      <section className="card" aria-labelledby="ssh-heading"><h2 id="ssh-heading">SSH access</h2><div role="status" aria-live="polite"><Connection container={container} hasKeys={keys.length > 0} /></div><SshKeys container={container} keys={keys} refresh={refreshKeysAndConnection} /><div className="sr-only" role="status" aria-live="polite" /></section>
      <section className="card" aria-labelledby="danger-heading"><h2 id="danger-heading">Account</h2><button type="button" className="btn danger" disabled={Boolean(container && container.status !== "waitlisted")} onClick={deleteAccount}>Delete account</button><p className="muted hint">{container && container.status !== "waitlisted" ? "Destroy your workbench first. When deletion finishes, you can delete the account." : "Purges all credentials and keys, and removes your account."}</p></section>
    </>
  );
}

const root = document.getElementById("dashboard-root");
if (root) createRoot(root).render(<DashboardApp />);
