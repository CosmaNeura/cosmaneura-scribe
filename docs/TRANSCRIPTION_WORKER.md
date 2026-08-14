# Transcription worker

The worker turns one uploaded, consented capture session into one durable transcript. It is a
library boundary today; no public route or Azure job trigger is enabled by this change.

## Processing sequence

1. Lock the tenant-scoped session and return the existing transcript on replay.
2. Validate the persisted consent record against the session before reading any audio metadata.
3. Claim a PostgreSQL transcription-job lease and move `uploaded` to `processing` atomically.
4. Pass ordered encrypted chunk metadata to the replaceable audio assembler.
5. Revalidate consent after assembly and immediately before speech-to-text.
6. Preserve provider speaker IDs and prefix them with the capture channel. For virtual visits,
   separate microphone and system audio supply clinician/patient role priors; in-person, phone, and
   mixed audio remain `unknown` for later review.
7. Apply metadata-only duration, segment-count, ordering, and timestamp quality gates.
8. Revalidate consent, verify lease ownership, persist the transcript, complete the job, move the
   session to `transcript_ready`, and write a metadata-only audit event in one transaction.

Failures expose only fixed codes. Ordinary provider or assembly failures become `retryable` until
the configured maximum attempt count; consent and quality failures are terminal. An active lease
prevents concurrent duplicate transcription, while an expired lease may be reclaimed after a
worker crash. A stale worker cannot persist after losing its lease, although provider work may be
duplicated after lease expiry until heartbeat renewal is added at activation. Transcript replay
avoids a second provider call.

## Remaining activation boundary

`AudioTrackAssembler` intentionally has no production implementation yet. That adapter must:

- use managed identity and private Blob connectivity;
- download only object IDs registered to the tenant/session lease;
- verify ciphertext size and SHA-256 metadata before decryption;
- retrieve wrapping/key material through the separately reviewed key-custody design;
- assemble ordered channel tracks in encrypted ephemeral storage;
- return no blob URL, object path, transcript, or patient value in logs or errors; and
- securely clean temporary material when its async context exits.

The worker must not be connected to a queue, Container Apps Job, or production storage until this
adapter, the de-identified benchmark, RBAC, private networking, retry costs, and operational alerts
are separately reviewed.
