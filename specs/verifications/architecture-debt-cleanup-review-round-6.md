# Remediation — Round 6 (round-5 findings resolved)

Resolves every outstanding finding from the round-5 review (cap-exhausted
FAIL). 25 files / 344 tests pass; typecheck, Oxlint, and the release dry-run
are green; `npm audit` reports zero vulnerabilities.

## Must-fix

1. **Snapshot revision ordering** — `sync-keys`/`refresh-credentials`
   requests now carry the D1 job rowid as a monotonic `revision` (optional on
   the wire for rolling compatibility; deploy the daemon first). The daemon
   keeps a per-`containerId:op` watermark, claims it before running, and
   discards overtaken snapshots as succeeded — an older delayed job can no
   longer overwrite newer desired state, even when the newer job failed (the
   control-plane reconciler re-sends the latest state with a fresh revision).
   Watermarks are pruned when a container is destroyed.
2. **UTF-8 byte limits for SSH keys** — the contract schema and the dashboard
   validator now measure keys in UTF-8 bytes (via `TextEncoder`), the same
   unit as the aggregate `jobRequestBytes` budget. Maximal multibyte keys
   plus maximal credentials stay inside the budget; a regression test proves
   a maximal `start` request still validates.
3. **Daemon body limiting on all paths** — `bodyLimit` now runs globally
   before the signature middleware, so oversized POST bodies to any path are
   rejected (413) before being buffered for hashing.

## Should-fix

4. **sharp/libvips advisories** — root `overrides` pins `sharp` to `^0.35.3`
   (libvips 8.18.3, advisories fixed). Wrangler's Miniflare pins 0.34.5 and
   only lazy-loads sharp for local image transformation; 0.35.x is
   API-compatible for that surface. `npm audit` is clean. Drop the override
   once Miniflare depends on sharp >= 0.35.
5. **Typed Incus absence** — `IncusNotFoundError` is now the absence signal;
   production diagnostics are matched by their Incus-specific stderr pattern,
   and a generic `Error("not found")` propagates as an operational failure
   instead of being misclassified as absence.

## Residual risk

- During a mixed-version rollout, an old daemon rejects revisioned requests
  from a new Worker (strict schema). Release order: daemon, then Worker —
  already the documented order for contract changes (see `infra/RUNBOOK.md`).
- Without a revision (old Worker), the daemon applies snapshots in arrival
  order, exactly as before this change.
