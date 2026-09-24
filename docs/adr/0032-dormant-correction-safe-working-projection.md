# ADR 0032: Invalidate dormant working projections on source correction

**Status:** Accepted for dormant synthetic implementation

## Context

A normalized source correction creates a new immutable source version. Any current English working
projection still points to the preceding source version and must stop being current in the same
transaction. The in-memory repository already clears only the current working-version pointer,
but the PostgreSQL correction compare-and-set does not. Revision `0013` correctly rejects a source
version change that leaves the old pointer current, so PostgreSQL correction after projection cannot
be made operational until the receiver and database rule agree.

The current-head translation, review, and working-projection triggers also contain five broad table
reads. Four load an entire `scribe_sessions` row with `%ROWTYPE` and `SELECT *`; the working
completeness function selects every source-segment column through `source.*`. Those reads make a
future least-privilege grant depend on unrelated columns and on table shape. A later grant packet
must not solve that problem by giving either runtime identity broad table authority.

## Decision

On a non-first normalized-source receipt, PostgreSQL clears
`current_working_transcript_version` in the same compare-and-set update that advances
`current_source_transcript_version` and returns the session to `source_received`.
`working_transcript_id` is not cleared or replaced. Prior source, evidence, and working rows stay
immutable; the next canonical projection uses the next working version under the same stable ID.
Transaction rollback restores both source and working pointers together.

Add forward Alembic revision `0014`. It replaces the five current trigger functions with
behavior-equivalent definitions that name every base-table column they read:

- `enforce_normalized_translation_attempt`
- `enforce_normalized_translation_review`
- `enforce_working_child_insert`
- `enforce_working_header_insert`
- `enforce_working_transcript_complete`

The replacement functions remain security-invoker functions with a fixed
`search_path = pg_catalog, public`. They receive no new execute privilege, and the migration
reasserts revocation from `PUBLIC`. Shape comparisons name their columns explicitly rather than
depending on `SELECT *` expansion.

The established lock order remains unchanged: set transaction-local tenant context, lock the
consent scope, lock the session row, read immutable evidence, update the pointer/state, insert
working children, seal the header, and force the final constraints.

## Boundary and sequencing

This packet adds no role, grant, route, OpenAPI operation, authentication/session behavior,
setting, worker, client, network call, deployment, migration application, or feature activation.
The external-ingest and derived-writer paths remain false-default and dormant.

The PostgreSQL runtime role does not yet have permission to update the working-version pointer.
Therefore this packet must not be deployed into an environment with an active normalized-source
receiver. A separate, explicitly authorized packet must add and test the narrow column/table
permissions before any caller is enabled. That later packet must leave transcription and delivery
reconciliation identities unchanged and must not introduce `SECURITY DEFINER` or a separately
connected projector identity.

## Recovery and evidence

Operational recovery disables callers and leaves the forward hardening migration and immutable
history in place. Downgrade exists only for disposable databases whose names end in `_test`; a
shared or PHI-bearing database must use a separately reviewed forward fix.

Acceptance requires disposable PostgreSQL evidence for forward migration, explicit trigger reads,
correction after a current projection, rollback restoration, stable identity and immutable-history
preservation, next-version projection, expiry/purge behavior, relevant races, and no privilege or
route expansion. No synthetic test contains names, dates of birth, clinical audio, or real PHI.
