## Target

GitHub onboarding installation entry point: the GitHub routes, onboarding view, Worker binding configuration, and deployment documentation.

## Dependents (8)

- `apps/worker/src/index.tsx`: mounts GitHub routes and renders onboarding availability.
- `apps/worker/src/api.ts`: revalidates selected repositories with the connected user token.
- `apps/worker/src/pages/views.tsx`: renders and scripts GitHub connect, reauthorize, search, and selection controls.
- `apps/worker/src/types.ts`: declares GitHub configuration bindings.
- `apps/worker/wrangler.jsonc`: supplies public GitHub App configuration.
- `apps/worker/test/github.test.ts`: covers OAuth, reauthorization, and repository discovery.
- `apps/worker/test/pages.test.ts`: covers onboarding controls and client behavior.
- `apps/worker/test/api.test.ts`: covers selected-repository validation during provisioning.

## Affected Stories

No release plan or epic capsule exists. The active bug is `BUG-2026-07-13T232151`.

## Test Coverage

- `apps/worker/test/github.test.ts`: OAuth redirects, callback storage, revocation, repository search, and setup lock.
- `apps/worker/test/pages.test.ts`: GitHub onboarding controls and repository-search script.
- `apps/worker/test/api.test.ts`: accessible and inaccessible repository submission.
- Gap: no current test or behavior exposes the GitHub App installation chooser.
- Gap: no current diagnostic distinguishes an authorized app from an installed app.
- Gap: live GitHub App visibility, installation approval, repository selection, and SAML configuration remain manual release checks.

## Risk: Medium

The change touches a credential-bearing OAuth onboarding path with several callers, but the proposed installation redirect carries no credential and the affected public behavior has focused route and page tests.

## Recommended action

Proceed test-first with a configured, allowlisted GitHub App slug and a distinct installation action; keep OAuth authorization and installation semantically separate. Add route/page regression coverage and document the required GitHub App settings before deployment.
