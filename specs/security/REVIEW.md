# Security review: GitHub auth simplification

- **Merge base:** `main` at `8abfff6`
- **Scope:** Worker GitHub routes/UI/config, daemon GitHub credential installation, tests, and documentation
- **Result:** PASS — no findings at confidence 8/10 or higher

## Trust-boundary review

- The connection route still requires an authenticated Codestation user and checks that credentials remain changeable.
- The App slug is configuration-only and validated against a slug allowlist before it reaches the GitHub redirect URL.
- `return_to` remains allowlisted to `/onboarding` or `/dashboard`; arbitrary redirect destinations are not stored.
- OAuth state uses Web Crypto randomness, expires, is consumed once, and is bound to the current Codestation user before token exchange.
- Existing encrypted credentials are no longer revoked or cleared before a replacement callback succeeds.
- Access and refresh tokens remain encrypted in D1; only the short-lived access token crosses the sealed host boundary.
- The daemon command added for `gh auth setup-git` is constant and contains no user-controlled input or token value.
- Git now obtains the token through `gh auth git-credential`; the duplicate `.git-credentials` copy is removed.

## Categories checked

- Authentication/authorization bypass: no finding
- OAuth CSRF/open redirect: no finding
- Secrets exposure/logging: no finding; on-host token duplication is reduced
- Command injection: no finding
- SSRF: no new user-controlled host or protocol
- SQL injection: no new dynamic SQL
- XSS: JSX remains escaped and client rendering uses `textContent`
