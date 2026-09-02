# ADR 0027: Persist dormant normalized working transcripts

**Status:** Accepted for dormant synthetic implementation

## Context

ADR 0026 persists immutable translation and creator-review evidence, but no durable English working
transcript binds the exact evidence used—or records unused evidence that also affects the canonical
fingerprint. Handoff must not infer a projection from mutable session state or partial lineage.

## Decision

Revision `0013`, based on reviewed commit `c3c41662285565acd5aee1b63242e2ab63ea6300`
and architecture contract `356bbd839deacdcecb372035f7652d3f3436d0a7`, adds a stable nullable
working-transcript identity and nullable current version to configured sessions. Five forced-RLS
tables store immutable version headers, complete translation-attempt membership, complete review
membership, source-ordered English/unresolved segments, and canonical blockers.

A working identity starts at version one and cannot change; later versions are strictly monotonic.
Every version binds one current source version, counts, bounded SHA-256-shaped fingerprint, and
database-authored creation time. Exact composite foreign keys preserve source, selected
translation/review, and all-input lineage. Children are inserted before the header; the header seals
the version. Deferred checks reject missing or extra source segments, evidence memberships,
blockers, forged content, stale evidence, count/character mismatch, non-current pointers, expiry,
or purge. Old-version segments are excluded when validating a replacement projection.

For an opted-in working projection, status is exact: overlap or unknown locale yields
`quality_blocked`; otherwise missing, latest failed, or latest rejected translation yields
`translation_pending`; otherwise an unreviewed latest success yields `review_required`; and zero
blockers yields `transcript_ready`. Terminal transitions retain the immutable pointer under the
existing lifecycle rules. Older attempts and reviews remain bound as fingerprint inputs.

Updates are rejected. Deletes require the monotonic purge marker and normally cascade from the
source root. No grants, repositories, API/OpenAPI, workers, settings, bootstrap, handoff, migration
apply, deployment, or activation are introduced. The existing source-header trigger is rewritten
with behavior-equivalent explicit column reads so its current column-scoped runtime grant survives
the session expansion; that safe definition intentionally remains after a test-only downgrade.

## Consequences

- The schema is dormant until separately reviewed writers and least-privilege grants exist.
- Writers must compute the canonical fingerprint, retain unused failed/rejected evidence, and
  publish children, pointer/state, and header in one fenced transaction.
- Recovery stops callers and retains the additive schema. Downgrade is disposable-test-only and
  refuses nonempty working tables.
- Real-PHI activation remains blocked on legal-hold versus purge policy, adapter/model acceptance,
  and writer/race evidence.
