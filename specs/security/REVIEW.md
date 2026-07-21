# Security Review: architecture-debt-cleanup

- **Merge base:** `19f3feef04f40155c0707d2cd5b21a1150ea055f`
- **Scope:** `main...feat/architecture-debt-cleanup`
- **Result:** FAIL — independent review cap exhausted with unresolved high-confidence findings

## Data-flow review

### Worker request input

All Worker requests now cross Hono's streaming-aware body-limit middleware before route parsing. The 256 KiB cap is larger than the current maximum combined credential input while preventing route handlers from buffering an unbounded body. Daemon `/jobs` requests are independently bounded at the shared 1 MiB aggregate wire budget before signature verification or body reads. Other oversized POST paths remain an unresolved pre-authentication buffering gap. Credential plaintext, sealed payloads, and complete job requests have aligned aggregate UTF-8 schema budgets, but SSH key strings still need matching UTF-8 byte enforcement.

### Authentication and authorization

No route authentication requirements were removed or reordered. The new browser `HttpError` status handling only controls client redirection; server-side `requireUser`, credential-setup, revocation, invite, passkey, and signed-daemon checks remain authoritative.

### SQL injection / IDOR

No caller-controlled SQL fragments were added. New and changed D1 statements are developer-authored constants with bound values. Provisioning and key/account operations continue to derive ownership from the authenticated session rather than caller-supplied user IDs. Lifecycle admission verifies the observed container state and active-job set atomically. Terminal transitions, metadata writes, destroy cleanup, drift correction, and capacity release use latest-job/state-gated D1 batches; stale host snapshots and concurrent actions cannot overwrite state or release accounting twice. Missing-host reservations remain owned until retry or atomic destroy. Waitlisted account deletion and the guarded purge share one transaction and return HTTP 409 if host admission wins the race.

### Command injection and paths

GitHub repository names still cross the shared `GithubReposSchema` and are shell-quoted before `gh repo clone`. The new validation rejects duplicate case-insensitive repository basenames before any Incus operation. It does not add an unquoted shell or filesystem sink.

### XSS and browser transport

The shared browser transport parses JSON and surfaces error strings through React text nodes or `textContent`; it does not use `innerHTML`. `dangerouslySetInnerHTML` receives only the static, developer-authored `PAGE_STYLES` string moved byte-for-byte from the previous layout module.

### Secrets and logging

The diff contains no private keys or recognizable cloud/token prefixes. Credential delivery remains stdin/sealed-payload based. Changed logs adjust severity only and do not add credential values. External OAuth failures continue to log endpoint status or error kind, not response bodies or tokens.

### Supply chain

`@hono/node-server` was upgraded from vulnerable 1.x to 2.0.11. The documented v2 breaking changes (Node 18 removal and Vercel-adapter removal) do not affect this Node 22 daemon. The advisory database now reports three inherited high-severity `sharp@0.34.5`/libvips findings through Wrangler/Miniflare; npm currently suggests only a forced Wrangler downgrade.

## Scanner evidence

- Added-line secret marker scan: no matches.
- Added unsafe sink scan (`innerHTML`, `document.write`, `eval`, dynamic execution): no matches.
- Added SQL interpolation scan: no matches.
- Added outbound fetches: one shared browser same-origin transport, with paths supplied by application code.
- Initial `npm audit --json`: `total: 0`; final `npm audit --audit-level=low`: three high-severity findings.

## Findings

1. Desired-state key/credential sync jobs need revision ordering so delayed old snapshots cannot overwrite newer state.
2. SSH key limits need UTF-8 byte enforcement consistent with the aggregate job budget.
3. Daemon pre-authentication body limiting must cover every POST path, not only `/jobs`.
4. The newly published inherited `sharp`/libvips advisories require an upstream-compatible dependency resolution or explicit release decision.
5. Generic `Error("not found")` should be replaced by typed Incus not-found classification.
