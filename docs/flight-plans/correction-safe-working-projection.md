# Flight plan: dormant correction-safe working projection

## Outcome and boundary

- Outcome: a PostgreSQL source correction atomically invalidates the current English working
  projection while preserving its stable identity and immutable history.
- Exact base: PR #86 commit `af6f2dd0f6ac4a16150a462ab53b01e80e35880a`.
- In scope: the correction compare-and-set, one forward trigger-hardening migration, disposable
  PostgreSQL migration/recovery tests, correction/rollback/version tests, and documentation.
- Out of scope: database grants or principals, authentication/session behavior, API/OpenAPI,
  settings, Core callers, translation providers, desktop/iOS clients, deployment, migration apply,
  beta enrollment, and activation.

## Risk and dependencies

- Tier 2: this changes protected transcript-storage behavior and trigger definitions.
- Dependency order: dormant storage and writers PRs #80–#85, transaction-wrapper PR #86, this
  packet, a separately authorized least-privilege packet, Core authorization/caller work, and only
  then synthetic environment acceptance.
- The runtime role currently cannot update `current_working_transcript_version`. Hold this packet
  dormant; do not deploy it where the normalized-source receiver can run until the later narrow
  grant is approved and applied.
- No live database or deployed state is inspected or changed by this packet.

## Implementation sequence

1. Add revision `0014` rather than rewriting the already reviewed `0012` and `0013` history.
2. Replace only the five current-head broad-read trigger functions. Use explicit base-table columns,
   preserve behavior and invoker rights, retain the fixed search path, and re-revoke `PUBLIC`
   routine privilege.
3. In the existing consent-first/session-second correction transaction, increment the source
   version, set `status = 'source_received'`, and clear only the current working-version pointer in
   one compare-and-set update.
4. Preserve `working_transcript_id` and every prior immutable source/evidence/working row. The next
   projection must publish version `N+1` under the same ID.
5. Add deterministic disposable PostgreSQL tests for correction, rollback, expiry/purge, and the
   correction-versus-writer boundary. Assert the current schema no longer depends on broad
   base-table reads.

## Verification and abort conditions

- Required: focused and full Python suites against disposable PostgreSQL, Ruff, strict Pyright,
  Alembic single-head check, upgrade/downgrade/upgrade cycle, clean diff, change-budget check, and
  independent review of the final pushed SHA.
- Abort on a changed lock order; a cleared or replaced stable working ID; modified historical rows;
  a broad grant; `SECURITY DEFINER`; a non-disposable downgrade; cross-tenant visibility; correction
  that can commit with an old current projection; or any auth, route, environment, or activation
  change.

## Recovery and next gate

Recovery is to keep all callers disabled and retain the forward migration. If a defect is found
after any future apply, use a reviewed forward fix; do not rewrite applied history or remove
immutable evidence. Disposable `_test` databases may exercise the bounded downgrade.

The next packet is not implicitly authorized. It may add only the reviewed least-privilege
permissions needed for source correction and the two derived writers, with exact-role PostgreSQL
tests. Enabling callers, applying migrations, changing Core authentication, enrolling testers, or
deploying remains a separate founder decision.
