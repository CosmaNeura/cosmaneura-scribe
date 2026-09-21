# ADR 0043: Atomic captured Speech-result publication

**Status:** Local, default-off runtime increment under the owner's existing approval.

## Decision

Connect a configured captured session to the persisted bilingual pipeline through
`CapturedSourceRuntime`. Admission consumes trusted Core encounter/creator/consent
fields and creates the exact captured profile from ADR 0042. An exact session-ID
retry reuses the same immutable admission; conflicting identity/profile fields or
invalid current consent are unavailable. This does not authenticate an HTTP body,
create an encounter, or introduce an identity provider.

The result publisher consumes a trusted worker's `SttResult` and exact job ID,
attempt and lease token. Under the existing consent → session → job lock order,
it requires the captured language/profile and an unexpired processing lease. It
normalizes the actual result itself; there is no separately supplied normalized
payload that can diverge from that result. It atomically saves normalized source,
publishes the initial English working projection and completes the job. A final
lease check after publication rolls back the whole transaction if ownership
expires. No raw legacy transcript or delivery is written.

The receipt key binds job, attempt and a hash of the lease token. After a completed
job, only that existing receipt and the same normalized result can recover the
publication. Missing bindings, changed results/attempts/tokens, later corrected
source, expired retention or revoked consent cannot create a new version. An
uncertain commit produces a fixed error with no raw exception context. Cancellation
propagates. The caller may retry the same command; this operation never calls or
repeats Speech/model services. Recovery remains pre-handoff, like the current
working-transcript publication/read boundary.

## Reuse and isolation

`ConfiguredSourceSessionRecord` carries an explicit immutable ingest mode; the old
external type name remains a compatibility alias. Three capture-only pre-source
states do not expand the imported-source status enum or public API. Captured
profiles are validated on reconstruction; imported records retain their defaults.

The normalized PostgreSQL repository and encrypted translation store select one
explicit ingest mode, defaulting to imported transcripts. The captured provider
selects `chunk_upload`. This reuses immutable source/translation/review writers,
creator-only reads, encryption, current-consent checks and retention. Existing
legacy/imported queries and routes do not expose configured captures. Legacy audio
writers explicitly reject configured sessions until the paired capture protocol
is integrated. Consent revocation closes configured capture leases as well as
legacy ones. No bootstrap grants or deployed settings change.

## Verification and boundaries

Tests use actual disposable PostgreSQL with a non-owner application role, synthetic
Speech results, generated local encryption keys and a counting translation adapter.
The loop preserves English speech, Spanish source, unknown roles and shared speaker
identity through encrypted execution and explicit creator review. Only the accepted
English projection passes the existing Core handoff serializer. This does not run
Core or establish clinical translation accuracy.

Checks cover default-off behavior, immutable admission retries, wrong tenant/job/
attempt/token, source/language rejection, revocation, lease expiry, simultaneous
completion, rollback after publication, cancellation, lost commit replies,
connection-pool restart, and actual independent-process recovery. One owned child
process exits after commit without returning its receipt; another recovers it with
one source and working version. Quality-blocked and English-only results retain
their existing semantics. The actual retention writer removes source/working and
encrypted-job content after test-only expiry, retaining its terminal metadata.

Fixture teardown may disable triggers only in the disposable database to remove
its exact generated tenant rows after assertions. This is not an application
deletion path. The stopped cluster and logs are retained; no other database or app
is touched. Recovery leaves this runtime unconfigured and the schema dormant.

## Remaining integration

This closes admitted-session/leased-result persistence and captured-mode access
to the existing translation/review pipeline. Capture protocol admission, audio
assembly, worker claim/heartbeat/result composition and automatic durable dispatch
are not wired yet. No HTTP route, native client, real provider invocation, Core
SOAP request, cloud change, push, PR or deployment occurs here. Those integrations,
real identity/device/fidelity acceptance, graph reconciliation and signed release
remain required for the full goal. Independent review remains a future PR gate.
