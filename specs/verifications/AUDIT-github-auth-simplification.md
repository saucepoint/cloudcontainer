# Code audit: GitHub auth simplification

**Verdict: PASS**

## Hotspots reviewed first

1. `apps/worker/src/pages/views.tsx` — 27 commits in 90 days
2. `apps/worker/src/github.ts` — 11 commits in 90 days
3. `apps/worker/test/github.test.ts` — 8 commits in 90 days
4. `apps/worker/client/onboarding.ts` — 3 commits in 90 days
5. `apps/daemon/src/credential-installer.ts` — 2 commits in 90 days

## Checklist

- ✓ **Correctness:** singular route starts the installation chooser, preserves CSRF/user binding, and replaces credentials only on callback success.
- ✓ **Security:** no confidence ≥8 findings; authenticated setup lock, slug validation, return-path allowlist, one-time state, sealed token delivery, and secret-safe constant shell command remain intact.
- ✓ **Performance:** no new network request or database round trip; client reauthorization fetch and duplicate credential write were removed.
- ✓ **Clarity:** two routes, one destructive endpoint, one UI branch, and duplicate Git token storage were removed.
- ✓ **Supply chain:** no dependency or lockfile changes; `npm audit --omit=dev` reports zero vulnerabilities.
- ✓ **Scope:** changes are limited to GitHub onboarding, token reuse for Git, focused tests, and matching release documentation.
- ✓ **Types:** no `any`, suppression, unsafe double cast, or ignored TypeScript diagnostic added; full typecheck passes.
- ✓ **Tests:** public route/page/daemon behavior has regression coverage; all 294 tests pass.
- ✓ **Workers practices:** request state remains local, all promises are awaited, Web Crypto creates OAuth state, secrets remain bindings, and generated Worker types pass.
- ✓ **Secret hygiene:** diff scan found no credential/private-key patterns; `.git-credentials` duplication is removed.
- ✓ **Boy Scout:** touched production files are smaller; dead direct-OAuth/revocation code and stale client logic are gone.
- ✓ **Style:** strict ESM TypeScript, existing formatting, explicit types, early returns, and no commented-out code.

## Non-blocking constraints

- No formatter or linter is configured; repository-required typecheck and test gates were used.
- `github.ts` and `views.tsx` remain slightly above 300 lines, but this change reduces both and adds no new responsibility.
- The live GitHub-hosted install/update/OAuth journey cannot be automated by the fast suite and remains an explicit release check.

## Rationalizations caught

None. No failed gate or security finding was waived.
