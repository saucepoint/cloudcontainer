# BUG-2026-07-13T232151: GitHub private repositories are not discoverable

## Problem

- **Actual behavior:** GitHub repository search returns public repositories but does not surface expected private repositories after the user connects or reauthorizes GitHub.
- **Expected behavior:** A user can grant the GitHub App access to selected personal or organization repositories and then find those repositories during onboarding.
- **Reproduction:** Open onboarding, choose **Connect GitHub** or **Reauthorize GitHub**, complete authorization, and search for a private repository on an account where the app has not separately been installed and granted repository access.
- **Security impact: NONE.** No security exploit path was identified; access is narrower than intended rather than broader.

## Root Cause Analysis

### Reproduce

The focused GitHub route and onboarding suites pass, but they encode the faulty assumption that a GitHub App user token can discover private repositories without an app installation. The generated connect URL starts the user authorization flow only. The onboarding page has no installation action.

Environment: Node 22 workspace, Vitest 3, current Worker implementation as of 2026-07-13.

### Isolate

The failure is isolated to the GitHub onboarding authorization contract, not repository-name filtering or private-repository rendering:

- Search preserves and renders the API's `private` repository metadata correctly when a mocked upstream response includes it.
- The current connection flow creates a GitHub App user access token by authorizing the app.
- It never installs the app on the user's personal account or organization and never asks which repositories the installation may access.

GitHub defines authorization and installation as independent grants. A user access token can access only the intersection of resources available to both the user and the app. Authorization alone therefore permits public-resource access but does not grant the app access to private repositories.

### Hypothesize

1. **The product incorrectly treats GitHub App authorization as repository installation.**
   - Falsification: inspect the connect destination for an app installation URL or an installation-plus-OAuth flow.
   - Result: confirmed absent; the destination is only the OAuth authorization endpoint.
2. **Repository filtering removes private repositories.**
   - Falsification: provide mixed public/private upstream repository metadata and search by owner.
   - Result: falsified; both visibility types are retained.
3. **The REST listing endpoint cannot return private repositories for this token type.**
   - Falsification: compare with GitHub's user-token documentation.
   - Result: falsified; user access tokens can access repositories shared by the user and an app installation.
4. **The registered app lacks Contents permission, has restricted installation visibility, omits the target repository, or lacks required organization/SSO approval.**
   - Falsification: inspect the live GitHub App settings and installation. These settings are not represented in the repository.
   - Result: remains an operational precondition, but it does not explain or repair the missing installation step in the product flow.

### Verify

The root cause is verified: the app performs **authorization without installation**, while GitHub requires installation access for private repository resources. GitHub's documentation explicitly states that an app may be authorized without being installed and that a user access token can access only resources available to both the user and the app. The current test title asserting that installation is unnecessary contradicts that contract.

A correct live registration must also use **Contents: read-only**, permit installation on the intended accounts (normally **Any account**), and grant the installation access to the target repositories. Organization approval and an active SAML SSO session may additionally be required.

Risk level: Medium. Repository setup is blocked, but no unauthorized access occurs and users can work around it by manually installing/configuring the app before reconnecting.

## TDD Fix Plan

1. **RED:** Write a route test proving that the primary GitHub connection action starts an installation-capable flow rather than authorization alone.
   **GREEN:** Add an explicit configured GitHub App installation destination and route users through installation before or together with user authorization.
   **verify:** `cd apps/worker && npm test -- --run test/github.test.ts`

2. **RED:** Write an onboarding test proving the UI explains installation access and provides an installation/manage-access action for personal and organization repositories.
   **GREEN:** Update the GitHub onboarding controls and status copy; retain reauthorization as a separate action for refreshing the user grant.
   **verify:** `cd apps/worker && npm test -- --run test/pages.test.ts`

3. **RED:** Replace the false no-installation repository test with behavior that models repositories granted through an installation, including a private repository.
   **GREEN:** Keep repository discovery constrained to resources shared by the authenticated user and the app; optionally enumerate the user token's accessible installations and their repositories to make this contract explicit.
   **verify:** `cd apps/worker && npm test -- --run test/github.test.ts test/api.test.ts`

4. **RED:** Add configuration/documentation validation covering installability, read-only Contents permission, selected repository access, organization approval, and SAML reauthorization guidance.
   **GREEN:** Update setup and release verification instructions so a deployment cannot be considered GitHub-ready after setting only a client ID and secret.
   **verify:** `cd ../.. && rg -n "Contents|Any account|install|SAML" README.md SPEC.md apps/worker`

**REFACTOR:** Centralize GitHub App authorize/install URLs and user-facing access guidance so connection, reauthorization, and installation cannot be conflated again.

## Acceptance Criteria

- [x] Connecting GitHub gives users an installation path that grants access to selected personal or organization repositories.
- [x] Authorization remains a distinct user grant and callback token handling still works.
- [x] A granted private repository appears in search and can be selected and revalidated.
- [x] An ungranted private repository does not appear and cannot be provisioned.
- [x] Setup documentation lists GitHub App visibility, Contents permission, installation selection, organization approval, and SAML requirements.
- [x] All new tests pass.
- [x] Existing tests still pass.

## Resolution

When an App slug is configured, the primary onboarding action redirects through
the GitHub App installation chooser with CSRF state before GitHub continues into
the existing OAuth callback. Reauthorization remains a separate OAuth-only
action. The App slug is an explicit, validated Worker binding; when it is absent,
the existing OAuth connection and repository selector remain available.

Granted private repositories remain searchable and are revalidated directly at
submission; ungranted repositories return GitHub's not-found response and are
rejected. Existing short-lived user-token delivery continues to authenticate
`gh` and Git cloning without introducing stored installation credentials.
