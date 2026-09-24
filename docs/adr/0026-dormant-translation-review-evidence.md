# ADR 0026: Persist dormant translation and creator-review evidence

**Status:** Accepted for dormant synthetic implementation

## Context

Architecture ADRs 0027 and 0028 require Spanish source text, English translation attempts, and
creator review to remain distinct, immutable evidence. Revision `0011` makes normalized source the
exclusive child root for configured external sessions, but it intentionally stores no derived
translation or review records. The receiver cannot precede senders safely until every later writer
shares the existing session fence and source purge removes all dependent plaintext.

## Decision

Revision `0012`, based on reviewed source authority commit
`9e44e8a8a25ca8f59f67326597e35a89c5f07d6b`, adds two dormant forced-RLS tables. A new exact
five-column unique source-segment key is the foreign-key boundary for both source identity and
version.

`normalized_translation_attempts` stores a tenant-unique Scribe translation UUID and a strictly
monotonic attempt version scoped to the exact current source-segment version. Only `es-US` to
`en-US` is valid. A succeeded attempt contains bounded nonblank English text and no failure code;
a failed attempt contains no text and a bounded code. Adapter and model profile IDs are opaque and
bounded. A trigger replaces caller time with the database clock.

`normalized_translation_reviews` mirrors a Core-issued review UUID, exact source and translation
lineage, terminal `accepted` or `rejected` decision, creator actor, and Core-supplied review time.
The actor must equal the configured session creator, the translation must have succeeded, and the
review time cannot precede database-authored translation creation. One exact translation version
has one terminal decision, and a partial unique index permits at most one accepted translation for
one source-segment version. Acceptance terminalizes that source-segment version: a later rejection
cannot reopen it. PostgreSQL cannot retain an input timestamp's original offset after conversion to
`timestamptz`; the domain/API contract remains responsible for requiring an offset.

Both insert guards lock the common `(tenant_id, session_id)` row before inspecting or allocating
derived evidence. Translation starts only in `translation_pending`; review starts only in
`review_required`. Deferred triggers recheck the current source, final allowed state, immutable
expiry, monotonic purge marker, and a fresh database clock at commit. Translation failures commit
only in `translation_pending`; accepted review may end in `review_required` or `transcript_ready`,
while rejection must return to `translation_pending`.

Before activation, the domain projection was clarified to preserve that rejection rule. For each
unresolved Spanish segment it evaluates only the highest translation version after first honoring
any accepted review. A rejected current success produces `translation_retry_required`, distinct
from an unreviewed current success (`translation_review_required`) and from a failed current attempt
(`translation_failed`). The retry blocker plus `translation_missing` and `translation_failed` map
to `translation_pending`; only the unreviewed-success blocker maps to `review_required`.
Historical unselected attempts and reviews remain complete working-fingerprint inputs.

Updates are rejected. Source-root deletion cascades through attempts and reviews only after the
purge marker is set; direct derived deletion uses the same marker gate. As inherited from the source
schema, a privileged deletion of the session parent can cascade after the parent disappears. No
application principal has that authority, so this packet does not claim protection from the
database owner.

The migration grants no table or function access to `PUBLIC`, runtime, transcription worker, or
delivery reconciler. It adds no repository, API/OpenAPI, worker, provider, setting, bootstrap,
handoff, migration apply, deployment, or activation path.

## Consequences

- The tables are unreachable dormant infrastructure until separate persistence and least-privilege
  packets introduce an authenticated writer.
- A later translation writer must perform its authorization/consent gate before this same session
  lock, map concurrent unique violations through readback, and prove both purge race orders.
- A later Core review writer must preserve exact Core review identity and distinguish identical
  replay from conflicting reuse without granting review authority to a provider or worker.
- Working-transcript storage must mirror these exact blocker and status rules before its dormant
  schema is published; versioned handoff follows it.
- Real-PHI activation remains blocked by the unresolved legal-hold versus unconditional fourteen-day
  purge policy and by acceptance of the exact translation adapter/model evaluation profile.
- Recovery stops future callers and retains the additive schema dormant. Destructive downgrade is
  restricted to an empty disposable `_test` database.
