# Independent Review — Round 3

- **Reviewer A:** 63/100, FAIL
- **Reviewer B:** 55/100, FAIL
- **AND-gate:** FAIL
- **Verification run by both:** deployment dry-run passed with 314 tests

## Combined findings and response

1. **Must-fix — queued job polling could fail then resurrect an in-flight submission.** Applied: daemon 404 is non-terminal while D1 remains queued; post-submit advancement is a queued-only CAS. A deferred-submit/404 regression test proves no failure or resurrection.
2. **Must-fix — drift could apply host stats older than a lifecycle completion.** Applied: container status and maximum lifecycle `rowid` are snapshotted before host I/O and revalidated in the corrective write.
3. **Must-fix — missing-container drift released capacity before retry/destroy.** Applied: drift preserves the reservation; retry reuses it and atomic destroy consumes it once. Both continuations have regression tests with other allocated capacity.
4. **Must-fix — daemon start/stop retries were not desired-state idempotent.** Applied: Incus status is queried first; already-running starts and already-stopped stops become no-ops while remaining setup work is retried. Partial-start and stopped-retry tests were added.
5. **Should-fix — clone basename collision reached the daemon after placement.** Applied: the shared GitHub repository-list schema rejects case-insensitive clone-target collisions, so the Worker rejects before mutation while the daemon keeps defense in depth.
6. **Should-fix — waitlisted container deletion committed before account purge.** Applied: the conditional row claim and every guarded cleanup now share one D1 batch. Lost admission returns 409; injected cleanup failure proves full rollback.
7. **Should-fix — release preflight omitted browser bundling.** Applied: browser build runs in CI and the release/dry-run checks before migrations.

No consider-category findings were reported.
