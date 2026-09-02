# Flight plan: dormant translation-attempt writer

## Outcome and boundary

- Outcome: persist one exact current Spanish-to-English result and canonically replace its working
  projection in one fenced transaction.
- Exact base: `168991796c001134679a97eaeaef8121c05076fa`; synthetic memory and disposable PostgreSQL only.
- In scope: protected command/receipt/errors, server-side version/time allocation, consent-to-session
  locking, exact replay/conflict, retry eligibility, insertion, audit, same-transaction projection,
  rollback, concurrency, expiry, purge, and security tests.
- Out of scope: migrations, creator review writer, routes/OpenAPI, grants/roles/settings, adapter or
  network calls, jobs, workers, clients, deployment, apply, and activation.

## Implementation and verification

1. Require the caller to have reserved the attempt identity outside this persistence operation and
   require an existing current `translation_pending` working projection.
2. Lock consent before session; validate live current lineage and the exact Spanish source segment.
3. Converge exact identity replay, reject conflicting reuse, and compare the expected prior version
   before allocating the next version. Replay preserves the attempt receipt while reporting the
   current canonical working projection.
4. Insert immutable evidence and audit, call the existing projector on the same repository and
   transaction, require replacement, and let any failure roll back the whole operation.
5. Prove memory/PostgreSQL parity, retry rules, same- and cross-session races, complete membership,
   commit-time expiry, rollback, purge behavior, forced RLS, absent grants, and PHI-safe failures.

## Promotion and recovery

Stop by leaving the method uncalled; no deployed role can reach its tables. Recovery rolls back the
caller transaction or stops a future caller while retaining the additive schema. Before activation,
land the creator-review writer, a transaction-owning bounded-error wrapper, correction-safe trigger
and receiver changes, least-privilege projector grants, and the exact admitted translation profile.
