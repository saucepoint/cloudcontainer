# Code audit: staging environment

## Result

PASS

## Checklist

- ✓ **Supply chain:** no dependencies added; lockfile unchanged.
- ✓ **Secret hygiene:** no credential-shaped value appears in the diff. Staging secrets were generated independently and uploaded through Wrangler secret storage; retained operator values are outside the repository in a mode-0600 file.
- ✓ **Security:** separate trust roots, D1 state, Incus project, daemon listener/service/config, and SSH ranges; shared-host capacity fails closed. `specs/security/REVIEW.md` has no HIGH-confidence finding.
- ✓ **Scope:** changes are limited to staging Worker/D1/release commands, shared-daemon isolation, capacity partitioning, focused tests, and source-of-truth documentation.
- ✓ **Types:** no `any`, suppression, or unsafe cast added; repository typecheck passes.
- ✓ **Tests:** focused Worker deployment/port tests and daemon policy tests pass; full suite passes.
- ✓ **Shell safety:** `bash -n deploy.sh infra/*.sh` and repository lint pass. Remote values are fixed constants or validated controller inputs; secrets are not placed in argv by the controller.
- ✓ **Cloudflare config:** Wrangler generated bindings for production and staging, deployed `workbench-staging`, and applied all staging D1 migrations.
- ✓ **Clarity:** production remains the default; staging selection and every divergent path are explicit. Shared-host bootstrap avoids host-global package, nftables, and Incus restart mutations.
- ✓ **Documentation:** README, specification, runbook, impact analysis, security review, and operator commands describe the static-partition invariant and rollback boundaries.

## Smells reviewed

- `infra/hostctl.sh` is large and shell-heavy, but this is pre-existing operational code and the environment constants are centralized rather than duplicated across commands.
- The deployment configuration test inspects checked-in config/scripts because Wrangler environment behavior is primarily declarative; runtime port behavior is tested through the allocator API.
- No new Mysterious Name, Feature Envy, Message Chain, Middle Man, or speculative abstraction was identified.

## Verification

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test` — pass (491 tests at the full-suite checkpoint)
- Focused post-review tests — pass (19 tests)
- staging D1 migrations — current through `0018_setup_drafts.sql`
- staging Worker version — deployed; public-DNS-resolved HTTPS request returns 200

## Red flags / skipped items

- Dual independent reviewer agents were unavailable in this harness, so no external-review pass is claimed.
- Real shared-host daemon installation remains gated on a clean committed release, as required by `hostctl`; no dirty checkout was copied to production hardware.
