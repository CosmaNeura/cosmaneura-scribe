# ADR 0002: Adapt to the existing transcript model

**Status:** Accepted

The scribe keeps a richer internal transcript with speaker IDs, roles, channels, confidence, and
timestamps. At handoff it maps clinician/patient roles to the current `Doctor`/`Patient` speaker
labels and camel-cased millisecond timestamps. Note styling remains outside this repository.

The canonical platform accepts this payload at `POST /internal/v1/scribe/transcripts` with an
`Idempotency-Key`. The endpoint runs behind the platform's existing authenticated staff session,
derives ownership from the appointment, rejects mismatched doctor/patient IDs, and queues the
existing note-schema and engagement jobs only on first import. This supports P0 through the current
upload UX without introducing a second note engine or a new service credential.
