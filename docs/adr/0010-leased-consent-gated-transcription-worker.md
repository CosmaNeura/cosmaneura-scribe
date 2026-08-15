# ADR 0010: Transcription uses consent revalidation and durable job leases

**Status:** Accepted

## Decision

Transcription orchestration is independent of Blob assembly and the speech provider. A worker
claims one tenant-scoped PostgreSQL lease per session, validates consent before audio assembly,
renews its lease during assembly and STT, revalidates immediately before STT and persistence, and
commits lease completion, transcript, session state, and metadata-only audit together. A failed
renewal cancels in-flight work. Provider and assembly errors are represented by fixed codes and
receive bounded retries; consent and metadata-quality failures are terminal.

For virtual visits, separate capture channels provide strong role priors: microphone is clinician
and system audio is patient. In-person, phone, and mixed audio remain unknown. Provider speaker
identifiers are preserved and channel-prefixed. No language-model role inference is introduced in
this slice.

## Consequences

- At-least-once job delivery does not create multiple transcripts; an active lease prevents
  simultaneous provider calls.
- An expired lease can recover a session after worker termination. A live worker renews its lease
  periodically and cancels provider work if ownership is lost.
- Revoked or mismatched consent stops audio processing at each custody boundary.
- Transcript text, audio paths, Blob names, endpoints, and provider exceptions remain outside job
  rows, audits, and operational error messages.
- Production activation still requires the encrypted Blob assembly adapter and a separately
  reviewed internal trigger.
