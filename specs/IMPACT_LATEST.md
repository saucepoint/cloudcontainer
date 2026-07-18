## Target

Public-facing onboarding, landing, dashboard, SSH setup, and provider sign-in UI copy and interaction polish. This includes the workbench terminology, provider-placement change, ChatGPT device-code copying, collapsible motion, and active SSH enrollment controls.

## Dependents (9)

- `apps/worker/src/pages/views.tsx`: server-renders the landing and onboarding copy, order, and disclosure controls.
- `apps/worker/src/pages/layout.tsx`: owns the shared visual system, card dividers, responsive layout, and button states.
- `apps/worker/src/pages/dashboard.tsx`: renders the dashboard loading shell before the client hydrates.
- `apps/worker/client/onboarding.ts`: restores the provisioning button label after a failed request.
- `apps/worker/client/auth-flows.tsx`: renders ChatGPT device-code authorization UI.
- `apps/worker/client/dashboard.tsx`: renders dashboard terminology, SSH enrollment modes, and collapsible panels.
- `apps/worker/client/ui.tsx`: is the shared client enhancement entry point for native disclosure behavior.
- `apps/worker/src/auth.ts` and `apps/worker/src/api.ts`: return user-visible setup and SSH readiness errors.
- `apps/worker/test/pages.test.ts`: covers rendered copy, ordering, client wiring, accessibility, and motion affordances.

## Affected Stories

No release plan or active epic capsule exists. The changes are a UI-only maintenance batch and do not alter the container protocol, database schema, or provisioning API shape.

## Test Coverage

- `apps/worker/test/pages.test.ts`: rendered landing/onboarding/dashboard copy, ordering, client bundle wiring, and existing Motion use.
- `apps/worker/test/api.test.ts`: SSH readiness and credential-setup errors.
- Gap: no browser-level visual regression suite exists for divider width, responsive device-code layout, or disclosure animation.

## Risk: Medium

The implementation spans several independently bundled UI entry points and user-visible API errors, but it does not change persistence, credential handling, or provisioning semantics.

## Recommended action

Proceed with focused page/API regression tests, retain native `<details>` semantics while enhancing motion progressively, honor reduced-motion preferences, and manually verify desktop and narrow layouts after the client build.
