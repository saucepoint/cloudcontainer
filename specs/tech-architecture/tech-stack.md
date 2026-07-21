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

- Baseline is green: 23 test files / 284 tests and all workspace type checks pass.
- No `any`, TypeScript suppression, TODO, FIXME, or HACK markers were found in production TypeScript.
- Security-sensitive random values use Web Crypto, admin-secret comparison uses fixed-size hashes, and Worker observability is enabled.

### Correctness and defensive-programming debt

- `reconciler.ts` times out every job but only moves `provisioning`/`destroying` rows to `error`; timed-out `start` and `stop` lifecycle jobs can leave an apparently steady environment even though the operation failed.
- `placement.ts` wraps reservation, row loading, and job enqueue in one broad catch. A post-insert orchestration failure can be mistaken for an idempotent duplicate and silently return a provisioning row.
- `Provisioner.agentsOf` catches Incus failures and returns an empty agent set. A credential refresh can then succeed without installing selected-agent credentials, converting an infrastructure failure into silent partial behavior.
- GitHub repositories clone to `~/repos/<repository-name>`. Two selected repositories with the same basename currently target the same directory, and the second can be silently treated as already cloned.
- JSON request bodies are buffered without an application-level size limit, contrary to current Cloudflare Workers guidance for bounded request memory.

### Readability and organization debt

- `client/dashboard.tsx` is 522 lines and combines wire types, HTTP transport, polling, lifecycle controls, connection display, SSH enrollment, clipboard fallback, and account deletion.
- Client HTTP/error parsing is independently reimplemented in dashboard, landing, auth-flow, security, and onboarding entry points.
- `pages/layout.tsx` is mostly a 230-line embedded stylesheet, obscuring the actual layout interface.
- `api.ts`, `subscriptions.ts`, `jobs.ts`, and `reconciler.ts` each coordinate several policies; their public interfaces are small, but duplicated transition/error rules reduce locality.
- `CredentialInstaller` combines payload validation, environment rendering, four agent credential formats, GitHub, Wrangler, presence detection, and generated merge scripts.

### Dead and stale surface

- `quarantinePort` is production-dead and exists only to seed a unit test; production destroy logic duplicates its SQL.
- `ExecResult` and `JobRecord` are exported although no external production caller needs those exports.
- Paid-tier, `resize`, and `export-window` protocol/daemon branches have no current-release caller. They are roadmap scaffolding, while the release specification explicitly excludes paid upgrades. Removing them is a shared-contract decision and must be coordinated.
- Wrangler type generation currently reads the developer's ignored `.dev.vars`, so the tracked generated file contains stale removed binding names and can vary by workstation. `wrangler types --env-file /dev/null` generates deterministic config-only bindings.

### Dependency and tooling debt

- `npm audit` reports one moderate production advisory in `@hono/node-server` 1.x. Version 2 fixes it; its documented breaking changes are Node 18 removal and Vercel-adapter removal, neither used by this Node 22 daemon. The existing `serve`, `createServer`, and TLS `serverOptions` interface remains documented in v2.
- No lint script is configured. TypeScript catches unused locals but not floating promises or package/export dead code. Knip could not run in this ARM environment because its parser failed allocating its transfer buffer; `ts-prune`, reference search, typecheck, tests, and focused manual inspection were used instead.
- Shell scripts pass `bash -n`; ShellCheck is not installed in the environment.
