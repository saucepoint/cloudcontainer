# Project Context

## Stack

- Node.js 22 TypeScript npm workspace with strict ESM and three workspaces.
- `packages/contract`: Zod wire schemas plus Noble-based Ed25519, X25519, HKDF, and XChaCha20-Poly1305 cryptography shared by both runtimes.
- `apps/worker`: Hono SSR and JSON control plane on Cloudflare Workers, with D1, KV sessions, Cron reconciliation, static client bundles built by esbuild, and React/Hono JSX views.
- `apps/daemon`: Hono on Node.js under systemd, exposing signed host RPC and operating Incus through an injectable command runner.
- `infra`: Bash host bootstrap, image build, multi-tenant policy, audit, deployment, and operations documentation.
- Vitest tests run in Node. Worker persistence tests use in-memory `node:sqlite`, real D1 migrations, Map-backed KV, and intercepted `fetch`; daemon tests inject command execution.

## Architecture

### Control plane

HTTP routes in `apps/worker/src/index.tsx` mount identity, onboarding, lifecycle, credential, GitHub, and subscription route modules. Route handlers read and validate user input, write D1/KV, and delegate provisioning or lifecycle work to the job module.

Primary lifecycle flow:

`Hono route -> placement/job module -> signed daemon adapter -> daemon job runner -> provisioner -> Incus adapter`

D1 is the durable source of truth for users, environments, placement, jobs, and encrypted credentials. KV is only the application-session cache. The Cron reconciler polls recent daemon jobs, enforces timeouts, refreshes host health and GitHub tokens, admits the FIFO waitlist, expires suspended environments, and corrects D1/Incus drift.

### Host daemon

`apps/daemon/src/index.ts` verifies every request with the shared Ed25519 protocol before exposing health, stats, submission, and status routes. `JobRunner` provides in-memory idempotency and per-container serialization. `Provisioner` owns lifecycle ordering. `Incus` is the local CLI adapter; `CredentialInstaller` owns host-sealed secret handling and in-container credential files.

### Browser

Hono JSX renders the initial pages. Independent esbuild entry points progressively enhance landing authentication, onboarding, account security, shared dialogs/details, and the dashboard. The dashboard performs one aggregate bootstrap request, then container-only polling while state is transitional.

### Shared contract

`@workbench/contract` is the protocol seam between Worker and daemon. Its schemas are authoritative for job requests and daemon responses. Changes here require daemon-first rolling compatibility or a coordinated release.

## Conventions Observed

- Two-space indentation, double quotes, semicolons, trailing commas, `.js` relative imports, and type-only imports.
- Strict TypeScript includes unused-symbol, unchecked-index, exact-optional, implicit-return, and switch-fallthrough checks.
- Errors crossing user or RPC seams are short and sanitized; structured JSON events are logged.
- External calls use explicit timeouts and are mocked in tests.
- D1 race-sensitive writes use conditional SQL and batches rather than read-then-write checks.
- Credential plaintext is decrypted only in memory and is sealed before host delivery; host writes use stdin rather than argv or temporary host files.
- Tests generally exercise public HTTP or module interfaces rather than private helpers.

## Signals / Active Considerations

### Strong foundations

- Verification is green: 24 test files / 332 tests, all workspace type checks, lint, the browser build, the release dry-run, and `npm audit` pass.
- No `any`, TypeScript suppression, TODO, FIXME, or HACK markers were found in production TypeScript.
- Security-sensitive random values use Web Crypto, admin-secret comparison uses fixed-size hashes, and Worker observability is enabled.

### Cleanup outcomes

- All Worker requests are bounded at 256 KiB before route handlers buffer JSON. Daemon job requests are streaming-bounded at the shared 1 MiB aggregate wire limit before signature verification or body buffering.
- Timed-out lifecycle jobs consistently move their environment to visible `error`; background job timeouts remain isolated from environment state and failed desired-state syncs retry with an hourly backoff. Queued dispatch cannot be failed or resurrected by concurrent polling. Lifecycle insertion validates its container snapshot atomically; terminal state, metadata, destroy cleanup, and accounting changes are latest-job-gated batches that reject concurrent/stale operations.
- Placement retries only host-port and capacity contention. Port-exhausted hosts are skipped in favor of another eligible host. A failure after direct placement or waitlist admission is surfaced and records a sanitized error state instead of masquerading as an idempotent duplicate.
- Selected-agent metadata, operational existence-probe failures, and command-level read failures now fail daemon jobs instead of silently reporting incomplete success. Start/stop retries first inspect Incus desired state, so setup can resume after partial completion without repeating a completed transition.
- Repository selections with colliding `~/repos/<name>` targets fail before any Incus mutation.
- Shared browser HTTP, clipboard, WebAuthn-error, confirmation, dashboard-model, and SSH presentation modules replaced entry-point duplication. `client/dashboard.tsx` is now the 224-line orchestration entry.
- The page stylesheet is isolated from the 46-line document layout module with byte-identical rendered CSS.
- Wrangler type generation ignores local secret files, preventing workstation-specific stale binding names.
- The production-dead `quarantinePort` helper and unnecessary internal exports/assertions were removed.
- Failure events use warning/error severity while successful drift correction and startup remain informational.
- `@hono/node-server` is on patched v2, Wrangler/workerd and compatible minor dependencies are current, and the compatibility date is current.

### Retained compatibility surface

- Paid-tier, `resize`, and `export-window` protocol/daemon branches have no current-release caller. They are intentionally retained as future compatibility scaffolding by product decision; removal would require a coordinated shared-contract release.
- `ExecResult` and `JobRecord` remain exported because they describe the public return surfaces of the injectable `ExecFn` and `JobRunner` interfaces, even though callers generally rely on structural inference.

### Remaining considerations

- `passkeys.ts`, `subscriptions.ts`, `jobs.ts`, and `reconciler.ts` exceed 300 lines, but each presents a small cohesive interface and substantial hidden behavior. Split only when a concrete forcing function appears; file length alone is not sufficient.
- `CredentialInstaller` remains close to 300 lines because it owns validation and installation for several external credential formats. New formats should prompt extracting format-specific renderers behind its existing interface.
- Oxlint is enforced locally, in CI, and by the release gate with warnings denied and `typescript/no-floating-promises` elevated to an error. Knip could not run in this ARM environment because its parser failed allocating its transfer buffer; `ts-prune`, reference search, typecheck, tests, and focused manual inspection were used instead.
- Shell syntax validation is part of `npm run lint`; ShellCheck is not installed in the environment.
