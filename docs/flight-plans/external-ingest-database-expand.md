# Flight plan: dormant external-ingest database expansion

## Outcome and boundaries

- Problem and measurable outcome: represent a Scribe session's immutable ingest
  path without changing the existing capture path. Existing and old-version
  writers continue to create `chunk_upload` sessions by default; only rows
  explicitly created as `external_async_transcript` may move directly from
  `created` to `transcript_ready`.
- In scope: one additive `scribe_sessions.ingest_mode` column, an allowed-value
  constraint, a database immutability trigger, the mode-aware status-transition
  function, migration cycling, and synthetic PostgreSQL acceptance tests.
- Explicit non-goals: applying the migration to any shared environment;
  changing transcript storage; exposing ingest mode through schemas,
  repositories, APIs, workers, desktop/mobile clients, or provider adapters;
  consent changes; feature activation; Core database changes; deployment.
- Affected surfaces if separately applied: the Scribe PostgreSQL database only.
  Tests use synthetic identifiers and no PHI.

## Risk and dependencies

- Tier: Tier 2 because this is a database schema and state-machine change.
- High-blast-radius decisions: the DDL takes a table lock and replaces a trigger
  function. Downgrading after external-mode rows exist would discard their
  ingest provenance, so destructive rollback is prohibited after activation.
- Dependency-ordered PR stack: domain contract PR #61; this database-expand PR;
  a future false-default persistence/API packet; generated-client parity; then
  separately gated desktop/mobile callers. Each packet can remain held with no
  user-visible effect.
- Cross-repo contract/version: N/A. No sender can select the new mode in this
  packet. Receiver-before-sender ordering is mandatory for later packets.

## Current deployed state

- `origin/main@1aab63c` has no `ingest_mode` column. This packet records no live
  deployment claim and authorizes no environment mutation.
- The dedicated non-PHI beta environment is a required future target, not an
  environment created or changed by this packet.
- Reconciliation decision: retain current deployed behavior. Apply this expand
  migration only after the isolated beta database is provisioned and a separate
  migration authorization is recorded.
- Previous known-good state: Alembic revision `0007`. Before any external-mode
  data exists, revision `0008` can be downgraded to `0007`; afterward, retain the
  additive column and disable callers instead of dropping data.

## Feature flag / release control (user-visible reversible behavior only)

- N/A for this schema-only packet: application code has no field or route with
  which to select `external_async_transcript`. The existing path is preserved by
  the `chunk_upload` default. A later API packet must add a false-default,
  founder-controlled beta-cohort gate before any caller is wired.

## Schema/data sequence (schema/data work only)

| Change | Rung | PR | Invariant | Recovery |
|---|---|---|---|---|
| Define external mode and its one additional transition | Code/CI | #61 | Default transition table is unchanged | Revert/hold PR |
| Add immutable `ingest_mode` with `chunk_upload` default | Code/CI only in this packet | This PR | Old writers and existing rows remain on the old path | Hold unmerged; no database recovery needed |
| Rehearse revision `0007 -> 0008 -> 0007 -> 0008` | Ephemeral synthetic PostgreSQL | This PR | Column, constraint, trigger, and transition function cycle cleanly | Destroy ephemeral database |
| Apply expand migration | Isolated non-PHI beta database, separately authorized | Future release record | No runtime can select external mode yet | Before use: downgrade to `0007`; after use: retain schema and roll back callers |
| Apply to production/PHI database | Blocked | N/A | Requires founder authorization and completed beta evidence | N/A while blocked |

- PHI-safe rehearsal evidence: on 2026-09-01, the full Python suite passed
  (`492 passed`) against a disposable local PostgreSQL database ending in
  `_test`. The fixture exercised `0007 -> 0008 -> 0007 -> 0008`, verified that
  a row created before `0008` became `chunk_upload`, and used synthetic data
  only. This is code-level rehearsal, not authorization to alter an environment.

## Rollout and promotion

1. Validate migration SQL, full unit/static checks, a real PostgreSQL migration
   cycle, exact schema behavior, one Alembic head, and independent review on the
   final commit.
2. Open this PR stacked on #61 and hold it. Do not merge, apply, deploy, or
   activate it as part of this packet.
3. After the dedicated synthetic beta environment exists, obtain a separate
   authorization to rehearse the expand migration there. Measure lock duration
   and verify existing session creation and status transitions are unchanged.
4. Keep all shared production/PHI environments blocked until the later API,
   client, security, auth, and cohort acceptance gates are complete.
- Abort any future apply on lock-timeout/error, more than one Alembic head,
  changed default-mode behavior, constraint/trigger mismatch, or evidence that
  a caller can select external mode before its gate is approved.

## Security and recovery

- Existing row-level security remains attached to `scribe_sessions`; this
  packet adds no new table, role, privilege, endpoint, provider call, audio, or
  transcript payload.
- Behavior recovery: keep the default path and roll back/disable future callers.
  Schema recovery before external use: downgrade to `0007`. Schema recovery
  after external use: keep the additive column; any removal requires a separate
  data migration and explicit approval.
- Data-damage boundary: dropping `ingest_mode` after external rows exist loses
  provenance. No cleanup/drop is authorized here.
- Observation window before irreversible cleanup: N/A; no cleanup is planned.

## Completion

- Required evidence: focused and full tests, Ruff, Pyright, Alembic single-head
  check, real PostgreSQL upgrade/downgrade cycle, clean diff, and independent
  review of the final SHA.
- Follow-up packets: false-default persistence/API support; generated clients;
  desktop/mobile integrations; isolated-beta environment apply and acceptance.
- Update this plan and the beta contract only if the storage model, activation
  authority, or rollback boundary changes.
