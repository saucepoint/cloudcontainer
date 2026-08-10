import { AGENT_LABELS } from "@workbench/contract";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { BusyLabel } from "./busy-label.js";
import { askConfirmation } from "./confirmation.js";
import {
  STATUS_LABELS,
  displayError,
  formatRamGb,
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
  cancelPlacement,
  actionBusy,
}: {
  container: ContainerView;
  action: (operation: ContainerAction) => void;
  cancelPlacement: () => void;
  actionBusy: boolean;
}) {
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
      <p className="muted">
        {container.cpu} vCPU · {formatRamGb(container.ramMb)} GB RAM · {container.diskGb} GB Storage · actual plan {container.tier}
        {container.planTransition ? ` · desired plan ${container.planTransition.desiredTier}` : ""}
      </p>
      {container.status === "provisioning" ? <p><BusyLabel busy>Building. Usually under 3 minutes.</BusyLabel></p> : null}
      {container.status === "waitlisted" ? (
        <>
          <p>All hosts are full. Your place is saved.</p>
          <button
            type="button"
            className="btn secondary"
            disabled={actionBusy}
            onClick={() => askConfirmation(
              "Withdraw placement?",
              "Remove this workbench from the capacity queue? You can start a new placement later.",
              "Withdraw placement",
              cancelPlacement,
              true,
            )}
          >
            Withdraw placement
          </button>
        </>
      ) : null}
      {container.status === "stopped" ? <p>Files are safe. Start the workbench to use SSH.</p> : null}
      {container.status === "suspended" ? (
        <p className="notice error">
          This workbench is suspended and your files are not currently accessible. Resubscribe or complete Free verification to restore access; contact support for export help before any displayed deadline.
        </p>
      ) : null}
      {container.status === "upgrade_pending" ? (
        <p className="notice warning">
          Payment confirmed. Your existing workbench remains available while we allocate capacity for the larger plan.
        </p>
      ) : null}
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
  const [billing, setBilling] = React.useState<DashboardSnapshot["billing"] | null>(null);
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
      setBilling(snapshot.billing);
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

  const cancelPlacement = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError("");
    try {
      await api("/api/container/cancel", { method: "POST" });
      refreshNeeded.current = false;
      applyContainer(null);
    } catch (error) {
      if (!redirectIfSignedOut(error)) {
        setActionError(displayError(error, "The placement could not be withdrawn. Please try again."));
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

  const openBilling = async (path: "/api/billing/checkout" | "/api/billing/portal") => {
    setActionBusy(true);
    setActionError("");
    try {
      const result = await api<{ url: string }>(path, { method: "POST" });
      window.location.assign(result.url);
    } catch (error) {
      setActionError(displayError(error, "Billing is temporarily unavailable."));
      setActionBusy(false);
    }
  };

  if (!loaded) {
    return <><h1>Your workbench.</h1><div className="card" aria-live="polite" aria-busy="true"><span className="sr-only">Loading your workbench…</span><div className="skel skel-title" /><div className="skel skel-line" /><div className="skel skel-line short" /></div></>;
  }

  return (
    <>
      <h1>Your workbench.</h1>
      {billing?.billing?.state === "past_due" || billing?.billing?.state === "grace" ? (
        <div className="notice warning" role="status">
          Your payment needs attention. Paid service remains available only through the displayed billing deadline.
        </div>
      ) : null}
      {billing?.billing?.state === "trialing" && billing.billing.trialUntil ? (
        <div className="notice" role="status">
          Your Paid trial ends on {new Date(billing.billing.trialUntil).toISOString().slice(0, 10)}. Stripe will charge your payment method after the trial.
        </div>
      ) : null}
      {billing?.billing?.state === "cancel_scheduled" && billing.billing.serviceUntil ? (
        <div className="notice warning" role="status">
          Paid service is scheduled to end on {new Date(billing.billing.serviceUntil).toISOString().slice(0, 10)}.
        </div>
      ) : null}
      {billing?.billing?.state === "expired" ? (
        <div className="notice error" role="status">
          Paid access ended. Resubscribe or complete Free verification to restore eligibility.
        </div>
      ) : null}
      {pageError ? <div className="notice error" role="alert" aria-live="assertive">{pageError} <button type="button" className="link-btn" onClick={() => void loadDashboard()}>Try again</button></div> : null}
      {pageError ? null : container ? (
        <ContainerCard
          container={container}
          action={(operation) => void act(operation)}
          cancelPlacement={() => void cancelPlacement()}
          actionBusy={actionBusy}
        />
      ) : (
        <section className="card" aria-labelledby="create-workbench-heading">
          <h2 id="create-workbench-heading">Create your workbench</h2>
          <p className="muted">Choose the setup that fits how you want to use usebench.</p>
          <div className="workbench-choice-grid">
            {billing?.entitlement.plan === "free" ? (
              <div>
                <h3>Free workbench</h3>
                <p className="muted">A verified account gets the free workbench tier.</p>
                <a className="btn secondary" href="/onboarding">Create a free workbench →</a>
              </div>
            ) : null}
            <div>
              <h3>Premium workbench</h3>
              <p className="muted">
                {billing?.paidPlan?.display ?? "More resources and persistent storage."}
              </p>
              {billing?.entitlement.plan === "paid" ? (
                <a className="btn primary" href="/onboarding">Create a premium workbench →</a>
              ) : billing?.configured ? (
                <button className="btn primary" type="button" disabled={actionBusy} onClick={() => void openBilling("/api/billing/checkout")}>
                  Create a premium workbench →
                </button>
              ) : <p className="muted">Premium workbenches are not available yet.</p>}
            </div>
          </div>
        </section>
      )}
      {actionError ? <div className="notice error" role="alert" aria-live="assertive">{actionError}</div> : null}
      <section className="card" aria-labelledby="ssh-heading"><h2 id="ssh-heading">SSH access</h2><div role="status" aria-live="polite"><Connection container={container} hasKeys={keys.length > 0} /></div><SshKeys container={container} keys={keys} refresh={refreshKeysAndConnection} /><div className="sr-only" role="status" aria-live="polite" /></section>
    </>
  );
}

const root = document.getElementById("dashboard-root");
if (root) createRoot(root).render(<DashboardApp />);
