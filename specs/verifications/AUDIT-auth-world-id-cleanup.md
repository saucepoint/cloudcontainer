# Code audit: authentication and World ID cleanup

**Verdict:** PASS

## Churn-first review

Highest-churn changed files were reviewed first: `pages.test.ts`, `views.tsx`, `README.md`, `SPEC.md`, `wrangler.jsonc`, and the auth modules. The final change is 57 net lines smaller than `main` before verification artifacts.

## Checklist

- ✓ **Supply chain and secrets:** no new direct dependency; PostCSS/nanoid moved within existing ranges; `npm audit` reports zero vulnerabilities; diff secret scan is clean.
- ✓ **Correctness:** Google, GitHub, and passkeys are the only account entry paths. World ID is v4-only, account-bound, externally verified, and nullifier-unique.
- ✓ **Security:** authenticated middleware remains on eligibility routes; proof action/environment/signal checks precede external I/O; fixed verifier host; parameterized SQL; no high-confidence findings (`specs/security/REVIEW.md`).
- ✓ **Scope:** changes stay within authentication, World ID eligibility, matching tests/docs, dead exports, and the directly observed transitive advisory.
- ✓ **Boy Scout Rule:** Apple code/config/docs and obsolete client telemetry are deleted; handwritten IDKit type copies, catch-all error masking, redundant validation, and dead exports are gone; no commented-out code.
- ✓ **Types:** no `any`, suppression directive, or unsafe cast was added; upstream IDKit types replace local copies.
- ✓ **Tests:** focused regressions cover exact providers, v4-only requests, v3 rejection, unavailable UI, signal binding, nullifier reuse, verifier outages, and D1 failures.
- ✓ **F.I.R.S.T:** focused tests are fast, in-memory, isolated by fresh D1 environments and restored fetch mocks, repeatable after `npm ci`, self-validating, and were written before each behavior change.
- ✓ **Design:** the World ID module retains a small interface while hiding configuration, proof validation, upstream response parsing, and nullifier canonicalization. No speculative seam or adapter was introduced.
- ✓ **Clarity:** production files remain under 300 lines; names reflect behavior; external-boundary validation is retained while redundant client/server defenses were removed.
- ✓ **Dead code/dependencies:** client and server TypeScript checks, ts-prune with reference validation, Depcheck, and focused searches found no orphaned production symbol or dependency. Knip's ARM parser allocation failure is documented rather than treated as evidence.
- ✓ **Release gates:** clean install, build, typecheck, lint, 345 tests, audit, and deploy dry-run pass.

## Smell review

Removed: Duplicated Code (SDK request types and client error handling), Dead Function/Export (telemetry route and auth exports), Primitive/flag state (`pending` string values), and broad exception masking. No new Middle Man, Message Chain, Feature Envy, or speculative abstraction was introduced.

## Rationalizations rejected

- Did not retain Apple as dormant configuration “for later”; all provider-specific production surface was deleted.
- Did not keep v3 World ID fallback without a dual-protocol migration strategy; this new action is v4-only.
- Did not label every D1 failure as nullifier reuse; only the explicit unique conflict maps to 409.
- Did not claim Knip passed; independent analyzers and reference checks were used after its reproducible ARM failure.
