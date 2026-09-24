# ADR 0047: Configured capture admission and Core reviewed English notes

Status: accepted for dormant local implementation, 2026-09-21.

The owner approved the exact configured admission/Core SOAP packet after the
earlier creator-review integration. The existing checkouts and auth boundaries
remain in place. No hosted, native, live-service or release activation is included.

## Decision

Expose POST /v1/captured-sessions behind the existing Entra workload dependency
and an explicitly injected, default-off CapturedAdmissionRuntime with a tenant
allowlist. Core reserves the session UUID, internal creator and manual supported
language mode before remote work. Creator identity comes from Core's current
binding and trusted header; it is forbidden in the request body. Consent and
opaque encounter/provider/patient references use the existing consent receiver.

Scribe claims the exact request/key and calls the same admission repository
primitive as CapturedSourceRuntime in one transaction. It rechecks consent even
on replay. The receipt describes immutable admission metadata, never permission
to record or resume. No provider or translation call occurs at admission.

Core's optional configured_capture journal column is null for legacy admission.
A generated additive revision prohibits changing that selection, including
converting old rows. Resume preserves the original family, UUID, actor, language,
payload and remote key. Existing admission behavior remains available separately.

Core reads the existing creator-review contract. It requires current consent,
creator, session, source profiles, manual language and ready English working
transcript. Only preserved English and explicitly accepted Spanish-to-English
segments become canonical note input. Original source, translations and reviews
remain in Scribe; no raw-source or gap evidence is manufactured.

An immutable Core reviewed-source mapping retains the actual source/working
versions and digests separately from the canonical import payload hash.
The first snapshot uses Core's existing Scribe importer with background dispatch
disabled; later reviewed revisions retain earlier transcripts and require a new
note. Core's existing SOAP prompts, generation, publication, creator reads,
versioned edits and recovery remain the note path. Translation acceptance never
marks a clinical note approved. Fresh authority and source checks fence publication.

Configured capture operations use creator review for current consent/creator
preflight. Legacy raw transcript, correction, gap and recovery envelopes remain
unavailable for configured captures. Native host selection, interruption/recovery
adapters, credential lifecycle and runtime activation still require qualification.

## Local schema and recovery

Core revision c8526f5e8d80 expands local parent 9172abd84a3d. Scribe keeps its
separate 0019_captured_bilingual head with no migration in this increment.
Both histories were inspected; this does not reconcile deployment branches or
authorize applying either graph to an existing/shared database.

Rehearsal uses newly owned synthetic PostgreSQL databases with private Unix
sockets and no TCP. Check exact admission recovery, rejected/mismatched source,
English-only canonical persistence, note version/reply recovery and revocation
using generated audio and offline Speech/translation/note fixtures. Retain the
Core incremental patch separately from pre-existing dirty work.

Recovery leaves receivers/facades disabled and additive evidence unused.
Do not downgrade evidence, convert existing sessions, change shared auth,
replay completed live trials, deploy, push or create a PR under this approval.
See the latest real-services checkpoint for exact verification and retained logs.
