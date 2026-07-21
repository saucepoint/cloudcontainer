# Code Audit: architecture-debt-cleanup

**Verdict: PASS**

## Checklist

- [x] **Repository conventions** — strict ESM TypeScript, two-space indentation, double quotes, semicolons, `.js` relative imports, type-only imports, and workspace-local tests are preserved. `git diff --check` passes.
- [x] **Mechanical quality gate** — `npm run lint` runs Oxlint with warnings denied, elevates `typescript/no-floating-promises`, and validates all deploy/infra shell syntax. It is enforced by CI and the release script.
- [x] **Type safety** — all workspace and browser type checks pass; the production diff adds no `any`, TypeScript suppression, or double assertion.
- [x] **Test coverage** — 24 files / 332 tests pass. New regressions cover request-body limits, lifecycle timeout state, enqueue rollback, Incus metadata failure, repository path collisions, shared browser transport, and polling policy.
- [x] **FIRST properties** — added tests are fast, isolated, repeatable, self-verifying, and behavior-focused. External systems are mocked or command execution is injected.
- [x] **Error handling** — broad placement failure masking was narrowed; daemon metadata failures propagate; timed-out lifecycle operations now surface container failure; expected failures carry actionable messages without credentials.
- [x] **Security** — bounded input, bound SQL, authenticated ownership, schema validation, shell quoting, sealed credential paths, and static-only style injection were reviewed. No high-confidence findings. See `specs/security/REVIEW.md`.
- [x] **Module boundaries** — browser transport, polling policy, clipboard, WebAuthn errors, confirmation flow, SSH presentation, and page styles now have focused ownership. Dashboard orchestration and document layout are substantially smaller.
- [x] **Dead code and exports** — `quarantinePort` and unnecessary public exports were removed; retained paid-tier, `resize`, `export-window`, `ExecResult`, and `JobRecord` surfaces have explicit compatibility/interface reasons.
- [x] **Dependencies and release safety** — vulnerable `@hono/node-server` 1.x was upgraded, Wrangler type generation is deterministic, `npm audit` reports zero vulnerabilities, and the deployment dry-run passes.

## Debt consciously retained

- Several domain modules exceed 300 lines but expose cohesive, small interfaces; splitting without a behavior or ownership boundary would add indirection rather than reduce complexity.
- Real Incus provisioning and live Worker/daemon release checks remain operational gates outside the hermetic suite.
- ShellCheck is not installed; shell syntax is enforced with `bash -n`.
- Knip could not allocate its parser transfer buffer on this ARM host; strict typecheck, Oxlint, `ts-prune`, reference search, tests, and manual diff review supplied overlapping evidence.
