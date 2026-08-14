# ADR 0008: Transcription uses consent revalidation and durable job leases

**Status:** Accepted

## Decision

Transcription orchestration is independent of Blob assembly and the speech provider. A worker
claims one tenant-scoped PostgreSQL lease per session, validates consent before audio assembly,
revalidates immediately before STT and persistence, and commits lease completion, transcript,
session state, and metadata-only audit together. Provider and assembly errors are represented by
fixed codes and receive bounded retries; consent and metadata-quality failures are terminal.

For virtual visits, separate capture channels provide strong role priors: microphone is clinician
and system audio is patient. In-person, phone, and mixed audio remain unknown. Provider speaker
identifiers are preserved and channel-prefixed. No language-model role inference is introduced in
this slice.

## Consequences

- At-least-once job delivery does not create multiple transcripts; an active lease prevents
  simultaneous provider calls.
- An expired lease can recover a session after worker termination. Until activation adds lease
  heartbeat renewal, a stale live worker may duplicate provider work but cannot persist after
  losing its token.
- Revoked or mismatched consent stops audio processing at each custody boundary.
- Transcript text, audio paths, Blob names, endpoints, and provider exceptions remain outside job
  rows, audits, and operational error messages.
- Production activation still requires the encrypted Blob assembly adapter and a separately
  reviewed internal trigger.
