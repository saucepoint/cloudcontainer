# Independent Review — Round 2

- **Reviewer A:** 66/100, FAIL
- **Reviewer B:** 68/100, FAIL
- **AND-gate:** FAIL
- **Verification run by both:** deployment dry-run passed with 306 tests

## Combined findings and response

1. **Must-fix — destroy became terminal before D1 cleanup.** Applied: destroy success, port quarantine, host accounting release, waitlist cleanup, and container deletion now form one latest-job-gated D1 batch. Any failure rolls the entire transition back and leaves the job active/retryable.
2. **Must-fix — lifecycle enqueue trusted a stale container snapshot.** Applied: lifecycle insertion atomically verifies row existence, observed status, assigned host, and absence of another active lifecycle job; pending-state mutation shares the batch. Stale requests receive HTTP 409.
3. **Must-fix — drift correction used read-then-write guards and could release capacity twice.** Applied: drift updates condition on observed host/status and no active lifecycle job; host accounting is gated by the state update's `changes()` in the same batch.
4. **Must-fix — retry selected a newer background job.** Applied: retry queries the newest lifecycle job only.
5. **Must-fix — waitlisted account deletion could race host admission.** Applied: deletion is conditional on the row still being hostless and waitlisted; losing the race returns 409 and preserves the admitted row.
6. **Should-fix — job recency depended on wall-clock timestamps.** Applied: recency and latest-job guards use SQLite insertion `rowid` consistently.
7. **Should-fix — stale provision metadata and destroy side effects were not fully gated.** Applied: fingerprints are committed in the same latest-job-gated terminal batch; destroy uses the atomic finalization described above.
8. **Should-fix — an SSH-port-exhausted preferred host prevented trying another host.** Applied: port exhaustion has a typed error; direct placement and waitlist admission exclude that host and continue through eligible hosts. Both paths have regression coverage.

No consider-category findings were reported.
