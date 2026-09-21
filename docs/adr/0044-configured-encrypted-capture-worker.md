# ADR 0044: Pair encrypted capture with the bilingual worker

**Status:** Default-off local integration; not a deployment or client acceptance.

## Decision

Reuse the existing capture protocol and encrypted audio assembler for the captured
format admitted by ADR 0042. `CapturedSourceRepository` explicitly selects that
format for capture-key, lease, reservation, authorization, chunk, finalization,
manifest and transcription-job access. The default repository remains legacy;
normalization/translation defaults remain imported-source. SQL selection uses
fixed aliases/literals, never request data or automatic rewriting of arbitrary
queries. No environment setting selects this provider in a running API.

The recorder's existing status model represents only capture progress. Captured
source-received, translation-pending, review-required and quality-blocked states
project to `processing`, never `transcript_ready`. Current detailed evidence stays
in the creator review service. The recorder writer may advance only real capture
phases; it cannot write a projected status backward or mark a source ready/failed.
Legacy transcript/delivery guards remain unchanged. Accidentally pairing the
legacy worker with the captured provider fails before audio/provider access.

`CapturedTranscriptionWorker` reuses extracted `LeasedAudioTranscription` behavior
for encrypted assembly, lease heartbeat, last-moment consent/lease validation and
child-task cancellation. The legacy worker retains its original transcript/role/
quality policy. The captured worker derives language from immutable admission,
requires finalized contiguous channels, validates returned channel/language/profile
evidence, and gives the actual result to ADR 0043's atomic publisher. It does not
infer clinician/patient role from language or microphone location.

Before manifest disclosure, the configured path checks current consent/retention.
Its heartbeat cannot renew after revocation or outside processing. Failure updates
match the current job/session/attempt and unexpired lease; they cannot mark a job
completed. The source publisher owns configured application completion. Provider
failures allow the existing bounded later attempts, not retries inside one call.
Cancellation or process loss leaves a recoverable lease. Invalid source and
exhausted attempts leave a terminal job, with no invented source/ready status.
The future detailed status receiver must expose terminal-job failure explicitly;
the recorder-phase `processing` projection alone is not sufficient failure UX.

## Recovery

A completed job is acknowledged through its original source receipt and current
consent/retention, without assembling audio, calling Speech, rerunning translation,
or republishing a review. This metadata-only acknowledgment is separate from the
publisher's exact-result retry and does not return protected content. Later
working revisions are not reset. Lost publication responses converge to the same
completed job; existing encrypted translation recovery remains unchanged.

Recovery from this release is to leave the new worker/provider unconfigured and
retain the dormant schema. No migration, existing-record conversion, public API
change, auth parser, grants, cloud action or deployment is part of this increment.
Normal API defaults still do not expose configured capture sessions. A future
paired authenticated receiver is required before standalone/native clients use it.

## Evidence and remaining work

Tests explicitly inject the provider into the existing FastAPI capture routes,
bind a synthetic key, issue/renew capture leases, reserve/authorize/register real
AES-GCM encrypted generated WAV chunks and complete the capture. The actual
assembler reads the restricted PostgreSQL manifest and reconstructs exact PCM;
an offline counting Speech fixture returns fixed bilingual evidence. The existing
encrypted translation executor, creator review and Core handoff serializer then
verify preserved source and English speech, with no handoff before acceptance.

Additional checks cover default-off/wrong-scope/legacy-worker rejection, English
capture, invalid provider/language/channel results, retry exhaustion, revocation
at manifest/heartbeat, tampered ciphertext, lease theft, concurrent workers,
cancellation, lost commit acknowledgment and completed recovery in a fresh Python
process. No SQL fixture shortcuts are used to advance the new protocol trial's
capture or create its source. Earlier low-level publisher tests retain their
explicit synthetic processing setup.

Identity, key custody, blob transport and Speech/model responses are offline
fixtures in this packet. It is not actual microphone/Zoom/iPhone, real sign-in,
clinical fidelity, real Core SOAP, signed distribution or MCD launch acceptance.
Automatic transcription/translation dispatch, authenticated review/idempotency,
client wiring, migration-graph reconciliation and eventual independent PR review
remain required. No other task is contacted or inspected for coordination.
