# Security Review: architecture-debt-cleanup

- **Merge base:** `19f3feef04f40155c0707d2cd5b21a1150ea055f`
- **Scope:** `main...feat/architecture-debt-cleanup`
- **Result:** PASS — no findings at confidence 8/10 or higher

## Data-flow review

### Worker request input

All requests now cross Hono's streaming-aware body-limit middleware before route parsing. The 256 KiB cap is larger than the current maximum combined credential input while preventing route handlers from buffering an unbounded body. Existing route-level schema/type validation remains in place.

### Authentication and authorization

No route authentication requirements were removed or reordered. The new browser `HttpError` status handling only controls client redirection; server-side `requireUser`, credential-setup, revocation, invite, passkey, and signed-daemon checks remain authoritative.

### SQL injection / IDOR

No dynamic SQL fragments were added. New and changed D1 statements are developer-authored constants with bound values. Provisioning and key/account operations continue to derive ownership from the authenticated session rather than caller-supplied user IDs.

### Command injection and paths

GitHub repository names still cross the shared `GithubReposSchema` and are shell-quoted before `gh repo clone`. The new validation rejects duplicate case-insensitive repository basenames before any Incus operation. It does not add an unquoted shell or filesystem sink.

### XSS and browser transport

The shared browser transport parses JSON and surfaces error strings through React text nodes or `textContent`; it does not use `innerHTML`. `dangerouslySetInnerHTML` receives only the static, developer-authored `PAGE_STYLES` string moved byte-for-byte from the previous layout module.

### Secrets and logging

The diff contains no private keys or recognizable cloud/token prefixes. Credential delivery remains stdin/sealed-payload based. Changed logs adjust severity only and do not add credential values. External OAuth failures continue to log endpoint status or error kind, not response bodies or tokens.

### Supply chain

`@hono/node-server` was upgraded from vulnerable 1.x to 2.0.11. The documented v2 breaking changes (Node 18 removal and Vercel-adapter removal) do not affect this Node 22 daemon. `npm audit` reports zero info, low, moderate, high, or critical vulnerabilities.

## Scanner evidence

- Added-line secret marker scan: no matches.
- Added unsafe sink scan (`innerHTML`, `document.write`, `eval`, dynamic execution): no matches.
- Added SQL interpolation scan: no matches.
- Added outbound fetches: one shared browser same-origin transport, with paths supplied by application code.
- `npm audit --json`: `total: 0`.

## Findings

None.
