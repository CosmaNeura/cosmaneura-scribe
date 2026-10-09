# ADR 0067 — Explicit creator corrections preserve source evidence

Accepted for the owner-approved Scribe UX implementation, September 30, 2026.

`POST /v1/captured-sessions/{session_id}/review/edit` is an additive action behind
the existing trusted-platform creator boundary. Each request binds the current
source version, working ID/version, corrected segment versions, and explicitly
confirmed speakers. The immutable edit row and next working projection commit
with one existing tenant-scoped idempotency claim. Replays reauthorize the
creator and recover the saved receipt; reads do not mutate.

The external transcript ingest contract gains no human-edit fields. Corrections
are applied only by persisted working derivation, so incoming vendor evidence
cannot assert human confirmation. Original Spanish and English source remain
unchanged. Accepted translation evidence remains unchanged; a corrected English
working view records the explicit edit separately. Existing quality blockers
and translation-review gates remain authoritative.

The new table is append-only, protected by forced tenant RLS, live creator
insert/commit checks, original-source/working foreign keys, and the existing
purge-only deletion fence. Working completeness checks accept a different role
or wording only when exact immutable edit evidence supplies it. Existing
derived readers receive SELECT; only the creator runtime receives INSERT.

The reusable panel displays searchable timestamped turns, original/English
comparison, explicit role/name confirmation, and version history. It requires
an encrypted host journal before enabling edits. Protected corrections never
enter the metadata-only translation journal or browser plaintext storage.
Saving a correction does not imply clinical review, regenerate a SOAP note, or
overwrite existing note edits. See the associated flight plan for rollout and
forward-compatible recovery.
