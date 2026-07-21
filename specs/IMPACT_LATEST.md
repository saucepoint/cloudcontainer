# Repository-wide architecture debt cleanup

## Targets

1. Worker request safety and deterministic binding type generation.
2. Lifecycle timeout and placement orchestration correctness.
3. Daemon provisioning failure semantics and repository clone destinations.
4. Shared browser transport/presentation utilities and dashboard organization.
5. Layout stylesheet organization.
6. Dead exports/helpers and obsolete current-release protocol branches.
7. Vulnerable `@hono/node-server` dependency.

## Dependents

### Worker request seam

- `apps/worker/src/index.tsx` installs global middleware and mounts all routes.
- `apps/worker/src/http.ts` is used by `api.ts`, `codexauth.ts`, `passkeys.ts`, and `subscriptions.ts`.
- All Worker route tests can cross this seam; focused oversized-body coverage belongs in `apps/worker/test/api.test.ts`.

### Lifecycle/job seam

- `apps/worker/src/jobs.ts` is called by API lifecycle actions, placement, dashboard polling, GitHub credential refresh, SSH key sync, and reconciliation.
- `apps/worker/src/reconciler.ts` owns timeout and drift convergence.
- `apps/worker/src/state.ts` owns lifecycle classifications and status mappings.
- Coverage: `jobs.test.ts`, `reconciler.test.ts`, `state.test.ts`, and portions of `api.test.ts`.

### Placement seam

- `apps/worker/src/placement.ts` is called by provisioning API submission.
- It depends on `capacity.ts`, `ports.ts`, and `jobs.ts`, and mutates `containers`, `hosts`, and `waitlist` together.
- Coverage: `jobs.test.ts`, `api.test.ts`, `ports.test.ts`, and `reconciler.test.ts`.

### Daemon provisioning seam

- `apps/daemon/src/provisioner.ts` is called only through `JobRunner` in production.
- It depends on `CredentialInstaller`, `Incus`, agent metadata, MOTD rendering, and the shared job contract.
- Coverage: `provisioner.test.ts`, plus HTTP submission behavior in `server.test.ts`.

### Browser transport/dashboard seam

- Shared request/error/clipboard behavior is duplicated by `client/dashboard.tsx`, `landing.tsx`, `auth-flows.tsx`, `security.ts`, and `onboarding.ts`.
- The esbuild entry graph and all public page script references depend on these modules bundling correctly.
- Coverage: client TypeScript compilation, `npm run build:client`, and SSR/script smoke assertions in `pages.test.ts`; browser interaction coverage remains a gap.

### Layout seam

- Every SSR page imports `pages/layout.tsx`.
- Moving CSS without changing output affects landing, onboarding, security, and dashboard presentation.
- Coverage: `pages.test.ts` SSR assertions and client build; visual layout remains a manual gap.

### Shared contract seam

- `packages/contract/src/types.ts` is consumed by both Worker and daemon and is covered by all three workspaces.
- Removing `resize`, `export-window`, or paid-tier branches affects `worker/src/jobs.ts`, `worker/src/state.ts`, `daemon/src/provisioner.ts`, `daemon/src/incus.ts`, and their tests.
- This is a high-risk rolling-release change even though there is no current caller.

### Dependency seam

- `@hono/node-server` is used only by `apps/daemon/src/index.ts`.
- The daemon relies on `serve`, HTTPS `createServer`, and `serverOptions`; v2 retains these interfaces and requires Node 20+, while the project requires Node 22.
- Coverage: daemon typecheck and `server.test.ts`; a live TLS bind remains a manual operational check.

## Affected release contract

No intended product behavior changes. The cleanup enforces existing `SPEC.md` requirements for visible lifecycle failure, bounded and safe Worker operation, selected-agent credential behavior, deterministic provisioning, and current-release-only scope.

The paid-tier/resize/export-window removal candidate changes a shared wire contract and should be treated as a separate coordinated release decision despite being unreachable from the current UI.

## Test coverage and gaps

- Existing automated baseline: 23 files / 284 passing tests.
- Add regression coverage for oversized request rejection, every lifecycle timeout class, background-job timeout isolation, duplicate GitHub repository basenames, metadata-read failure propagation, and any narrowed placement catch.
- Run `npm run typecheck`, `npm test`, `npm run build:client -w apps/worker`, `npm audit`, and `npm run deploy -- --dry-run --skip-install`.
- Manual gaps: actual Incus commands, daemon TLS startup, Cloudflare runtime body streaming, and desktop/narrow browser presentation.

## Risk: High

The overall batch crosses the shared protocol, control-plane state convergence, host orchestration, browser bundles, and release tooling. Individual slices are mostly low-to-medium risk, but they must remain independently testable and the shared-contract deletion must not be mixed into safe internal refactors without an explicit decision.

## Recommended action

Proceed as vertical slices with a green full suite after each:

1. Safety/correctness regressions first.
2. Daemon failure semantics and repository validation.
3. Client duplication and file organization with unchanged rendered behavior.
4. Dependency/config hygiene.
5. Dead internal exports/helpers.
6. Handle roadmap protocol deletion separately or retain it with a documented reason.
