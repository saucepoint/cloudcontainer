# Independent Review — Round 4

- **Reviewer A:** 72/100, FAIL
- **Reviewer B:** 78/100, FAIL
- **AND-gate:** FAIL
- **Verification run by both:** deployment dry-run passed with 324 tests; production dependency audit was clean

## Combined findings and response

1. **Must-fix — Incus existence probes hid operational failures as absence.** Applied: only explicit instance/storage-volume not-found responses return false; outages, permission failures, and timeouts propagate so destroy remains retryable. Container- and storage-probe failure tests were added.
2. **Must-fix — daemon buffered an unbounded unauthenticated job body.** Applied: streaming Hono body limiting runs before signature/body reads, using the shared aggregate job-request budget. Declared-length and streamed over-limit tests return 413.
3. **Must-fix — individually valid credentials could outgrow the sealed field.** Applied: shared schemas now enforce aggregate UTF-8 credential and job-request budgets; the sealed budget is aligned with maximal valid credentials; Worker storage and outbound jobs validate locally. Maximal ASCII seal/transport, multibyte overflow, and pre-storage rejection tests were added.
4. **Must-fix — failed SSH-key/credential synchronization had no convergence path.** Applied: the reconciler claims and retries each latest failed background desired-state job after an hourly backoff, using a fresh current-state snapshot. Regression coverage proves a failed key sync is resubmitted.

No should-fix or consider-category findings were reported.
