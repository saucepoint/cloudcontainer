import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

type AuthFlow = (element: HTMLElement, done: () => void) => void;
type DeviceStart = {
  verificationUrl: string;
  expiresInSec: number;
  intervalSec?: number;
  userCode: string;
  deviceAuthId?: string;
  deviceCode?: string;
};
type DeviceConfig = {
  contacting: string;
  signInHint: string;
  startPath: string;
  pollPath: string;
  pollBody: (start: DeviceStart) => object;
};
type PasteConfig = {
  startPath: string;
  finishPath: string;
  openLabel: string;
  step1: string;
  step2: string;
  inputId: string;
  inputLabel: string;
  placeholder: string;
  emptyError: string;
  finishBody: (value: string) => object;
};

let active = false;
let activeRoot: Root | null = null;

export const isAuthFlowActive = () => active;

async function api<T extends object>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(json.error || `request failed: ${response.status}`);
  return json;
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : "Unknown error";
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function SpinnerMessage({ children }: { children: React.ReactNode }) {
  return <p className="muted"><span className="spinner" aria-hidden="true" />{children}</p>;
}

function DeviceFlow({ config, complete }: { config: DeviceConfig; complete: () => void }) {
  const [start, setStart] = React.useState<DeviceStart | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api<DeviceStart>(config.startPath);
        if (cancelled) return;
        setStart(next);
        const deadline = Date.now() + next.expiresInSec * 1_000;
        while (!cancelled && Date.now() < deadline) {
          await sleep((next.intervalSec || 5) * 1_000);
          if (cancelled) return;
          const poll = await api<{ status?: string }>(config.pollPath, config.pollBody(next));
          if (poll.status === "connected") {
            complete();
            return;
          }
        }
        if (!cancelled) {
          active = false;
          setError("The code expired — click the sign-in button to get a new one.");
        }
      } catch (caught) {
        if (!cancelled) {
          active = false;
          setError(messageOf(caught));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [complete, config]);

  if (error) return <p className="err" role="alert">{error}</p>;
  if (!start) return <SpinnerMessage>{config.contacting}</SpinnerMessage>;
  return (
    <>
      <ol style={{ margin: "0.6rem 0 0.6rem 1.2rem" }}>
        <li>Open <a href={start.verificationUrl} target="_blank" rel="noreferrer">{start.verificationUrl}</a>{config.signInHint}</li>
        <li>Enter this one-time code (expires in {Math.round(start.expiresInSec / 60)} minutes)</li>
      </ol>
      <pre className="ssh">{start.userCode}</pre>
      <SpinnerMessage>Waiting for approval…</SpinnerMessage>
    </>
  );
}

function PasteFlow({ config, complete }: { config: PasteConfig; complete: () => void }) {
  const [authorizeUrl, setAuthorizeUrl] = React.useState("");
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void api<{ authorizeUrl: string }>(config.startPath)
      .then((result) => { if (!cancelled) setAuthorizeUrl(result.authorizeUrl); })
      .catch((caught) => {
        if (!cancelled) {
          active = false;
          setError(messageOf(caught));
        }
      });
    return () => { cancelled = true; };
  }, [config]);

  const connect = async () => {
    const normalized = value.trim();
    if (!normalized) {
      setError(config.emptyError);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(config.finishPath, config.finishBody(normalized));
      complete();
    } catch (caught) {
      setBusy(false);
      setError(messageOf(caught));
    }
  };

  if (!authorizeUrl && !error) return <SpinnerMessage>Preparing sign-in…</SpinnerMessage>;
  if (!authorizeUrl) return <p className="err" role="alert">{error}</p>;
  return (
    <>
      <ol style={{ margin: "0.6rem 0 0.6rem 1.2rem" }}>
        <li><a href={authorizeUrl} target="_blank" rel="noreferrer">{config.openLabel}</a>{config.step1}</li>
        <li>{config.step2}</li>
      </ol>
      <label htmlFor={config.inputId}>{config.inputLabel}</label>
      <input type="text" id={config.inputId} autoComplete="off" spellCheck={false} placeholder={config.placeholder} value={value} onChange={(event) => setValue(event.target.value)} />
      <div className="row"><button type="button" className="btn" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button></div>
      <div className="err" role="alert" aria-live="assertive">{error}</div>
    </>
  );
}

function mountFlow(element: HTMLElement, done: () => void, view: (complete: () => void) => React.ReactNode) {
  activeRoot?.unmount();
  active = true;
  const root = createRoot(element);
  activeRoot = root;
  const complete = () => {
    active = false;
    activeRoot = null;
    root.unmount();
    done();
  };
  root.render(view(complete));
}

const deviceFlow = (config: DeviceConfig): AuthFlow => (element, done) => {
  mountFlow(element, done, (complete) => <DeviceFlow config={config} complete={complete} />);
};

const pasteFlow = (config: PasteConfig): AuthFlow => (element, done) => {
  mountFlow(element, done, (complete) => <PasteFlow config={config} complete={complete} />);
};

export const codexDeviceFlow = deviceFlow({
  contacting: "Contacting OpenAI…",
  signInHint: " and sign in to ChatGPT",
  startPath: "/api/codex/device",
  pollPath: "/api/codex/device/poll",
  pollBody: (start) => ({ deviceAuthId: start.deviceAuthId, userCode: start.userCode }),
});

export const copilotDeviceFlow = deviceFlow({
  contacting: "Contacting GitHub…",
  signInHint: " and sign in to GitHub",
  startPath: "/api/copilot/device",
  pollPath: "/api/copilot/device/poll",
  pollBody: (start) => ({ deviceCode: start.deviceCode }),
});

export const claudeOauthFlow = pasteFlow({
  startPath: "/api/claude/oauth/start",
  finishPath: "/api/claude/oauth/finish",
  openLabel: "Open claude.ai",
  step1: ", sign in, and approve access",
  step2: "Claude shows an authorization code — copy it and paste it below",
  inputId: "claude-oauth-code",
  inputLabel: "Authorization code",
  placeholder: "code#state",
  emptyError: "Paste the code Claude showed you after approving.",
  finishBody: (value) => ({ code: value }),
});

export const wranglerOauthFlow = pasteFlow({
  startPath: "/api/wrangler/oauth/start",
  finishPath: "/api/wrangler/oauth/finish",
  openLabel: "Open the Cloudflare dashboard",
  step1: " and allow Wrangler access",
  step2: "Your browser then lands on a localhost page that will not load — that is expected. Copy the full address from the address bar and paste it below",
  inputId: "wrangler-callback-url",
  inputLabel: "Address your browser was sent to",
  placeholder: "http://localhost:8976/oauth/callback?code=…",
  emptyError: "Paste the localhost address from your browser.",
  finishBody: (value) => ({ callbackUrl: value }),
});
