# Security review: authentication and World ID cleanup

**Scope:** `main...refactor/auth-world-id-cleanup`  
**Result:** PASS — no findings at confidence ≥ 8/10

## Data-flow review

### Authentication

- Better Auth remains mounted at `/api/auth/*`; session loading and `requireAccount` / `requireUser` authorization are unchanged.
- Social provider and trusted-linking configuration now contains only Google and GitHub. Passkey registration still requires a short-lived HMAC-signed server context.
- Removing Apple bindings and UI does not create a fallback authentication path or alter generic account-row deletion.

### World ID

- Both World ID endpoints require an authenticated account.
- The Worker creates signed RP context server-side and the browser requests only a World ID 4 `proof_of_human` credential; legacy v3 proofs are rejected before external I/O.
- Submitted proofs must match the configured action, environment, and the hash of the authenticated internal user ID before they reach the fixed `developer.world.org` verifier host.
- The verifier URL is derived only from a validated `rp_...` configuration value; users cannot control its scheme or host.
- D1 statements are developer-authored SQL with bound parameters. Nullifier insertion and account verification remain one batch; duplicate nullifiers cannot verify another user.
- Storage failures now propagate as 500 rather than being mislabeled as proof reuse. Upstream 5xx/malformed responses become 502; user proof failures remain 400.
- The raw proof is bounded by the Worker's 256 KiB body middleware and forwarded unchanged only after local binding checks.

### Browser and dependencies

- React renders all dynamic text; no unsafe HTML sinks were added.
- The pinned IDKit CDN asset retains a verified SHA-384 SRI hash and `crossOrigin="anonymous"`.
- `npm audit --audit-level=high` reports zero vulnerabilities after the lockfile-only PostCSS update.

## Findings

No SQL injection, XSS, SSRF, authorization bypass, IDOR, unsafe deserialization, weak cryptography, or secret-exposure finding met the 8/10 reporting threshold.
