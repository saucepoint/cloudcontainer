# Authentication and World ID cleanup impact

## Targets

1. Remove Sign in with Apple from the Better Auth configuration, Worker bindings, landing client, icon module, tests, and release documentation.
2. Simplify the recent World ID 4.x browser/server flow, remove unnecessary v3 migration compatibility, and preserve account-bound proofs, upstream verification, and permanent nullifier uniqueness.
3. Remove dead auth exports and the nonessential World ID client-failure telemetry route.
4. Close the current transitive dependency advisory if it can be resolved within the existing lockfile ranges.

## Dependents

### Better Auth provider seam

- `apps/worker/src/better-auth.ts` creates every Better Auth instance and owns configured social providers and trusted account-linking providers.
- `apps/worker/src/types.ts`, `apps/worker/wrangler.jsonc`, and `apps/worker/test/helpers/env.ts` define the provider bindings used by runtime and tests.
- `apps/worker/client/landing.tsx` and `apps/worker/client/icons.tsx` expose the sign-in choices.
- `apps/worker/test/auth.test.ts` and `apps/worker/test/pages.test.ts` cover provider configuration and landing behavior.
- `README.md` and `SPEC.md` define setup and release expectations.

### World ID seam

- `apps/worker/src/account.ts` owns authenticated eligibility routes and atomic persistence of verification evidence.
- `apps/worker/src/world-id.ts` validates configuration and user-bound proofs, calls the Developer Portal, and canonicalizes the returned nullifier.
- `apps/worker/client/account.tsx` loads pinned IDKit 4.x assets and drives invite-code-mode verification.
- `apps/worker/src/pages/views.tsx` decides whether World ID is available on the deployment.
- `apps/worker/test/account.test.ts` and `apps/worker/test/pages.test.ts` cover request signing, signal binding, upstream verification, nullifier reuse, and page wiring.
- `apps/worker/migrations/0010_better_auth_accounts.sql` stores verification evidence; no schema change is needed.

### Dependency seam

- `postcss` is a transitive Vitest/Vite dependency. The audit fix is lockfile-only and remains within Vite's declared `^8.5.6` range.

## Affected release contract

- Authentication narrows from Google, Apple, GitHub, and passkeys to Google, GitHub, and passkeys.
- World ID remains optional per deployment and interchangeable with administrator invites at the eligibility gate. This new integration accepts v4 proofs only, avoiding a mixed-protocol nullifier migration surface.
- Existing generic `auth_accounts` rows are not migrated or deleted. The deployed Apple client ID is already empty, so this removes an advertised but unavailable path rather than a configured production provider.
- No shared Worker/daemon wire protocol or D1 schema changes.

## Test coverage

- Add a provider-configuration assertion for exactly Google and GitHub.
- Change the landing regression to require Google, GitHub, Create passkey, and Use passkey, and explicitly reject Apple.
- Require a World ID 4 Proof of Human credential and reject legacy v3 proofs before contacting the verifier.
- Verify unavailable deployments do not render an actionable World ID control.
- Preserve HTTP tests for signed request shape, account signal binding, unchanged proof forwarding, upstream error codes, and nullifier reuse.
- Run the Worker focused suites, browser build, all workspace tests, typecheck, lint, `npm audit`, dead-export scans, and deploy dry-run.

## Risk: Medium

The auth removal is localized and Apple is not configured in the checked-in deployment. World ID is security-sensitive and recently changed, but its external seam already has focused HTTP tests and no persistence migration is required.

## Recommended action

Proceed in vertical slices:

1. RED/GREEN: narrow Better Auth and landing behavior to Google, GitHub, and passkeys; remove all Apple-only code and documentation.
2. RED/GREEN: make the new World ID action v4-only, pass deployment availability into the client, then simplify duplicated SDK types, telemetry, configuration parsing, and nullifier handling without weakening proof binding.
3. Remove confirmed dead exports, apply the lockfile-only advisory fix, and run repository-wide verification and audit.
