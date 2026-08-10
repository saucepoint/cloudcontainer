import { OTPField } from "@base-ui/react/otp-field";
import type { IDKitNamespace, IDKitRequestConfig } from "@worldcoin/idkit-core";
import { toDataURL } from "qrcode";
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

function usesMobileWorldAppFlow(): boolean {
  return window.matchMedia("(max-width: 700px)").matches;
}

function AccountVerification({ worldIdAvailable }: {
  worldIdAvailable: boolean;
}): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [worldStatus, setWorldStatus] = React.useState("");
  const [worldError, setWorldError] = React.useState(false);
  const [worldQr, setWorldQr] = React.useState("");
  const [inviteStatus, setInviteStatus] = React.useState("");
  const [code, setCode] = React.useState("");
  const worldAttempt = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => worldAttempt.current?.abort(), []);

  const startWorldId = async (): Promise<void> => {
    const mobile = usesMobileWorldAppFlow();
    const mobileTarget = mobile ? window.open("", "_blank") : null;
    if (mobileTarget) mobileTarget.opener = null;
    const controller = new AbortController();
    worldAttempt.current = controller;
    setPending(true);
    setWorldError(false);
    setWorldQr("");
    setWorldStatus("Preparing World ID…");
    try {
      const [{ signal, ...config }, idKit] = await Promise.all([
        postJson<WorldIdRequest>("/api/account/world-id/request"),
        loadIdKit(),
      ]);
      const request = await idKit.requestWithInviteCode(config)
        .constraints(idKit.CredentialRequest("proof_of_human", { signal }));
      if (controller.signal.aborted) return;

      if (mobile) {
        setWorldStatus("Opening World App… Return here after approving the request.");
        if (mobileTarget) mobileTarget.location.replace(request.connectorURI);
        else window.location.assign(request.connectorURI);
      } else {
        setWorldQr(await toDataURL(request.connectorURI, {
          width: 240,
          margin: 1,
          color: { dark: "#20201d", light: "#ffffff" },
        }));
        setWorldStatus("Scan the code with World App and approve the request.");
      }
      const completion = await request.pollUntilCompletion({
        pollInterval: 1_000,
        timeout: 15 * 60_000,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!completion.success) {
        setWorldQr("");
        setWorldError(true);
        setWorldStatus(worldIdErrorMessage(completion.error));
        return;
      }

      setWorldStatus("Confirming World ID proof…");
      await postJson("/api/account/world-id/verify", completion.result);
      window.location.assign("/account/continue");
    } catch (error) {
      if (!controller.signal.aborted) {
        mobileTarget?.close();
        setWorldQr("");
        setWorldError(true);
        setWorldStatus(worldIdServerError(error));
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
    setInviteStatus("Checking invite…");
    try {
      const result = await postJson<{ redirect: string }>("/api/account/invite/verify", { code });
      window.location.assign(result.redirect);
    } catch (error) {
      setInviteStatus(errorMessage(error, "The invite could not be verified."));
      setPending(false);
    }
  };

  return (
    <>
      {worldIdAvailable ? (
        <section className="card verification-option" aria-labelledby="world-id-heading">
          <h2 id="world-id-heading">Verify with World ID</h2>
          <p>Prove you are a unique person without sharing your identity.</p>
          <button className="btn primary" type="button" disabled={pending} onClick={() => void startWorldId()}>Continue with World ID →</button>
          <p className={`verification-status ${worldError ? "error" : "muted"}`} role={worldError ? "alert" : "status"} aria-live="polite">{worldStatus}</p>
          {worldQr ? (
            <div className="world-id-qr">
              <img src={worldQr} alt="QR code to continue verification in World App" />
              <p className="muted">Keep this page open while you scan.</p>
            </div>
          ) : null}
        </section>
      ) : null}
      <section className="card verification-option" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Use an invite code</h2>
        <p>Have an invite code?</p>
        <form className="auth-code-row" onSubmit={(event) => void useInvite(event)}>
          <label className="sr-only" htmlFor="invite-code">Invite code</label>
          <OTPField.Root
            id="invite-code"
            className="otp-field"
            autoComplete="one-time-code"
            disabled={pending}
            inputMode="text"
            length={8}
            normalizeValue={(value) => value.toUpperCase()}
            required
            validationType="alphanumeric"
            value={code}
            onValueChange={(value) => setCode(value)}
          >
            {Array.from({ length: 8 }, (_, index) => (
              <OTPField.Input
                key={index}
                aria-label={index === 0 ? "Invite code" : `Invite code character ${index + 1}`}
              />
            ))}
          </OTPField.Root>
          <button className="btn secondary" type="submit" disabled={pending}>Verify invite →</button>
        </form>
        <p className="muted verification-status" role="status" aria-live="polite">{inviteStatus}</p>
      </section>
    </>
  );
}

const root = document.getElementById("account-verification-root");
if (root) {
  const worldIdAvailable = root.dataset.worldIdAvailable === "true";
  createRoot(root).render(
    <AccountVerification worldIdAvailable={worldIdAvailable} />,
  );
}
