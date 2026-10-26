# Scoped speech-boundary observation

Tier 2. Owner: the Scribe virtual-lab operator. This change supplies diagnostic
metadata for a newly consented synthetic capture; it does not qualify a past
capture or change transcription, consent, source storage, roles, or retries.

## Problem and boundary

The opt-in `SpeechBoundaryObservation` callback was not installed by
`captured_worker_job_runner`. A completed job and persisted speaker UUIDs
therefore could not establish the actual Azure request's diarization options
or the raw response's missing-speaker count. In the original iOS13 R2 run,
40 persisted source entries and two speaker UUIDs were observed, all with
semantic role Unknown. Its raw Azure response counts remain unavailable.

The speech branch now optionally installs one observer after the worker's
existing configured-tenant validation. The normal shared consent/lease check
still runs immediately before provider execution. A scope is diagnostic input,
not permission to process any tenant, session, or audio.

## Configuration and expiry

`COSMANEURA_SCRIBE_CAPTURED_SPEECH_OBSERVATION_SCOPE` is absent by default.
When explicitly selected for the next synthetic capture, it contains one JSON
object, at most 1024 UTF-8 bytes, with exactly these fields:

| Field | Required value |
| --- | --- |
| `version` | Integer `1` |
| `tenant_id` | Nonzero UUID equal to the worker's validated tenant |
| `session_id` | Nonzero UUID from the actual new capture admission |
| `consent_record_id` | Nonzero UUID from that capture's actual valid consent |
| `issued_at` | UTC ISO timestamp at or before activation |
| `expires_at` | UTC ISO timestamp after issuance, at most one hour later |

Duplicate or extra keys, invalid types/UUIDs/timestamps, future issuance,
expired scopes, or mismatched requests disable observation silently. Malformed
scope text cannot prevent settings construction or worker startup. Matching and
expiry are checked both before each provider call and when its result arrives.
An expired result produces no diagnostic event and follows normal publication.

No checked-in active scope or deployment configuration is supplied. Initial
cohort is exactly the one approved synthetic tenant/session/consent tuple, after
normal consent. Remove the setting after that run; expiry is also enforced in
the process. A new capture requires a new exact scope and fresh expiry.

## Emitted evidence

A successful observed provider response emits one closed JSON event,
`captured_speech.provider_boundary`, with a generated call UUID, track index,
exact session/consent/validated tenant UUIDs, scope hash, observation time, SDK
version, and the actual diarization `enabled`/`maxSpeakers` values from the SDK
serialization of the same options body passed to `transcribe`.

The event contains raw phrase, missing-speaker and distinct non-null speaker
counts, plus those counts after the existing nonempty-text/positive-duration
filter. `accepted_distinct_speaker_count` additionally includes a missing-ID
bucket when present; it is not a claim that a missing ID represents a person.
Speaker IDs themselves, wording, paths, object names, URLs, keys, confidence,
and arbitrary scope strings are absent. Numeric ranges, UUIDs, SDK version,
field names and optional WAV header fields are checked before logging.

Only the first canonical 44-byte WAV header is inspected. Inspection happens
after the provider has successfully consumed the stream and restores the prior
position in `finally`; an unreadable/noncanonical header is reported as absent.
A diagnostic factory, header, metadata, or sink exception cannot fail successful
speech publication or cause another ASR call. Existing provider/input failures
and cancellation retain their normal handling. Provider arguments, options,
channel selection and privacy logging flag are unchanged.

This event proves only the observed SDK/provider boundary. Durable publication,
job attempts, persisted source/working versions, speaker UUID counts, semantic
roles, note fidelity and normal UI save/reopen require separate evidence. It
must never manufacture Doctor/Patient roles from fixture voices or count a
synthetic SDK test as a live provider response.

### Correlation with a newly committed source

A response log can precede a failed publication. Job attempt count alone is not
lineage: the supported terminal-job restart can reset it to one. Existing
application/worker roles can insert audit events but are not granted audit
history reads. No new database access is introduced to reconstruct that history.

For an enabled scope, the provider now carries bounded, immutable call/track
metadata on its exact returned `SttResult`. It is absent by default and excluded
from equality and repr; it is never a transcript field or stored payload. Only
a complete set of observations for the assembled tracks is carried forward.

After `publish_speech_result` returns from its transaction, the normal captured
worker may emit `captured_speech.source_publication`. The event binds the actual
job ID/attempt and new source receipt ID/version to the exact result's call IDs,
track channels, accepted counts and aggregate segment/speaker counts. Channels
are a closed capture enum, not speaker roles. The source writer checks the
normalized request fingerprint as part of acceptance; this diagnostic only
accepts its `ACCEPTED` disposition for source version one. `REPLAYED`,
`CONVERGED`, `CORRECTED`, completed-job recovery and failed/uncertain transaction
returns never attest a later result to an old receipt. No receipt, fingerprint,
storage or transaction behavior is changed.

The same exact tenant/session/consent and one-hour expiry are checked again at
completion. Missing, partial, inconsistent, expired or failed diagnostics stay
silent without failing the committed job or triggering another ASR call. A
lost commit reply may leave a valid source without this event; that remains
unqualified attribution. The event is not an inventory of HTTP attempts or a
claim about roles. Acceptance must join its exact call IDs to response logs and
its receipt/version and counts to the actual persisted source; neither a
matching session nor an unrelated successful response is sufficient.

## Validation and release sequence

Local regressions exercise the installed SDK multipart serializer, accepted
phrase filtering, two distinct call UUIDs for two tracks, JSON compatibility of
the existing callback, scope silence/expiry, bounded log schema, revoked consent,
and isolated failure paths. A fresh disposable PostgreSQL database exercises
normal consent/admission, encrypted chunk assembly, captured-source publication
and completed-job recovery with no observer, a working observer, and a failing
sink. The provider response is an offline SDK fixture; no ASR call is made.
Completion regressions additionally cover failed publication followed by the
normal retry, lost commit replies, repeated completed recovery, idempotent
receipt reuse with new call IDs, conflicting results, and sink/expiry failures.

Before activation, independently review the final pushed source. Reconcile the
current speech job's immutable image, full source/configuration, entrypoint,
identity, SDK and schema with merged main. The existing deployed job predates
this source; do not overwrite that drift or reuse an old release authorization.
Build and verify the selected merged candidate, including a network-disabled
image smoke, then review the exact staging-only rollout and scope change. Keep
other jobs, application/API configuration, identities and schema intact.

After deployment, use a fresh normal native capture with valid consent. Bind its
actual request/provider metadata to the same session/consent and separately
verify source publication, original note, normal save/reopen and staging
content. No diagnostic replay or regeneration of original iOS13 is permitted.

Recovery first removes the exact diagnostic scope or lets its bounded expiry
silence it; this changes no capture authority or data. For a code defect,
reconcile deployed state and prepare a reviewed current-trunk forward repair.
Do not revert to a stale image, delete source history, replay a successful ASR
job, or infer a successful observation from missing logs. No schema migration,
new dependency, grant, or production promotion is part of this change.
