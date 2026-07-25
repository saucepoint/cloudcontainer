import { IDKitRequestWidget, proofOfHuman, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { postJson } from "./http.js";

interface WorldIdRequest {
  appId: `app_${string}`;
  action: string;
  environment: "production" | "staging";
  signal: string;
  rpContext: RpContext;
}

function AccountVerification(): React.JSX.Element {
  const [worldRequest, setWorldRequest] = React.useState<WorldIdRequest | null>(null);
  const [worldOpen, setWorldOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [code, setCode] = React.useState("");

  const startWorldId = async (): Promise<void> => {
    setPending(true);
    setStatus("Preparing World ID…");
    try {
      const request = await postJson<WorldIdRequest>("/api/account/world-id/request");
      setWorldRequest(request);
      setWorldOpen(true);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "World ID is unavailable.");
    } finally {
      setPending(false);
    }
  };

  const useInvite = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const normalized = code.replace(/[^a-z0-9]/gi, "").toUpperCase();
    setCode(normalized);
    if (!/^[A-Z0-9]{8}$/.test(normalized)) {
      setStatus("Enter the eight letters and numbers from your invite.");
      return;
    }
    setPending(true);
    setStatus("Checking invite…");
    try {
      const result = await postJson<{ redirect: string }>("/api/account/invite/verify", { code: normalized });
      window.location.assign(result.redirect);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The invite could not be verified.");
      setPending(false);
    }
  };

  return (
    <>
      <section className="card verification-option" aria-labelledby="world-id-heading">
        <h2 id="world-id-heading">Verify with World ID</h2>
        <p>Prove you are a unique person without sharing your identity.</p>
        <button className="btn" type="button" disabled={pending} onClick={() => void startWorldId()}>Continue with World ID →</button>
      </section>
      <section className="card verification-option" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Use an invite code</h2>
        <p>Enter a single-use invite from the usebench.dev administrator.</p>
        <form className="auth-code-row" onSubmit={(event) => void useInvite(event)}>
          <input aria-label="Invite code" autoComplete="one-time-code" disabled={pending} maxLength={8} minLength={8} pattern="[A-Za-z0-9]{8}" required value={code} onChange={(event) => setCode(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())} />
          <button className="btn secondary" type="submit" disabled={pending}>Verify invite →</button>
        </form>
      </section>
      <p className="muted verification-status" role="status" aria-live="polite">{status}</p>
      {worldRequest ? (
        <IDKitRequestWidget
          open={worldOpen}
          onOpenChange={setWorldOpen}
          app_id={worldRequest.appId}
          action={worldRequest.action}
          environment={worldRequest.environment}
          rp_context={worldRequest.rpContext}
          allow_legacy_proofs
          preset={proofOfHuman({ signal: worldRequest.signal })}
          handleVerify={async (proof: IDKitResult) => { await postJson("/api/account/world-id/verify", { proof }); }}
          onSuccess={() => window.location.assign("/account/continue")}
          onError={() => setStatus("World ID verification was not completed.")}
        />
      ) : null}
    </>
  );
}

const root = document.getElementById("account-verification-root");
if (root) createRoot(root).render(<AccountVerification />);
