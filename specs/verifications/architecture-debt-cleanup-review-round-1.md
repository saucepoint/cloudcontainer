# Independent Review — Round 1

- **Reviewer A:** 74/100, FAIL
- **Reviewer B:** 62/100, FAIL
- **AND-gate:** FAIL
- **Verification run by both:** deployment dry-run passed

## Combined findings and response

1. **Must-fix — waitlist admission could reserve a host without queueing provision.** Applied: queue insertion failure now moves the admitted row to a visible sanitized `error`; regression test injects a D1 trigger failure.
2. **Must-fix — an older lifecycle timeout could overwrite a newer result.** Applied: terminal failure and timeout state writes are atomic and affect the container only when that job is its latest lifecycle job.
3. **Must-fix — concurrent lifecycle requests could race.** Applied: lifecycle insertion uses an atomic `INSERT … WHERE NOT EXISTS`; conflicts return HTTP 409. Successful job/container transitions are atomic as well.
4. **Must-fix — drift correction could erase a timeout error on the next pass.** Applied: running/stopped drift correction is limited to stable running/stopped rows; repeated-reconciliation regression coverage was added.
5. **Must-fix — daemon agent discovery's trailing `true` masked metadata read failure.** Applied: only binary misses in the fallback branch are tolerated; metadata `cat` failures propagate, with command-level regression coverage.
6. **Should-fix — placement retried every D1 batch failure as contention.** Applied: only `(host_id, ssh_port)` conflict uses SQL `ON CONFLICT … DO NOTHING`; same-account races return their existing row and unrelated failures propagate.
7. **Should-fix — shared browser transport lost endpoint-specific non-JSON messages.** Applied: landing and security calls pass their prior status-aware/contextual fallbacks; transport fallback behavior is tested.
8. **Should-fix — body-limit coverage omitted declared-length and exact-boundary paths.** Applied: tests now cover unannounced/streamed oversized input, oversized `Content-Length`, and an exact 256 KiB body.

No consider-category findings were reported.
