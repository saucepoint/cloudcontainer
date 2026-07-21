# Independent Review — Round 5 (cap exhausted)

- **Reviewer A:** 87/100, FAIL
- **Reviewer B:** 92/100, FAIL
- **AND-gate:** FAIL
- **Review cap:** EXHAUSTED (5/5) — human decision required
- **Release dry-run:** passed with 24 files / 332 tests
- **Dependency audit:** failed after the advisory database published three high-severity inherited `sharp@0.34.5`/libvips findings

## Unresolved findings

### Must-fix

1. Concurrent `sync-keys`/`refresh-credentials` snapshots are not revision-ordered; an older delayed job can overwrite newer desired state on the daemon.
2. SSH key limits count UTF-16 code units rather than UTF-8 bytes; maximal multibyte keys plus credentials can exceed the aggregate job budget and make `start` fail.
3. Daemon body limiting covers `/jobs`, while signature middleware still buffers oversized POST bodies sent to other paths before rejecting them.

### Should-fix

4. Current Wrangler/Miniflare locks `sharp@0.34.5`, now reported vulnerable through inherited libvips CVEs. No non-forced compatible upgrade was established in this review round.
5. Incus absence classification still accepts generic `Error("not found")` for test injection; production diagnostics are Incus-specific, but a typed not-found error would make the boundary safer.

No consider-category findings were reported. Per the five-round hard cap, no further remediation was attempted in this run.
