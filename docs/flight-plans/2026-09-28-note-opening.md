# Coordinated note opening

Owner: MCD operational beta owner. Initial cohort: approved synthetic staging
encounters. Tier 2 because negotiated credentials span the coordinated reads;
identity verification and authorization checks remain unchanged.

## Outcome and reuse

The measured Mac24 transcript-to-note handoff took 11.021 seconds across four
native requests, with its final two requests overlapping. Each request repeats
Core negotiation. A new optional receiver operation reuses the existing Core
review, template and note readers under one request-local negotiation. One
template permits an existing-note read; zero or multiple templates preserve
the current provider-selection flow. This does not generate or save a note.
Request-count savings are not a measured latency improvement.

## Contract and bounds

The catalog advertises `note_opening_v1: true`. A capable client may POST
`{workspace_id, binding_ref, request_nonce, expected_session_id}` to
`/provider/v1/note-opening`. The normal scoped envelope has operation
`note_opening` and receipt `{session_id, review, templates, note}`. An unready
review has null templates/note; zero or multiple templates have a null note.
A single note must match the fresh reviewed transcript lineage and schema.
The client must apply its existing strict review, template and note parsers.

The response retains the existing native review byte limit. If the combined
payload would exceed it, the receipt is instead exactly
`{session_id, separate_reads_required: true}`. The client can then use existing
separately bounded reads. Access denial, malformed replies and source mismatch
must fail closed; they are not capability absence or size fallback.

Every Core request still checks current registry access before and after I/O;
the receiver checks it again before publication. Deterministic child nonces
and keys distinguish all three reads. Credentials never persist beyond the
request, and all later actions negotiate afresh. The total operation is bounded
to 100 seconds and does not retry after timeout or cancellation. Existing
consent, recording custody, save recovery and human review remain in place.

## Receiver-first rollout and recovery

1. Merge the receiver with local transport, real frozen identity/PostgreSQL
   receiver checks, lint, types and implementer review of the tested commit.
2. Add capability-gated Mac/iPhone consumption, including strict parsing,
   disposal guards and explicit size fallback. Ship the native bridge, main
   process and renderer together; do not reuse an incompatible old bridge.
3. Reconcile staging against the deployed source/image, then update the merged
   receiver under the existing release authority before native activation.
   Old clients ignore the added catalog field and retain their current path.
4. Install a new signed native candidate and measure the same synthetic saved
   note. This native release is the activation control, expiring at acceptance
   or candidate replacement. Preserve prior signed packages and all local keys,
   journals and recordings. No microphone or fixture write is needed to reopen.

Before client activation, restore the previous approved receiver image. After
activation, restore the previous native client before restoring the receiver;
a new client with a freshly loaded old catalog also uses its legacy path.
Do not silently downgrade a failed authorized request. No migration, stored
transcript format, environment configuration or Core/Session Prep API change
is required. Physical capture/continuity acceptance remains separate.

## Matched client

The Mac/iPhone backend captures the advertised capability per authorized mount.
Native requests use a 1 KiB body bound, the existing review response/frame bounds
and the existing note transport timeout. The desktop main process additionally
checks the closed read-only intent before native dispatch.

An explicit Continue-to-note action reads the coordinated result and reuses the
existing review parser, template validator and note hash/lineage validator. Its
local one-use handoff is discarded on review refresh, disposal or access loss.
The same hook runs after upload; existing confirmed-upload custody release must
finish before showing the note. No cached credential or prior action result is
used for a subsequent generation, template selection or save.

Only the explicit size receipt invokes the legacy reads. The compiled UI checks
cover both workspace and desktop renderer paths, including older receivers,
multiple/no templates, unready review, hash mismatch, cancellation and refresh.
Measured latency and native deployment acceptance remain release follow-ups.
