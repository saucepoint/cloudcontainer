## Target

Both UI polish workbench setup and GitHub App auth simplification merged together:

## Targets

- **UI Polish**: Public-facing onboarding, landing, dashboard, SSH setup, and provider sign-in UI copy and interaction polish.
- **GitHub Auth**: GitHub App onboarding and in-container GitHub authentication with installation-first flow.

## Dependents (combined)

- `apps/worker/src/pages/views.tsx`: server-renders landing, onboarding, copy, order, disclosure controls, and GitHub connect/install/reauthorize controls.
- `apps/worker/src/pages/layout.tsx`: owns the shared visual system, card dividers, responsive layout, and button states.
- `apps/worker/src/pages/dashboard.tsx`: renders the dashboard loading shell before the client hydrates.
- `apps/worker/client/onboarding.ts`: restores provisioning button, preserves agent choices, starts reauthorization.
- `apps/worker/client/auth-flows.tsx`: renders ChatGPT device-code authorization UI.
- `apps/worker/client/dashboard.tsx`: renders dashboard terminology, SSH enrollment modes, and collapsible panels.
- `apps/worker/client/ui.tsx`: is the shared client enhancement entry point for native disclosure behavior.
- `apps/worker/src/auth.ts` and `apps/worker/src/api.ts`: return user-visible setup and SSH readiness errors.
- `apps/worker/src/github.ts`: GitHub App installation, OAuth, token storage, repository discovery.
- `apps/worker/src/index.tsx`: mounts GitHub routes and decides whether onboarding exposes GitHub.
- `apps/daemon/src/credential-installer.ts`: writes `gh` and Git credentials into the container.
- `apps/worker/test/*.test.ts`, `apps/daemon/test/*.test.ts`: coverage per both change sets.

## Risk: Medium (both)

## Findings

<<<<<<< HEAD
Proceed with focused page/API regression tests, retain native `<details>` semantics while enhancing motion progressively, honor reduced-motion preferences, and manually verify desktop and narrow layouts after the client build.
=======
- A GitHub App installation is an access grant, not an authentication credential, so it cannot itself sign in `gh`.
- The installation and user authorization grants remain technically distinct. GitHub can present them as one browser journey when **Request user authorization (OAuth) during installation** is enabled.
- The resulting short-lived GitHub App **user access token** is the appropriate credential for Codestation and `gh`: it acts as the user and spans the intersection of every installation and repository that both the user and App can access.
- An installation access token is a poor replacement: it acts as the App, is tied to one installation, expires after one hour, and would require App private-key/JWT infrastructure. One token also cannot represent repositories spread across personal and organization installations.
- `gh` reads an API token from `hosts.yml`; `gh auth setup-git` can reuse that same token through `gh auth git-credential`. The previous extra `.git-credentials` copy and global `credential.helper store` were redundant plaintext state.
- The previous separate reauthorization endpoint revoked the current App grant before replacement succeeded. Cancellation or GitHub failure could therefore turn a working connection into no connection.

## Implemented direction

One installation-first `/auth/github` endpoint backs one **Connect or update GitHub** control. A valid App slug is required whenever GitHub is exposed, GitHub owns the combined install/authorize journey, and tokens are replaced only after a successful callback. The user access-token/refresh architecture remains; Git is configured through `gh auth setup-git`, and the duplicate `.git-credentials` token copy is removed. The release contract and manual live-flow guidance describe the same model.
>>>>>>> 7348ad4 (docs(github): explain singular App connection flow)
