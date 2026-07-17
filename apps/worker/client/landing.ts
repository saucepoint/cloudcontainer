export {};

const QRCODE_ESM = "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";
const element = (id: string): any => document.getElementById(id);
const btn = element('worldid-btn');
const status = element('worldid-status');
const qrWrap = element('worldid-qr');
const environment = btn?.dataset.worldIdEnvironment;
const WORLD_ID_SESSION_ID_RE = /^session_[0-9a-f]{128}$/i;

async function startWorldIdSignIn() {
  if (typeof IDKit === 'undefined') {
    status.textContent = 'Could not load World ID. Check your connection and reload.';
    return;
  }
  btn.disabled = true;
  status.textContent = 'Connecting to World ID…';
  qrWrap.replaceChildren();
  try {
    const contextRes = await fetch('/auth/session/rp-context');
    const context = await contextRes.json().catch(() => ({}));
    if (!contextRes.ok) throw new Error(context.error || 'Could not start World ID sign-in.');
    const { app_id, rp_context } = context;
    let savedSessionId: string | null = null;
    try {
      const stored = localStorage.getItem('cs_world_id_session');
      if (stored && WORLD_ID_SESSION_ID_RE.test(stored)) {
        savedSessionId = stored;
      } else if (stored) {
        // Older builds could leave a non-v4 value here. IDKit.proveSession rejects
        // it before a request is created, which otherwise makes login look stuck.
        localStorage.removeItem('cs_world_id_session');
      }
    } catch (_) {}
    const config = { app_id, rp_context, environment: environment };
    const builder = savedSessionId
      ? IDKit.proveSession(savedSessionId, config)
      : IDKit.createSession(config);
    // World App expects a constraint tree even with only one acceptable
    // credential. The documented session request wraps proof-of-human in
    // any(...); omitting that wrapper produces a different bridge payload
    // that some World App clients reject before they can authorize.
    const request = await builder.constraints(
      IDKit.any(IDKit.CredentialRequest('proof_of_human')),
    );

    if (request.connectorURI) {
      if (/Mobi|Android/i.test(navigator.userAgent)) {
        status.textContent = 'Opening World App…';
        window.location.href = request.connectorURI;
      } else {
        status.textContent = 'Scan with World App';
        const { default: QRCode } = await import(QRCODE_ESM);
        const canvas = document.createElement('canvas');
        qrWrap.appendChild(canvas);
        await QRCode.toCanvas(canvas, request.connectorURI, { width: 220, margin: 1 });
      }
    }

    const completion = await request.pollUntilCompletion({ timeout: 180000 });
    if (!completion.success) {
      // World App sometimes presents a generic error without exposing its
      // protocol code in the native UI. Record only that code and the opaque
      // bridge request ID; never send the proof, session ID, or user data.
      try {
        await fetch('/auth/session/failure', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: completion.error, request_id: request.requestId }),
          keepalive: true,
        });
      } catch (_) {}
      const messages = {
        timeout: 'Timed out waiting for World App.',
        cancelled: 'Cancelled in World App.',
        user_rejected: 'Cancelled in World App.',
        verification_rejected: 'Cancelled in World App.',
        invalid_network: 'World ID environment mismatch. This site must use production with the real World App.',
        invalid_rp_signature: 'World ID rejected this site’s RP signing key.',
        unknown_rp: 'World ID does not recognize this site’s RP ID.',
        inactive_rp: 'This site’s World ID registration is not active yet.',
        world_id_4_not_available: 'Your World App does not have a World ID 4.0 credential yet.',
        credential_unavailable: 'Your World App does not have the required proof-of-human credential.',
        malformed_request: 'World ID rejected this site’s request configuration.',
        connection_failed: 'The connection to World App was lost. Please try again.',
        failed_by_host_app: 'World App could not process this request. Please try again.',
        generic_error: 'World App could not process this request. Please try again.',
        unexpected_response: 'World App returned an unexpected response. Please try again.',
        duplicate_nonce: 'This World ID request was already used. Please start again.',
        timestamp_too_old: 'This World ID request expired. Please start again.',
        timestamp_too_far_in_future: 'Your device time appears incorrect. Please correct it and try again.',
        invalid_timestamp: 'Your device time appears incorrect. Please correct it and try again.',
      };
      throw new Error((messages as Record<string, string>)[completion.error] || ('World ID error: ' + completion.error));
    }

    status.textContent = 'Verifying…';
    qrWrap.replaceChildren();
    const res = await fetch('/auth/session/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idkitResponse: completion.result }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Sign-in failed.');

    try { localStorage.setItem('cs_world_id_session', completion.result.session_id); } catch (_) {}
    location.href = json.redirect;
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : 'Something went wrong. Please try again.';
    btn.disabled = false;
  }
}

btn.addEventListener('click', startWorldIdSignIn);
