import { Dialog } from "@base-ui/react/dialog";
import type { IDKitNamespace, IDKitRequestConfig } from "@worldcoin/idkit-core";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { errorMessage, HttpError, postJson } from "./http.js";

const IDKIT_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/@worldcoin/idkit-core@4.2.2/dist/idkit.global.js";
const IDKIT_SCRIPT_INTEGRITY = "sha384-wtTjSVoogvsjcb8jv/IHW/gmWmkOhvCWFu6lUUqFX2jSOIWlCMczwjd0YtMy8+so";

type WorldIdRequest = IDKitRequestConfig & { signal: string };

declare global {
  interface Window {
    IDKit?: IDKitNamespace;
  }
}

let idKitScriptPromise: Promise<IDKitNamespace> | undefined;

function loadIdKit(): Promise<IDKitNamespace> {
  if (window.IDKit) return Promise.resolve(window.IDKit);
  if (idKitScriptPromise) return idKitScriptPromise;

  idKitScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = IDKIT_SCRIPT_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.integrity = IDKIT_SCRIPT_INTEGRITY;
    script.addEventListener("load", () => {
      if (window.IDKit) resolve(window.IDKit);
      else reject(new Error("World ID SDK did not initialize (sdk_init_failed)."));
    }, { once: true });
    script.addEventListener("error", () => {
      idKitScriptPromise = undefined;
      reject(new Error("World ID SDK could not be loaded (sdk_load_failed)."));
    }, { once: true });
    document.head.append(script);
  });

  return idKitScriptPromise;
}

function worldIdErrorMessage(code: string): string {
  switch (code) {
    case "credential_unavailable":
    case "world_id_4_not_available":
      return `This World ID does not have the required Proof of Human credential (${code}).`;
    case "max_verifications_reached":
    case "nullifier_replayed":
      return `This World ID has already been used for this verification (${code}).`;
    case "connection_failed":
    case "timeout":
      return `World ID could not complete the connection. Try again (${code}).`;
    case "user_rejected":
    case "verification_rejected":
    case "cancelled":
      return `World ID verification was cancelled (${code}).`;
    default:
      return `World ID verification failed (${code}). Refresh the page and try again.`;
  }
}

function worldIdServerError(error: unknown): string {
  if (error instanceof HttpError && error.code) return `${error.message} (${error.code})`;
  return errorMessage(error, "World ID is unavailable (unexpected_error).");
}

function AccountVerification({ worldIdAvailable }: { worldIdAvailable: boolean }): React.JSX.Element {
  const [worldUrl, setWorldUrl] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [code, setCode] = React.useState("");
  const worldAttempt = React.useRef<AbortController | null>(null);

  const cancelWorldId = (): void => {
    worldAttempt.current?.abort();
    worldAttempt.current = null;
    setWorldUrl("");
    setPending(false);
    setStatus("World ID verification was cancelled (cancelled).");
  };

  React.useEffect(() => () => worldAttempt.current?.abort(), []);

  const startWorldId = async (): Promise<void> => {
    const controller = new AbortController();
    worldAttempt.current = controller;
    setPending(true);
    setStatus("Preparing World ID…");
    try {
      const [{ signal, ...config }, idKit] = await Promise.all([
        postJson<WorldIdRequest>("/api/account/world-id/request"),
        loadIdKit(),
      ]);
      const request = await idKit.requestWithInviteCode(config)
        .constraints(idKit.CredentialRequest("proof_of_human", { signal }));
      if (controller.signal.aborted) return;

      setWorldUrl(request.connectorURI);
      setStatus("Open World ID and approve the request. This page will update automatically.");
      const completion = await request.pollUntilCompletion({
        pollInterval: 1_000,
        timeout: 15 * 60_000,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!completion.success) {
        setWorldUrl("");
        setStatus(worldIdErrorMessage(completion.error));
        return;
      }

      setStatus("Confirming World ID proof…");
      await postJson("/api/account/world-id/verify", completion.result);
      window.location.assign("/account/continue");
    } catch (error) {
      if (!controller.signal.aborted) {
        setWorldUrl("");
        setStatus(worldIdServerError(error));
      }
    } finally {
      if (worldAttempt.current === controller) {
        worldAttempt.current = null;
        setPending(false);
      }
    }
  };

  const useInvite = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setStatus("Checking invite…");
    try {
      const result = await postJson<{ redirect: string }>("/api/account/invite/verify", { code });
      window.location.assign(result.redirect);
    } catch (error) {
      setStatus(errorMessage(error, "The invite could not be verified."));
      setPending(false);
    }
  };

  return (
    <>
      {worldIdAvailable ? (
        <section className="card verification-option" aria-labelledby="world-id-heading">
          <h2 id="world-id-heading">Verify with World ID</h2>
          <p>Prove you are a unique person without sharing your identity.</p>
          <button className="btn" type="button" disabled={pending} onClick={() => void startWorldId()}>Continue with World ID →</button>
        </section>
      ) : null}
      <section className="card verification-option" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Use an invite code</h2>
        <p>Enter a single-use invite from the usebench.dev administrator.</p>
        <form className="auth-code-row" onSubmit={(event) => void useInvite(event)}>
          <input aria-label="Invite code" autoComplete="one-time-code" disabled={pending} maxLength={8} minLength={8} pattern="[A-Za-z0-9]{8}" required value={code} onChange={(event) => setCode(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())} />
          <button className="btn secondary" type="submit" disabled={pending}>Verify invite →</button>
        </form>
      </section>
      <p className="muted verification-status" role="status" aria-live="polite">{status}</p>
      {worldIdAvailable ? (
        <Dialog.Root open={Boolean(worldUrl)} onOpenChange={(open) => { if (!open) cancelWorldId(); }}>
          <Dialog.Portal>
            <Dialog.Backdrop className="dialog-backdrop" />
            <Dialog.Viewport className="dialog-viewport">
              <Dialog.Popup className="dialog-popup">
                <Dialog.Title className="dialog-title">Continue with World ID</Dialog.Title>
                <Dialog.Description className="dialog-description">
                  Open the secure World verification page, then follow its instructions in World App.
                </Dialog.Description>
                <div className="dialog-actions">
                  <Dialog.Close className="btn secondary">Cancel</Dialog.Close>
                  <a className="btn" href={worldUrl} rel="noopener noreferrer" target="_blank">Open World ID →</a>
                </div>
              </Dialog.Popup>
            </Dialog.Viewport>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}

const root = document.getElementById("account-verification-root");
if (root) {
  const worldIdAvailable = root.dataset.worldIdAvailable === "true";
  createRoot(root).render(<AccountVerification worldIdAvailable={worldIdAvailable} />);
}
