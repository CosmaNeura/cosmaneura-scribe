# Flight plan: dormant derived translation evidence expand

## Outcome and boundary

- Outcome: Alembic `0012` can persist immutable `es-US` to `en-US` translation attempts and exact
  Core-owned creator reviews beneath the current normalized source.
- Tier 2: this changes transcript/PHI storage and database security boundaries.
- Source authority: Scribe commit `9e44e8a8a25ca8f59f67326597e35a89c5f07d6b`; architecture contract
  `356bbd839deacdcecb372035f7652d3f3436d0a7`.
- In scope: two derived tables, exact composite foreign keys, monotonic attempt allocation guard,
  review constraints, forced RLS, immutable/fenced lifecycle triggers, source-purge cascade, tests,
  and this decision record.
- Out of scope: repositories, APIs/OpenAPI, workers, settings, bootstrap grants, working transcript,
  handoff, Core changes, migration apply, deployment, provider calls, and activation.
- Data boundary: disposable PostgreSQL and synthetic text only.

## Order, rollout, and recovery

1. Merge and hold `0012` as an additive dormant expand after independent exact-SHA review.
2. Add working-transcript/blocker storage and its current-version projection in a separate packet.
3. Add fenced translation and Core-review repositories, then cross-writer PostgreSQL race evidence.
4. Define and implement the versioned Core handoff contract before exposing any receiver API.
5. Add least-privilege roles only with their writers; activate only after separate approval.

The migration takes bounded locks before adding the source-segment unique key. Existing source
uniqueness makes duplicates impossible, but lock timeout still fails closed. Operational recovery
stops later callers and retains the additive tables. Downgrade refuses a non-`_test` database and
refuses rollback while either derived table contains evidence.

Purge must set `content_purged_at` and clear the current source before deleting the source root in
the same fenced transaction. Cascades then remove translation text and review links. Later writers
must preserve consent-before-session lock order and use savepoint/readback handling for partial
unique conflicts; this schema packet does not claim those runtime guarantees.

## Completion evidence

- One Alembic head and an empty disposable `0011 -> 0012 -> 0011 -> 0012` cycle.
- PostgreSQL tests cover valid attempts/reviews, exact lineage, monotonic versions, outcome pairs,
  creator and chronology checks, terminal/accepted uniqueness, immutability, expiry, purge cascade,
  no reconstruction, forced RLS, cross-tenant invisibility, and absent grants.
- Full Python tests, Ruff, Pyright, diff inspection, and exact-parent change budget pass.
- No environment is changed. Real-PHI activation remains blocked on legal-hold policy resolution
  and the exact translation adapter/model evaluation.
