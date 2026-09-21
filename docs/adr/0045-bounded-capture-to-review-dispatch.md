# ADR 0045: Bounded capture-to-review dispatch

**Status:** Local default-off runtime integration; no deployment or user activation.

## Decision

`CapturedProcessingRuntime` composes the existing encrypted capture worker,
translation planner, encrypted job store and immutable attempt committer. It
accepts trusted tenant/session context, not request-body identity. `run_pending`
discovers actionable captured sessions within one tenant, processes a bounded
page and returns a UUID cursor. Every target is reauthorized before processing;
discovery itself grants no capture, source-read or model-call authority. A caller
must carry the returned cursor through a sweep, then restart from its beginning.
This is a callable dispatch capability, not a registered scheduler/queue service.

The captured source provider excludes legacy/imported captures, unfinished capture,
revoked consent, expired content and non-actionable terminal/review-only records.
Expired last-attempt Speech leases and retryable jobs at the attempt ceiling are
reconciled to terminal metadata under consent/session locks, without another
provider call or a fabricated transcript. Translation also verifies the original
completed captured-Speech receipt before proceeding from source rows.
Transcription uses the existing
three-attempt bound and immutable manually selected language mode.

## Translation reservation and recovery

`PostgresTranslationJobStore.prepare_dispatch` uses the validated current working
evidence and existing pure Spanish-work planner. Under the established consent →
session lock, it reserves missing initial slots only, up to available batch
capacity. Existing slot uniqueness and serialized planning make competing workers
converge on one durable reservation. It never mints a second attempt for failed or
creator-rejected translations. A later explicit retry reservation can be picked
up, but creating that reservation belongs to a separate authorized command.

Previously stored results are reconciled first. Reserved calls use the existing
atomic claim/executor. A started call is in flight or uncertain: it is reported as
unconfirmed, never replayed automatically. Such a call does not occupy all dispatch
capacity or starve unrelated, unstarted Spanish segments. Only executable jobs
for the current source version are selected. Corrections, revocation and retention
are rechecked by the existing store immediately before provider admission or
commit. A changed source cannot receive the previous version's result.

The runtime validates the translation adapter/profile before processing and keeps
that binding stable within the runtime instance. Existing command/result records
retain the actual adapter/model profile. This does not provide cross-deployment
configuration admission or change the Azure model, prompt, endpoint or API.
Real configuration and runtime-client bootstrap remain a separate qualification.

## Human authority and status

Automatic processing never decides a review, publishes a note, assigns speaker
roles, creates an encounter or hands data to another provider. Explicit creator
acceptance remains necessary for translated text to become note-ready; English
speech and original Spanish source are preserved. Core alone generates SOAP.

The new internal worker reader reuses the same current-source/working fingerprint,
consent, retention and immutable-evidence checks as the creator reader. It writes
a distinct worker-read audit, never impersonates the creator, and is not exposed
as an HTTP endpoint. The original creator reader still checks the actor before
returning protected evidence. Internal receipts distinguish capture pending,
Speech processing/retryable/failed, translation pending/unconfirmed/retry-required,
review-required, quality-blocked and ready. These receipts are not a new public
status API; the paired authenticated receiver and failure/retry UX remain needed.

## Verification and recovery

Tests discover completed captures from actual local FastAPI protocol writes and
process encrypted generated WAV through the retained assembler into bilingual
storage, translation and explicit creator review. They verify exact English
handoff eligibility, no automatic reviews, separate worker audits, competing
reservation/execution, bounded pages, uncertain-call non-replay, retry boundaries,
changed source, revocation/retention, English/quality-blocked source and exhausted
Speech reconciliation. Lost reservation/result/commit-marker replies recover
without duplicate calls, including human acceptance before marker recovery.

A fresh actual Python process discovers and finishes a stored encrypted result
with Speech/audio/model methods forbidden. Its generated synthetic RSA key is
passed on stdin, not logged or written into source. This is synthetic storage/
runtime recovery evidence, not a real provider, microphone, native login, actual
Core SOAP, clinical-fidelity or signed-release acceptance result.

No migration, dependency, public route, auth parser, cloud setting, grant, live
provider call, push, PR or deployment is added. All tests use a new disposable
local database. Recovery leaves the runtime unconfigured and schema dormant.
Provider/credential lifecycle bootstrap, authenticated review/status/idempotency,
native clients, combined migration reconciliation and deployment/release acceptance
remain open. Independent review is still required before any eventual PR.
