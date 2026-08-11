import { AGENT_LABELS, LLM_PROVIDER_LABELS, type Tier } from "@workbench/contract";
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
  type BillingStatus,
  type ContainerAction,
  type ContainerView,
  type DashboardSnapshot,
  type SshKey,
} from "./dashboard-model.js";
import { Connection, SshKeys } from "./dashboard-ssh.js";
import { isUnauthorized, requestJson as api } from "./http.js";

const CHECKOUT_POLL_INTERVAL_MS = 1_000;
const CHECKOUT_POLL_MAX_ATTEMPTS = 30;

type CheckoutStatus = "idle" | "confirming" | "confirmed" | "timed_out";
type PremiumUpgradeOffer = NonNullable<DashboardSnapshot["billing"]["paidPlan"]> & {
  trialEligible: boolean;
};

function redirectIfSignedOut(error: unknown): boolean {
  if (!isUnauthorized(error)) return false;
  location.href = "/";
  return true;
}

function ContainerCard({
  container,
  action,
  cancelPlacement,
  upgradeOffer,
  upgrade,
  actionBusy,
}: {
  container: ContainerView;
  action: (operation: ContainerAction) => void;
  cancelPlacement: () => void;
  upgradeOffer: PremiumUpgradeOffer | null;
  upgrade: () => void;
  actionBusy: boolean;
}) {
  const busy = isBusy(container);
  const runAction = (operation: ContainerAction) => {
    if (operation === "destroy" || operation === "rebuild" || operation === "stop") {
      askConfirmation(
        operation === "destroy"
          ? "Destroy workbench?"
          : operation === "rebuild"
          ? "Rebuild workbench?"
          : "Stop workbench?",
        operation === "destroy"
          ? "Destroy the workbench and ALL its data? This cannot be undone."
          : operation === "rebuild"
          ? "Rebuild resets everything outside /home/dev. Continue?"
          : "Stopping disconnects active sessions. Unsaved progress may be lost, but files already written to disk are preserved.",
        operation === "destroy"
          ? "Destroy workbench"
          : operation === "rebuild"
          ? "Rebuild workbench"
          : "Stop workbench",
        () => action(operation),
        operation !== "stop",
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
        {container.cpu} vCPU · {formatRamGb(container.ramMb)} GB RAM · {container.tier === "paid" ? "premium" : "free"}
      </p>
      {container.status === "running" && container.tier === "free" && upgradeOffer ? (
        <div className="premium-upgrade-cta">
          <p>
            <strong>Upgrade this workbench in place.</strong><br />
            Get 2 vCPU, 4 GB RAM, and more storage for {upgradeOffer.currency} {upgradeOffer.price}/month. Your persistent files stay on the same disk.
          </p>
          <button className="btn primary" type="button" disabled={actionBusy} onClick={upgrade}>
            {upgradeOffer.trialEligible ? "Start 7-day Premium trial →" : "Upgrade to Premium →"}
          </button>
        </div>
      ) : null}
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
          {container.planTransition?.desiredTier === "free"
            ? "Premium access ended. We are stopping the workbench before applying Free limits. Unsaved progress in active sessions may be lost; files on the persistent disk will be retained."
            : "Payment confirmed. Your existing workbench remains available while we allocate capacity for the larger plan. Persistent files stay on the same disk."}
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

const ACCOUNT_STATE_LABELS: Record<DashboardSnapshot["account"]["state"], string> = {
  unverified: "Unverified",
  verified: "Verified",
  premium: "Premium",
  verified_premium: "Verified premium",
};

const MACHINE_SPECS: Record<Tier, string> = {
  free: "1 vCPU · 1.5 GB RAM",
  paid: "2 vCPU · 4.0 GB RAM",
};

const CHATGPT_SUBSCRIPTION_PROVIDERS = new Set([
  "codex_subscription_token",
  "pi_codex_subscription_token",
  "opencode_codex_subscription_token",
]);
const CLAUDE_SUBSCRIPTION_PROVIDERS = new Set([
  "claude_subscription_token",
  "pi_claude_subscription_token",
  "opencode_claude_subscription_token",
]);

function configuredModelProviders(credentials: DashboardSnapshot["credentials"]): string[] {
  const providers = new Set<string>();
  const configured = Object.keys(credentials.llm).filter((provider) => credentials.llm[provider]);
  if (configured.some((provider) => CHATGPT_SUBSCRIPTION_PROVIDERS.has(provider))) {
    providers.add("ChatGPT");
  }
  if (configured.some((provider) => CLAUDE_SUBSCRIPTION_PROVIDERS.has(provider))) {
    providers.add("Claude");
  }
  for (const provider of configured) {
    if (CHATGPT_SUBSCRIPTION_PROVIDERS.has(provider) || CLAUDE_SUBSCRIPTION_PROVIDERS.has(provider)) continue;
    if (provider === "github_copilot") {
      providers.add("GitHub Copilot");
      continue;
    }
    const label = LLM_PROVIDER_LABELS[provider as keyof typeof LLM_PROVIDER_LABELS] ?? provider;
    providers.add(label);
  }
  return [...providers];
}

function configuredIntegrations(credentials: DashboardSnapshot["credentials"]): string[] {
  const integrations: string[] = [];
  if (credentials.github) integrations.push(`GitHub (${credentials.github})`);
  if (credentials.cloudflare) integrations.push("Cloudflare API");
  if (credentials.wrangler) integrations.push("Cloudflare Wrangler");
  if (credentials.supabase) integrations.push("Supabase");
  if (credentials.convex) integrations.push("Convex");
  return integrations;
}

function ConfigurationSummary({
  configuration,
  credentials,
  sshKeyCount,
  selectedTier,
  editable,
}: {
  configuration: NonNullable<DashboardSnapshot["configuration"]>;
  credentials: DashboardSnapshot["credentials"];
  sshKeyCount: number;
  selectedTier: Tier;
  editable: boolean;
}) {
  const modelProviders = configuredModelProviders(credentials);
  const integrations = configuredIntegrations(credentials);
  return (
    <details className="card configuration-summary" open={editable}>
      <summary><strong>Workbench configuration</strong><span className="muted">View setup</span></summary>
      <dl className="configuration-facts">
        <div><dt>Agents</dt><dd>{configuration.agents.map((agent) => AGENT_LABELS[agent]).join(", ")}</dd></div>
        <div><dt>Model Provider</dt><dd>{modelProviders.length ? modelProviders.join(", ") : "None"}</dd></div>
        <div><dt>Integrations</dt><dd>{integrations.length ? integrations.join(", ") : "None"}</dd></div>
        <div><dt>Repositories</dt><dd>{configuration.githubRepos.length ? configuration.githubRepos.join(", ") : "None"}</dd></div>
        <div><dt>Machine</dt><dd>{MACHINE_SPECS[selectedTier]}</dd></div>
        <div><dt>SSH keys</dt><dd>{sshKeyCount}</dd></div>
      </dl>
      {editable ? <a className="btn secondary" href="/configure">Edit configuration</a> : null}
    </details>
  );
}

function DashboardApp() {
  const [checkoutSuccess] = React.useState(
    () => new URLSearchParams(window.location.search).get("checkout") === "success",
  );
  const [checkoutStatus, setCheckoutStatus] = React.useState<CheckoutStatus>(
    checkoutSuccess ? "confirming" : "idle",
  );
  const [loaded, setLoaded] = React.useState(false);
  const [container, setContainer] = React.useState<ContainerView | null>(null);
  const [configuration, setConfiguration] = React.useState<DashboardSnapshot["configuration"]>(null);
  const [keys, setKeys] = React.useState<SshKey[]>([]);
  const [credentials, setCredentials] = React.useState<DashboardSnapshot["credentials"] | null>(null);
  const [billing, setBilling] = React.useState<DashboardSnapshot["billing"] | null>(null);
  const [account, setAccount] = React.useState<DashboardSnapshot["account"] | null>(null);
  const [selectedTier, setSelectedTier] = React.useState<Tier>("free");
  const [pageError, setPageError] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [actionBusy, setActionBusy] = React.useState(false);
  const [pollVersion, setPollVersion] = React.useState(0);
  const pollInFlight = React.useRef(false);
  const checkoutPollInFlight = React.useRef(false);
  const refreshNeeded = React.useRef(false);
  const containerRef = React.useRef<ContainerView | null>(null);

  const applyContainer = React.useCallback((next: ContainerView | null) => {
    containerRef.current = next;
    setContainer(next);
  }, []);

  const completeCheckout = React.useCallback(() => {
    setCheckoutStatus("confirmed");
    if (!checkoutSuccess) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("checkout");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [checkoutSuccess]);

  const loadDashboard = React.useCallback(async () => {
    setPageError("");
    setActionError("");
    try {
      const snapshot = await api<DashboardSnapshot>("/api/dashboard");
      refreshNeeded.current = false;
      applyContainer(snapshot.container);
      setConfiguration(snapshot.configuration);
      setKeys(snapshot.keys);
      setCredentials(snapshot.credentials);
      setBilling(snapshot.billing);
      setAccount(snapshot.account);
      if (checkoutSuccess && snapshot.account.premium) completeCheckout();
      setLoaded(true);
    } catch (error) {
      if (!redirectIfSignedOut(error)) {
        setPageError(displayError(error, "We could not load your dashboard. Check your connection and try again."));
      }
      setLoaded(true);
    }
  }, [applyContainer, checkoutSuccess, completeCheckout]);

  React.useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  React.useEffect(() => {
    if (!checkoutSuccess || !loaded || account?.premium || checkoutStatus === "confirmed") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let disposed = false;

    const schedule = () => {
      if (!disposed && !document.hidden) {
        timer = setTimeout(() => void pollBilling(), CHECKOUT_POLL_INTERVAL_MS);
      }
    };
    const pollBilling = async () => {
      if (disposed || document.hidden || checkoutPollInFlight.current) return;
      checkoutPollInFlight.current = true;
      let confirmed = false;
      try {
        const result = await api<BillingStatus>("/api/billing/status");
        if (disposed) return;
        setBilling(result);
        setAccount(result.account);
        confirmed = result.account.premium;
        if (confirmed) completeCheckout();
      } catch (error) {
        if (!disposed) redirectIfSignedOut(error);
      } finally {
        checkoutPollInFlight.current = false;
        if (!disposed && !confirmed) {
          attempts += 1;
          if (attempts >= CHECKOUT_POLL_MAX_ATTEMPTS) {
            setCheckoutStatus("timed_out");
          } else {
            schedule();
          }
        }
      }
    };
    const visibilityChanged = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
      } else {
        void pollBilling();
      }
    };

    void pollBilling();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [account?.premium, checkoutPollInFlight, checkoutStatus, checkoutSuccess, completeCheckout, loaded]);

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

  const deploy = async (tier: Tier) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError("");
    try {
      const result = await api<{ container: ContainerView }>("/api/deploy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      refreshNeeded.current = true;
      applyContainer(result.container);
    } catch (error) {
      if (!redirectIfSignedOut(error)) {
        setActionError(displayError(error, "The instance could not be created. Please try again."));
      }
    } finally {
      setActionBusy(false);
    }
  };

  if (!loaded) {
    return <><h1>Your workbench.</h1><div className="card" aria-live="polite" aria-busy="true"><span className="sr-only">Loading your workbench…</span><div className="skel skel-title" /><div className="skel skel-line" /><div className="skel skel-line short" /></div></>;
  }

  return (
    <>
      <div className="dashboard-heading">
        <h1>Your workbench.</h1>
        {account ? <span className={`account-state ${account.state}`}>{ACCOUNT_STATE_LABELS[account.state]}</span> : null}
      </div>
      {checkoutStatus === "confirming" ? (
        <div className="notice" role="status" aria-live="polite">
          Checkout completed. Activating your Premium subscription…
        </div>
      ) : checkoutStatus === "confirmed" ? (
        <div className="notice" role="status" aria-live="polite">
          Your Premium subscription is active.
        </div>
      ) : checkoutStatus === "timed_out" ? (
        <div className="notice warning" role="status" aria-live="polite">
          Checkout completed, but Premium activation is taking longer than expected. <button type="button" className="link-btn" onClick={() => setCheckoutStatus("confirming")}>Check again</button>
        </div>
      ) : null}
      {billing?.billing?.state === "past_due" || billing?.billing?.state === "grace" ? (
        <div className="notice warning" role="status">
          Your payment needs attention. Premium service remains available only through the displayed billing deadline.
        </div>
      ) : null}
      {billing?.billing?.state === "cancel_scheduled" && billing.billing.serviceUntil ? (
        <div className="notice warning" role="status">
          Premium service is scheduled to end on {new Date(billing.billing.serviceUntil).toISOString().slice(0, 10)}. The workbench will then stop before returning to Free limits. Save active work first; persistent files will be retained.
        </div>
      ) : null}
      {billing?.billing?.state === "expired" ? (
        <div className="notice error" role="status">
          Premium access ended. An eligible workbench will stop before returning to Free limits. Unsaved progress may be lost, but persistent files are retained. Resubscribe or complete Free verification to restore eligibility.
        </div>
      ) : null}
      {pageError ? <div className="notice error" role="alert" aria-live="assertive">{pageError} <button type="button" className="link-btn" onClick={() => void loadDashboard()}>Try again</button></div> : null}
      {!pageError && configuration && !container && account ? (
        <section className="instance-creation">
          <fieldset className="instance-tier-picker">
            <legend>Choose a tier</legend>
            <div className="instance-tier-options">
              <label className={`instance-tier-option${selectedTier === "free" ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="instance-tier"
                  value="free"
                  checked={selectedTier === "free"}
                  onChange={() => setSelectedTier("free")}
                />
                <span>
                  <strong>Free</strong>
                  <small>{MACHINE_SPECS.free}</small>
                </span>
              </label>
              <label className={`instance-tier-option${selectedTier === "paid" ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="instance-tier"
                  value="paid"
                  checked={selectedTier === "paid"}
                  onChange={() => setSelectedTier("paid")}
                />
                <span>
                  <strong>Premium</strong>
                  <small>
                    {MACHINE_SPECS.paid}
                    {account.premium || !billing?.paidPlan
                      ? ""
                      : ` · ${billing.paidPlan.currency} ${billing.paidPlan.price}/mo`}
                  </small>
                </span>
              </label>
            </div>
          </fieldset>
          <div className="instance-cta">
            {selectedTier === "free" ? (
              account.verified ? (
                <button className="btn primary" type="button" disabled={actionBusy} onClick={() => void deploy("free")}>
                  Create
                </button>
              ) : (
                <a className="btn primary" href="/verify">Continue</a>
              )
            ) : account.premium ? (
              <button className="btn primary" type="button" disabled={actionBusy} onClick={() => void deploy("paid")}>
                Create
              </button>
            ) : billing?.configured ? (
              <button className="btn primary" type="button" disabled={actionBusy} onClick={() => void openBilling("/api/billing/checkout")}>
                Continue
              </button>
            ) : (
              <button className="btn primary" type="button" disabled>Continue</button>
            )}
            <p className="choice-hint">
              {selectedTier === "free" && !account.verified
                ? "Verify to create a Free instance"
                : selectedTier === "paid" && !account.premium
                  ? "Upgrade to Premium"
                  : ""}
            </p>
          </div>
        </section>
      ) : null}
      {!pageError && configuration && credentials ? (
        <ConfigurationSummary
          configuration={configuration}
          credentials={credentials}
          sshKeyCount={keys.length}
          selectedTier={container?.tier ?? selectedTier}
          editable={!container}
        />
      ) : null}
      {!pageError && container ? (
        <ContainerCard
          container={container}
          action={(operation) => void act(operation)}
          cancelPlacement={() => void cancelPlacement()}
          upgradeOffer={container.status === "running" && container.tier === "free" &&
              account && !account.premium && billing?.configured && billing.paidPlan
            ? { ...billing.paidPlan, trialEligible: billing.trialEligible }
            : null}
          upgrade={() => void openBilling("/api/billing/checkout")}
          actionBusy={actionBusy}
        />
      ) : null}
      {actionError ? <div className="notice error" role="alert" aria-live="assertive">{actionError}</div> : null}
      {container ? <section className="card" aria-labelledby="ssh-heading"><h2 id="ssh-heading">SSH access</h2><div role="status" aria-live="polite"><Connection container={container} hasKeys={keys.length > 0} /></div><SshKeys container={container} keys={keys} refresh={refreshKeysAndConnection} /><div className="sr-only" role="status" aria-live="polite" /></section> : null}
    </>
  );
}

const root = document.getElementById("dashboard-root");
if (root) createRoot(root).render(<DashboardApp />);
