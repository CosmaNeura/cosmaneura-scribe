# Flight plan: dormant working-transcript storage expand

## Outcome and boundary

- Outcome: Alembic `0013` can retain immutable, versioned English working projections with exact
  source, translation, review, blocker, and unused-evidence lineage.
- Tier 2; exact parent `c3c41662285565acd5aee1b63242e2ab63ea6300`; architecture
  `356bbd839deacdcecb372035f7652d3f3436d0a7`; synthetic disposable PostgreSQL only.
- In scope: two nullable session projection fields, five tables, composite keys, forced RLS,
  immutable/purge/fence triggers, deferred completeness checks, migration cycle, tests, and ADR.
- Out of scope: grants, callers, repositories, APIs/OpenAPI, workers, settings, handoff, migration
  apply, deployment, and activation.

## Order, rollout, and recovery

1. Merge and retain `0013` dormant after exact-SHA independent review.
2. Add the fenced projector/writer using the schema's exact blocker/status precedence.
3. Add authenticated least-privilege grants with the writer and prove concurrent publish,
   evidence-arrival, correction, expiry, and purge races.
4. Add a versioned handoff reader/contract; activate only under separate approval.

Children are written before their header in one transaction; deferred checks validate the sealed
aggregate and current session pointer at commit. Recovery stops future writers and keeps the
additive schema. Downgrade is allowed only in an empty disposable `_test` database.

## Completion evidence

- Sole `0013` head and empty `0012 -> 0013 -> 0012 -> 0013` cycle.
- Disposable PostgreSQL covers ready/nonready projections, exact selected and unused lineage,
  blockers, stale/two-version evidence, forged/incomplete aggregates, expiry, purge, immutability,
  forced RLS, and absent grants.
- Full Python tests, Node 24 contract tests, Ruff, Pyright, diff checks, and exact-parent budget pass.
- No environment changes. Real-PHI blockers remain as listed in ADR 0027.
