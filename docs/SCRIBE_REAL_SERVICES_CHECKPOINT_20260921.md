# Scribe real-service qualification — 2026-09-21

Status: meaningful implementation and real-service/build evidence; **not a beta
release or closure of the five owner goals**. Scribe edits remain on
`codex/beta-preintegration-20260904`, based on `1e48c124f355f486d8106c7f7441fd13895c3c97`.
The latest increment also includes explicitly approved local Core consumer edits
in its existing integration checkout. No push, PR, existing/shared database
migration, Auth/IAM/Zoom/staging edit or deployment occurred. Earlier migration
tests used a new disposable local cluster. Following explicit owner approval,
the existing private Speech job passed both disabled-state and enabled synthetic
acceptance. The enabled trial temporarily changed only its environment settings
and added one account-scoped Speech User assignment; both were reversed and the
original resource/output state verified. No clinical runtime was activated.

## Latest: approved local provider workspace

Recovery update: after an abrupt stop, the source commits remain intact but the
temporary W13 candidate and local evidence directories are absent. See
`beta/SCRIBE_RECOVERY_20260921.md` for verified durable archive recovery, the
rebuilt provider bundle and separate native diagnostic awaiting launch approval.
Temporary evidence links below describe the historical run, not presently
retained files. No completed live-service trial was repeated.

The owner approved completing the local configured capture → review → existing
Core SOAP and creator encounter flow. On the same Scribe branch from fe93564a,
the separate provider entry now mounts encounter selection, manual language and
consent, the retained recorder, creator transcript review, Core template/note
preparation, edits/save recovery and navigation to the existing Core encounter.
Configured recording uses Core's admitted session and never requests legacy
admission or raw transcript endpoints. Exact pending requests use scoped,
encrypted, revision-checked journals. Notes retain Core's unreviewed status.

The actual browser components passed over local Core/Scribe HTTP routes, with
48,000 generated PCM frames encrypted by the recorder and decrypted intact by
the assembler. One offline Speech and one translation call produced preserved
English/Spanish source; explicit acceptance gated notes. The browser recovered
lost admission/save replies, and Core retained one canonical transcript and two
note versions. Its existing outline/JSON-note pipeline was used. Mobile layout,
creator encounter read and logout clearing passed. No external provider call or
auth activation occurred. Full capture regression: 135 passed; review UI: 18.

Passing evidence is `/private/tmp/scribe-configured-core.provider.wtRDMA/recheck/`.
The same root preserves the earlier failed fixture attempts, final targeted
checks, screenshots, exact scripts, Core preservation check and stopped-cluster
metadata. The new private-socket PostgreSQL PID 4264 was stopped; historical
clusters/demos/native artifacts were untouched. All 82 previously dirty Core
files still match the saved configured packet manifest; this increment did not
edit Core or its schema. See `beta/SCRIBE_PROVIDER_WORKSPACE_20260921.md` and ADR
0048 for the host contract, validation limits, recovery and remaining full goal.

This closes the local provider UI increment, not operational beta acceptance.
The existing native authenticated hosts must supply the real encounter/mount
transport and device storage/lifetime before activation. Tester sign-in, token
custody, iOS 17+/desktop physical acceptance, reconciled runtime and reproducible
signed releases remain open. The public URL still serves the older preview.

Current native observation: the physical iPhone 12 is connected with developer
services, iOS 27.0 and W13 1.0/build 1 installed. The owner has not completed
Tester sign-in. At the owner's request the retained W13 Mac app was quit and
reopened; its fresh sign-in reached the helper but ended with secure session
unavailable. Hosted-auth creation returned 200 in fixed metadata diagnostics;
no successful login/callback or custody acceptance is established. Port 8046 had
no observed listener. The next critical-path work is actual native sign-in and
authenticated host composition, preserving all identity/policy boundaries.

The local provider increment is committed as
`abea802b0d3c66e5945d74024ee1ecd5c3a8f899`. Its clean-source preview build passes
the mandatory microphone/attestation boundary check, and its separate provider
bundle builds. `committed-builds.json` in the evidence root binds the artifacts.

Native presentation diagnosis is prepared at
`/private/tmp/scribe-w13-presentation.gtjhyhm2/`. Its separate Mac candidate was
compiled from the retained pinned W13 native source, adding only fixed stage
markers and relocating existing metadata diagnostics. Bundle/configuration,
callback and Keychain policy are unchanged. All 315 original Mac candidate
manifest entries still match. The original unavailable W13 process was quit.
Automatic approval review rejected launching the newly built diagnostic because
it requires user confirmation at launch time. The specific launch question is
pending; the diagnostic has not run. Do not bypass that decision, restart the
old API/database, or infer hosted-login success. This is a presentation
diagnostic, not a new beta release or a native provider-workspace composition.

## Previous: approved configured admission and Core SOAP workflow

The owner approved "the configured admission and Core soap packet." Work stayed
on the existing Scribe branch from clean 5404d4c and the existing detached Core
checkout e21ba4c. No other task was contacted; all prior Core work was snapshotted.

The local backend workflow now admits a new manually configured capture, returns
persisted source and translation review, and sends explicitly accepted English
through Core's existing canonical transcript import and SOAP engine. Notes stay
unreviewed, creator-scoped and in the same existing encounter. Existing Core note
reads, edits and lost-response recovery are reused. Original Spanish, English
speech and immutable review history stay preserved in Scribe.

Scribe POST /v1/captured-sessions is default-off and uses existing Entra workload
authentication plus the trusted creator header. Its transaction claims the exact
request key and reuses the existing captured admission/consent primitive. Core
reserves UUID, creator and language before contact; retries cannot change family
or configuration. No creator is accepted from a browser body. Core's additive
configured reservation and reviewed-source mapping prohibit converting legacy
admissions or overwriting provenance. Neither product acquired a second note
engine, login mechanism or automatic provider retry.

Two actual local HTTP scenarios passed Core route → Scribe admission (including
a lost committed reply and fresh runtime) → encrypted generated capture →
offline Speech/translation → explicit accept/reject → Core SOAP/read. Accepted
English and preserved English speech reached the existing prompt/import path;
rejection and revoked consent blocked notes. Workload identity, audio, storage,
keys and all model responses were synthetic fixtures. This is backend integration
evidence, not a native provider app, real-login or live clinical workflow claim.

Focused verification has passing evidence for all 183 distinct Core checks and
85 Scribe checks, plus both child HTTP receiver processes. The broader Core run
initially omitted 67 legacy cases because of a temporary runner's duplicate
module imports; a corrected isolated runner passed all 82 legacy cases. Evidence
review then fixed guard assertions that had failed on TypeID formatting before
reaching their triggers, and bounded overlength generated database names.
All 14 affected cases passed again in a second fresh cluster; its log confirms
the actual immutability guards fired. Original logs remain retained.
Affected Ruff, Core/Scribe Pyright, generated OpenAPI/TypeScript, capture/review
TypeScript and ADR/whitespace checks pass. The unchanged native/UI rendering
was not requalified or repackaged during this backend increment.

Core fresh and incremental schemas reached generated revision c8526f5e8d80 from
parent 9172abd84a3d, with 74 tables and matching new columns. Scribe retains its
separate 0019_captured_bilingual history without a migration here. This does not
reconcile a deployable/shared migration graph. Only new owned disposable local
databases were used. Both private-socket clusters had no TCP listener; verified
owned PIDs 65088 and 77092 were stopped and confirmed absent. Earlier clusters,
owner demos and native artifacts were preserved.

Evidence: /private/tmp/scribe-configured-core.h44yns4x/.

- core-increment.patch SHA-256:
  f7f3b3b35832a3769eec6b716672041422a7149d4c6b8559595902e8234ea58e.
- verification.json maps the exact test identities and XML hashes; core-final.xml,
  legacy-final.xml and guards-final.xml jointly cover the Core collection.
- scribe-final.xml SHA-256:
  a9c4230e900b8ebcf435a4241bc0a135ed621476c10f1a0f24291f9585d1069d.
- core-final/test_configured_admission_revi0/ and ...revi1/ retain wire receiver
  logs/XML. shutdown.json and guard-rehearsal/shutdown.json retain process checks.
  The first database list includes only names retaining the _test suffix;
  earlier truncated-name rehearsal databases also remain in its stopped cluster.
- Core's 75 prior dirty files are preserved: 69 byte-identical, six approved
  extensions and seven new packet files. The patch is relative to that before
  snapshot and passes reverse-apply checking. Core remains uncommitted.

The full operational goal remains open. The host still needs actual configured
admission/recording/note-screen binding, native identity and token custody,
processing/provider credential lifecycle, configured interruption recovery,
desktop/iPhone fidelity and signed releases. Legacy raw/gap recovery envelopes
remain unavailable for configured sessions; no evidence was fabricated to make
them compatible. The approved packet excludes hosted/native activation, shared
auth/environment changes, live trials, device/signing work, deployment and PHI.
Those are remaining authority/acceptance boundaries, not completed features.

## Earlier: approved local Core creator-review integration

The owner approved the exact Core review-consumer packet ("I approve core
integration"). Before editing, Scribe was clean at `fea25741eb133eb85779316e650212c5a3669ced`
and Core's existing detached checkout remained at
`e21ba4c1fb1027de8123aca9b8aee25b8a11b612`. All 70 existing dirty/untracked Core
files were snapshotted. Sixty-six remain byte-identical; only the four approved
existing service modules were extended. No other task was contacted.

Core now accepts `creator_review` and `decide_translation` through its existing
disabled capture facade. Fresh encounter/admission authorization supplies the
binding's internal actor, never a doctor-ID inference or browser assertion.
Scribe's review receiver matches it to the configured session's immutable
creator and checks processing consent. Core reauthorizes before returning
protected results. Legacy transcript-status checks remain separate because they
reject configured bilingual sessions.

The closed consumer validates current source/working/queue/progress lineage,
English-source preservation and review readiness. The existing server Entra
transport sends bounded no-store requests, preserving the exact decision and
retry key, with no automatic retries or provider calls. No new runtime, host,
schema, authentication policy or note generator was activated.

The final focused run collected 146 Core checks: 145 passed and one collided with
a fixed synthetic support-user identity in an older reused test helper. The new
test now creates its own unique identity; all five authority checks then passed.
Matched test identities establish passing evidence for all 146 distinct Core
checks, with zero skips. The original failed run is retained. Ruff, Pyright for
the five changed Core services and whitespace checks pass.

Two separate Scribe receiver processes passed actual local Core-route → HTTP →
Scribe-receiver accept/reject scenarios. They covered mismatched expected-source
version, wrong tenant/unmapped creator, ignored browser actor assertion, lost
committed reply, fresh receiver recovery, one immutable decision, unchanged
source and consent revocation. Core used real local binding/admission authority;
its workload authentication and Scribe workload authentication were explicit test
fixtures. Encrypted WAV, Speech and translation were synthetic fixtures. No live
service, hosted identity, native device, TLS deployment or SOAP completion is proved.

Evidence is retained in `/private/tmp/scribe-core-review.gsg9ll_6/`:

- `core-increment.patch` separates these nine Core files from prior dirty work;
  SHA-256 `7d74f9565242d3d143136367711f78f75839f6bdf0f2444d5885e658e93e0594`.
- `final.xml`: `01d99e003dc350ce1f7ff97f3b0400e43ce446b3bc956caac4b1403360c1ed6a`.
- `authority-final.xml`: `a183a65099230e53a9c64ffedaa7320a85d7d6582843720e4bfb1b107171ebdb`.
- `final/test_core_to_scribe_review_and0/` and `...and1/` contain receiver logs/XML.
  The earlier receiver run used pytest's global temporary root and reported
  cleanup warnings for pre-existing pytest garbage; the final harness explicitly
  confines both Core and child receiver temporary directories to owned evidence.
- Fresh databases `scribe_core_creator_review_test` and `scribe_review_receiver_test`
  used Unix socket port 55457 with no TCP listener. Core's synthetic model tables
  remain retained; Scribe teardown left only `alembic_version`. Owned PID 21147
  was verified, stopped and confirmed absent; `shutdown.json` records the check.

Core remains uncommitted on its existing detached checkout so this task does not
claim or combine the other work. The before/final manifests and incremental patch
are retained. No independent review, PR or release is claimed.

At that checkpoint configured ordinary admission used the older contract, and
Core SOAP consumed the older raw/working-source envelope. The next local proposal
is [configured admission and Core SOAP](beta/SCRIBE_CONFIGURED_CORE_WORKFLOW_PACKET_20260921.md).
That packet was subsequently approved and completed locally as recorded above.
Native identity/device acceptance, actual runtime credentials and signed releases
remain open. The historical ~55% operational judgment is not
raised based on these local tests.

## Earlier: clear translation progress and blocked-work guidance

Continued from clean `b894baf` while the exact Core consumer approval remains
pending. Providers can now distinguish a queued translation, a request without
a confirmed result, and a saved result awaiting review publication. Rejected or
failed translations say they need a new attempt instead of generic pending.
Refresh never starts/repeats work. Source/quality blockers and explicit creator
review still control note readiness; no retry command or activation was added.

The existing review response has optional current-source `translation_progress`.
Its read is scoped to the same live creator, tenant/session and source version,
without decrypting jobs or using keys/providers. Published attempts override
lagging job markers. The panel rejects contradictory/foreign progress. OpenAPI
and capture TypeScript were regenerated. No database migration, new route,
Core/Auth/IAM/environment change or live trial occurred.

Final rendered desktop/phone scenarios passed with real local API/PostgreSQL and
the documented synthetic host/Speech/model/native-storage/Core fixtures. They
now include an in-flight translation before the existing accept/reject/reload/
revocation checks. Five receiver checks and 18 review-UI checks pass, along with
TypeScript, ESLint, affected Ruff, strict Pyright, build and ADR/whitespace checks.
The full regression ran **1,068 tests**: **1,067 passed**, and one protocol check
failed because it selected system Node 22. All four protocol checks then passed
with the pinned Node 24; matched test identities confirm passing evidence for
all 1,068 distinct tests, with zero skips. The initial failed run is retained;
there was no application-code change to resolve that toolchain failure.

Evidence: `/private/tmp/scribe-review-progress.CGKoxr/verified.xml`, SHA-256
`8e756b18f663fb5bd6505142dbfed24a971dbf79cd7c4169365beee6d43e0c39`;
corrected toolchain evidence `node24-protocol.xml`, SHA-256
`dcd705029b66e5d2a968e8a21b3d4f270b02357e701307e53f787c2cdc302c54`.
Final screenshots are under `full/`. The new `scribe_review_progress_test`
database used private Unix socket port 55456 and no TCP listener. Final public
schema contained only `alembic_version`; owned PID 4301 was verified, stopped and
confirmed absent. Data/logs remain retained. Prior completed clusters stayed stopped.

Current unsigned provider JS SHA-256:
`1ac9f72ca302b07671c11442521ce303f12e9e0559e4953fc92cdbebc621f9f7`;
CSS SHA-256 remains `62c506ac9ad676d4449db2a501c159f8c0d59092dca0bbbb03d59b9f3a8b4987`.
For future Python regressions, set `CAPTURE_PROTOCOL_NODE` to the recorded Node 24
binary (or prepend its shim to PATH); Python subtests otherwise select system Node.

The full operational Scribe goal remains open. Current hosted/native binding,
Core admission/notes/dashboard, actual credential/worker lifecycle, physical
devices, fidelity and signed releases are not qualified by this progress display.
The existing [Core review-consumer packet](beta/SCRIBE_PROVIDER_CORE_PACKET_20260921.md)
was pending at that checkpoint; the latest section records its subsequent
approval and implementation.

## Earlier: recorder-mounted review and durable decisions — continuation

The replacement task read the complete handoff and verified a clean existing
`codex/beta-preintegration-20260904` checkout at
`99324d87628ec22f038f5ee9a4918de8cb46abb8`. The full Scribe goal is active again;
the historical pause applied only to the old task. No other task was contacted.

The retained capture component now accepts a one-time authorized host binding
and mounts the existing provider review panel after upload. The provider sees
the recording summary, original Spanish, proposed/accepted English, preserved
English speech, explicit accept/reject and current blockers. Completed capture
controls no longer push the review below a large technical status panel. A
host-supplied Continue to note action requires a fresh ready transcript and opens
the existing Core entrypoint without passing source text. Default preview startup
is unchanged; no hosted/native authentication or clinical endpoint was activated.

Decisions now journal exact metadata/key before transmission. The native adapter
reuses the existing encrypted secure-queue plugin with atomic create/CAS and
revision-checked clearing; its reserved keys do not enter audio queue enumeration.
Fresh authorization precedes journal recovery and reload requires explicit exact
retry. Abort/disconnect clears protected display and ignores late replies. The
host owns source termination/native recording indication; an unconfirmed stop
is not reported as closed. No native key/codec, server schema or auth parser changed.

Verification: full capture workspace **125 passed** and full review workspace
**16 passed**. The local actual API/PostgreSQL browser packet passed six focused
checks (two rendered scenarios plus four receiver regressions). After the final
stop-state correction, both rendered scenarios passed again: desktop acceptance,
phone rejection, committed-but-lost reply, document reload with a new journal/API
instance, identical retry, one persisted review, revoked-access clearing, and
confirmed/unconfirmed host deactivation. TypeScript, both workspace ESLint,
affected Ruff, strict API Pyright, provider build, ADR numbering and whitespace
checks passed. The prior complete 1,065-test Python result remains the checkpoint
for unchanged backend code; it was not rerun merely on resumption.

The actual encrypted capture protocol ran on generated WAV before the UI mounted.
The already-uploaded recorder host, identity, Speech/model, encrypted disk-backed
native bridge and Core entry are explicit fixtures. This is rendered component/API
and reload-recovery evidence, **not physical capture, actual Keychain, hosted login,
actual Core SOAP, a signed native package or operational MCD acceptance**.

Evidence root: `/private/tmp/scribe-provider-workflow.6am8cH/`. The final two-scenario
JUnit is `final-browser.xml`, SHA-256
`8b441e1b76f6a7f349c89cfc1c05bc6380ccf1a00b93c6a1c10effadced7299c`.
The preceding six-check result is `verified.xml`, SHA-256
`8ee92e0b790de9adfadbd19eb0ca3da76a91416b947d1df47d9c0c2196cd0dd9`.
Final desktop/phone PNGs are under `pytest-stop/`; they contain invented data.
The disposable UTF-8 database `scribe_provider_workflow_test` used private Unix
socket port 55455 with no TCP listener. Final public schema contained only
`alembic_version`. Exact owned PID 95541 was verified, stopped and confirmed
absent. Its database/logs and earlier trial artifacts remain retained.

Local unsigned provider bundle: `apps/capture/dist/provider/provider-capture.js`,
SHA-256 `76160d24570985039779a36995f764acd7bd01eb984aa39d5945e5b93ba1f878`;
CSS SHA-256 `62c506ac9ad676d4449db2a501c159f8c0d59092dca0bbbb03d59b9f3a8b4987`.
This library is ready for host integration; it is not mounted in an authenticated
standalone native release. No previous W13 package was replaced or relabeled.

Read-only Core inspection found the missing review operations/creator header,
legacy-only capture admission and incompatible source contract. The next exact
local Core review-consumer request is
[`SCRIBE_PROVIDER_CORE_PACKET_20260921.md`](beta/SCRIBE_PROVIDER_CORE_PACKET_20260921.md).
Its owner approval was requested and is pending. Do not treat Scribe local-runtime
approval as Core-write authority. Configured admission, combined migration base,
real identity/services, physical iPhone/iOS 17+, Core notes/dashboard, fidelity,
signed releases and founder activation remain open. The full goal and prior
approximately 55% readiness judgment are unchanged.

## Earlier: provider review receiver and reusable screen — 18:53 UTC

The owner requested a detailed handoff and explicitly approved pausing this goal
after that handoff. Resume from `docs/SCRIBE_HANDOFF_20260921.md`, not the entire
historical conversation. Current implementation commits are `3514639` (receiver)
and `67d58a4` (provider panel), both local and unpushed on the existing branch.

The existing API now registers GET/POST
`/v1/captured-sessions/{session_id}/review`. It remains unavailable without an
explicit server-side `CreatorReviewRuntime` binding, enabled gate and tenant
allowlist. It reuses existing Entra trusted-platform authentication; Core must
reauthorize the end user and supply the creator header. It does not add a user
login path or prove Core currently forwards that context. Reads expose captured
status, preserved source, English working projection and explicit translation
review. Decisions use the existing idempotency table and immutable writer in one
transaction, recover the persisted review ID/time and reject changed retries.
No schema migration or automatic provider/review/note call is introduced.

The review workspace now builds a reusable ES module/CSS panel. It shows Spanish
beside proposed English, unchanged English speech, unassigned speaker roles,
accept/reject buttons, blockers, current status and English readiness. Its host
supplies the existing authenticated transport and must dispose on logout/session
change. Uncertain saves retain exact metadata/key in memory for explicit retry;
unavailable responses clear protected display. Native durable recovery and
actual shell/BFF mounting remain unfinished. No physical/browser interaction or
visual acceptance was performed for this new panel. The old synthetic ingest
page is preserved and is not silently replaced by an operational app.

Final full Python regression: **1,065 passed, zero failures/errors/skips**, 119.557
seconds. Four new API cases cover generated capture → bilingual source → actual
HTTP-interface review, concurrent exact retry, fresh receiver recovery, source
preservation, creator/cohort/auth rejection, consent revocation, missing keys and
forbidden authority fields. Identity acquisition, Speech/model and blob/key
services are fixtures. All **13 review-UI checks** pass, including four new
contract/render/transport checks. Strict API Pyright, affected Ruff, review-UI
TypeScript/ESLint, generated OpenAPI/TypeScript, both UI builds, ADR numbering and
whitespace checks pass. These tests are not real end-user/device acceptance.

JUnit: `/private/tmp/scribe-review-surface.0xben8/verified.xml`, SHA-256
`13e1ec050b5b5ffc70fac318a5e70642ef11d08b67759f677017bbfeb5cc1ef4`.
The new UTF-8 `scribe_review_surface_test` database used a private Unix socket,
port 55454 and no TCP listener. Final public schema contained only
`alembic_version`; owned PID 82950 was verified, stopped and confirmed absent.
Its files/logs remain retained. Existing databases/apps/devices were untouched.

Built panel assets under `apps/review-ui/dist/creator-review/`:
JS SHA-256 `a4879be15a8d839b84f424e933cbd58e28b6ee019d57e9e9503a7c98ab1bde46`;
CSS SHA-256 `564d42c3991cab1b0a665d13b4fa52e2a20419d6bb45686620b946e22bb0510c`.
These are unsigned local web assets, not distributed native releases.

Next checkpoint target: mount this existing panel in the actual authenticated
client workflow and qualify its real transport, recording-to-review behavior and
Core handoff. Obtain narrowly scoped missing Core/deployment authority rather
than inventing another identity path or demo. Real identity/token custody,
physical-device/older-iOS qualification, full mixed-language fidelity, signed
distribution and MCD PHI activation remain open. Overall MCD readiness is still
the prior approximate 55% judgment, not increased on test count alone.

## Earlier: bounded automatic capture-to-review dispatch — 18:35 UTC

Added default-off `CapturedProcessingRuntime`: one trusted-tenant dispatch call
discovers actionable captured sessions, runs the encrypted Speech worker, plans
Spanish-only translation, reserves bounded initial work and executes or recovers
the existing encrypted jobs. Callers can carry a UUID cursor through a bounded
sweep. No API, scheduler or environment automatically registers this runtime.
Translation verifies the original completed captured-Speech receipt before using
source rows. Expired final-attempt Speech leases and retryable work at the attempt
ceiling become terminal metadata without another provider call or invented source.

Initial translation reservation is serialized with current source/consent under
the existing unique slot constraint. Failed or creator-rejected attempts are not
automatically retried. An explicitly created retry reservation can be dispatched.
Started calls are in flight or uncertain and are never automatically repeated;
they do not starve unrelated unstarted Spanish segments. Stored results recover
before new calls. Current source, consent, retention and immutable evidence are
revalidated by the existing store/writers. Worker evidence reads share the creator
reader's validation but have distinct worker audit events and never impersonate
the creator. Creator-only acceptance and English handoff remain explicit.

Final complete Python regression: **1,061 passed, zero failures/errors/skips**,
68.449 seconds, including 30 new cases. Tests discover actual local capture-protocol
rows and process real encrypted generated WAV through the existing assembler,
fixed offline Speech/model responses, encrypted jobs, human-decision fixtures and
Core handoff serialization. They cover competing dispatch, bounded pages/batches,
uncertain-call non-replay, retry boundaries, changed-source/revocation/retention
fences, English/quality-blocked source, completion lineage, exhausted Speech,
lost reservation/result/commit-marker replies and acceptance before marker recovery.
A fresh actual Python process discovers and commits a stored encrypted result
with audio/Speech/model methods forbidden. Its generated test RSA key travels via
stdin, not source, command-line arguments or logs. Source and English speech are
preserved and no automatic review is written.

The first 25 new tests passed, followed by 136 focused regressions and a complete
1,060-test run. Final review added the explicit captured-completion-lineage guard
and its negative test; the final count is 1,061. Strict Pyright exposed the existing
safe-job decorator's overly broad awaitable annotation when the concrete store
was composed with its protocol; its annotation now correctly describes the
returned native coroutine, without weakening the protocol or changing execution.

Ruff on changed code/tests, strict Pyright across the complete API, unchanged
OpenAPI regeneration, ADR numbering and whitespace checks pass. ADR 0045 records
the decision. JUnit: `/private/tmp/scribe-auto-processing.GKPGLv/verified.xml`, SHA-256
`833f859b4369688b00fd69418c5b34824efa0d77855cef4a511c80994e346b88`.
The fresh UTF-8 `scribe_auto_processing_test` database used only its private Unix
socket, no TCP listener. Test teardown left only `alembic_version`; verified owned
PID 67166 is stopped and its data/logs retained. No shared database, other app,
owner preview, package, cloud setting, provider model/prompt/HTTP contract, grant, auth parser,
Core/IAM/Zoom/staging, migration, push, PR or deployment changed.

Next: paired authenticated review/status/idempotency receivers and qualified
provider/credential lifecycle bootstrap, followed by actual client/Core/service
acceptance. Internal status now distinguishes capture/Speech/translation progress,
unconfirmed calls, explicit retry need, quality blocks and review readiness; that
is not yet a public status/failure UX. Real identity/token custody, physical-device
and older-iOS qualification, mixed-language fidelity and signed release remain
open. This is local automatic-dispatch capability, not MCD operational activation.

## Earlier: encrypted capture protocol to bilingual worker — 18:18 UTC

Connected the configured captured format to the existing encrypted recorder
protocol and audio assembly through an explicitly paired PostgreSQL provider.
`CapturedTranscriptionWorker` is default off; it reuses extracted lease/heartbeat,
last-moment consent checks and child-task cancellation from the existing worker.
Language comes from immutable admission, not a second processing-time choice.
The admitted adapter, finalized contiguous channels and returned source profile
must match before the atomic publisher accepts the actual Speech result.

The existing recorder status shape is a capture-phase view only: source,
translation, review and quality-pending states remain `processing`. They do not
become ready until the existing source/translation/review writers permit it.
The capture writer cannot overwrite the actual later source state with that
projection. Default legacy/imported scopes stay isolated, and an accidentally
paired legacy worker is rejected before audio/provider access. Completed jobs
recover an acknowledgment through their original receipt without rereading audio,
calling Speech or resetting working/review history. ADR 0044 records the boundary.

Final complete Python regression: **1,031 passed, zero failures/errors/skips**,
61.578 seconds, including 22 new cases. Tests exercise actual FastAPI capture
routes, restricted PostgreSQL, real AES-GCM encrypted generated WAV chunks and
the existing audio assembler. Fixed offline Speech evidence then reaches durable
encrypted translation, explicit creator review and the Core handoff serializer.
English-only capture requires no translation; bilingual source/English speech and
speaker identity remain preserved. Captured Speech/model/key/identity/blob-service
inputs are synthetic/offline fixtures, not actual microphone or live service
qualification, clinical fidelity, hosted authentication or actual Core SOAP.

New checks cover disabled/wrong tenant/session/unstarted/revoked/legacy/unadmitted
adapter rejection, invalid source provider/language/channel, provider retry and
exhaustion, concurrent workers, cancellation, revoked consent at manifest and
heartbeat, tampered audio, stolen lease, lost publication reply and completed-job
recovery in a fresh actual Python process with audio/Speech access forbidden.
The initial test run exposed a missing timestamp in the generated chunk fixture;
that fixture was corrected. The intermediate complete run passed 1,030 tests;
the final adapter-admission check brings the final count to 1,031. No runtime or
database guard was weakened for a test.

Ruff on changed application/tests, strict Pyright across the complete API,
unchanged OpenAPI regeneration, ADR numbering and whitespace checks pass. JUnit:
`/private/tmp/scribe-capture-worker.VrujhM/verified.xml`, SHA-256
`7b27b6fe84102ea254a12f1af05b6c0a35466e11b4322d638f90528c00f57403`.
The new UTF-8 `scribe_capture_worker_test` database used its private Unix socket
only, no TCP listener. Fixture cleanup left only `alembic_version`. Verified owned
PID 57913 is stopped; its data/logs are retained. Other apps, databases, packages
and owner previews were not changed. No new migration, public API registration,
auth parser, grant, live provider call, shared-platform change, push or deployment.

Next: automatic transcription/translation dispatch and the paired authenticated
review/idempotency/status receiver. Terminal exhausted jobs must have explicit
failure/recovery UX rather than relying on the recorder's `processing` projection.
Then qualify the actual clients/services/Core SOAP path. The new provider/worker
is not registered in a running API; existing clients do not automatically use it.
Real identity/device/fidelity, migration-graph reconciliation and signed release
remain open. This is concrete integration progress, not MCD activation or closure
of the full operational goal.

## Earlier: atomic captured Speech-result runtime — 18:01 UTC

Added default-off `CapturedSourceRuntime` and an explicit captured-mode PostgreSQL
provider. Trusted Core admission creates or exactly reuses an immutable captured
session. A trusted worker's result is normalized only after matching current
consent, job, attempt, lease, language and captured profile. Normalized source,
initial working projection and job completion commit together; expiry at the
final lease check rolls back all three. A completed retry must match its existing
receipt and source; it cannot create a correction or a second transcription.
No Speech/model call is made by the publisher. ADR 0043 records the boundary.

The same captured-mode provider now reuses the existing encrypted translation
executor and creator-review service. Source retains the captured Azure profile,
Spanish/English text, phrase timing and speaker identity without inferring clinical
roles. Only explicit creator acceptance makes translated English eligible for the
existing Core handoff serializer. Default imported/legacy readers and writers
still cannot access these configured captures. Consent revocation closes their
capture leases. There is no new identity path, route, environment bootstrap,
public API change, migration, provider invocation, push, PR or deployment.

**1,009 complete Python tests passed, zero failures/errors/skips**, 60.63 seconds.
The 25 new cases cover exact/conflicting admission, wrong tenant/session/job/
attempt/token, revoked consent, expired lease, atomic rollback, cancellation,
concurrent completion, uncertain commit recovery, English-only and quality-blocked
source, encrypted execution, creator review and retention cascade. One actual
owned child process exits after publication commits without returning its receipt;
a fresh process recovers that receipt with one source and working version. Pool
restart also recovers the encrypted translation job without another adapter call.
Speech results, model translation and cryptographic key material are synthetic
fixtures. This is runtime/storage recovery evidence, not live audio, clinical
fidelity, signed-client or actual Core SOAP acceptance.

Ruff on changed code/tests, strict Pyright across the complete API, unchanged
OpenAPI regeneration, ADR numbering and whitespace checks pass. JUnit:
`/private/tmp/scribe-captured-runtime.YZXvdk/full-results.xml`, SHA-256
`9de715eb59ef5995d41268ddab89c85814890d38e6a7c0fe71f28c4410cb4be1`.
Fresh UTF-8 database `scribe_captured_runtime_test` used only its private Unix
socket on the new cluster, no TCP listener. Exact generated tenant rows were
removed by the declared test-only teardown; the application retention path was
tested separately before teardown. The final schema contains only
`alembic_version`. Exact owned PID 49224 was stopped; its data/logs remain. Other
databases, apps, signed packages and owner previews were untouched.

Next: connect the encrypted capture protocol, audio assembly and leased worker to
this publisher, then wire automatic durable translation dispatch and the
authenticated review receiver. Existing clients cannot yet record into the newly
configured path. Real identity/device/service/fidelity and signed-release gates
remain open; the overall goal remains active and MCD clinical use is not enabled.

## Earlier: captured bilingual storage expansion — 17:45 UTC

The owner explicitly approved the additional Scribe-only dormant capture/storage
migration, tested only in a new disposable local database. Revision
`0019_captured_bilingual` follows `0018_translation_jobs`; ADR 0042 records the
decision and boundaries. No existing recording is converted or backfilled.

New configured `chunk_upload` sessions can retain their actual capture provenance
through normalized source, encrypted translation jobs, creator review and English
working storage. Their state path requires capture/upload/processing before
source receipt. Exact immutable Azure-source profiles replace any need to label
them as external imports. Audio/job child roots are allowed; legacy raw-transcript
and delivery writes remain prohibited. Imported sessions and unconfigured capture
retain their prior behavior. No public route, runtime registration, application
query widening, new grant, Core/Auth/IAM/Zoom/staging change or live call occurred.

Final complete Python regression: **984 passed, zero failures/errors/skips**,
78.63 seconds, including 23 new migration checks. Real PostgreSQL checks cover
restricted non-owner operation, creator review before ready projection, unchanged
source/role/profile evidence, tenant isolation, current-consent/source/retention
job fences, terminal failures, legacy-query exclusion, row/privilege preservation
across expand/reversal and refusal to reverse a used capture format. The initial
fixture had a SQL typo; the first full run also exposed an older test that
compared 0014's retained guards with the now-newer head. The test now verifies
0014-to-0013 retention and exact restoration of the complete current head.
No production guard was weakened to satisfy either test.

Ruff and strict Pyright for the new migration/tests pass; OpenAPI regeneration is
unchanged, ADR numbering and whitespace checks pass. JUnit:
`/private/tmp/scribe-captured-bilingual.vfCl4X/verified-results.xml`, SHA-256
`e4009f893a49042eb04ba576c65df0a3d2d30fef3ca650bb7be4076d05f9d88d`.
The new UTF-8 database `scribe_captured_bilingual_test` used only its private
Unix socket, no TCP listener. Teardown left only `alembic_version`; the exact
owned cluster is stopped and its data/logs retained. No other database/app was
stopped or changed.

This is the schema foundation, **not a connected recording-to-note runtime**.
Next: trusted configured-capture admission and leased Speech-result persistence,
then durable translation dispatch and authenticated review/idempotency, followed
by exact client/service acceptance. Existing app paths deliberately cannot read
these new configured captures yet. Combined migration-graph reconciliation and
independent review remain prerequisites to promotion.

### Owner-requested MCD readiness estimate

For actual MCD provider operation on desktop and iOS, estimate **about 55%
(50–60% range)**. This is engineering judgment across implementation and remaining
acceptance, not a measured completion or clinical-accuracy score. Strong local
storage/service foundations do not close the release gates: real existing-user
authentication and token custody; integrated capture → Spanish-to-English review
→ Core SOAP → authorized MCD dashboard; physical-client/older-iOS recovery;
mixed-language fidelity acceptance; and signed/distributed artifacts plus an
approved PHI-capable operating environment. The stabilized shared platform has
not been requalified in this task. Nothing here enables MCD clinical use.

## Earlier: branded Scribe URL and local runtime approval — 17:23 UTC

The owner requested a `cosmaneura.com` address, completed Cloudflare sign-in, and
separately explicitly approved the local runtime-integration packet. The chosen
standalone URL is now **https://scribe-beta.cosmaneura.com/**. The CosmaBot/CosmasOS
URL remains separate and was not changed or provisioned here.

Before mutation, both public authoritative DNS and Cloudflare's exact-name
search found no record. Added only DNS-only CNAME `scribe-beta` targeting
`green-rock-0cd7d7e0f.7.azurestaticapps.net`, TTL Auto (authoritative TTL 300).
Then attached that exact hostname using CNAME validation to existing Standard
Static Web App `cmn-capture-preview-p8x6m2` in
`cosmaneura-capture-preview-development`. Azure progressed through validation to
**Ready**, with no error. Both `lakas` and `roxy` authoritative nameservers return
the expected CNAME. Normal HTTPS GET returns 200 and certificate validation 0.
The first browser request reached an old certificate during propagation; a
fresh normal HTTPS request subsequently rendered the site without bypassing
validation. No certificate warning was overridden.

The resulting screen is still **Cosmaneura Capture — SYNTHETIC DATA · SILENT
SOURCE**, with disabled consent/record controls. Its initial state subsequently
reports `synthetic_preview_failed`; this is not a working recording demo or an
authenticated native API. The hostname succeeds independently of that preview
initialization failure. Read-only health comparison confirms the branded host
returns 403 `preview_host_rejected`, while the original Azure hostname returns
200 synthetic healthy. Live `CAPTURE_PREVIEW_ALLOWED_HOSTS` contains only the
original Azure hostname. The local preview configuration parser also requires
an `.azurestaticapps.net` suffix, so blindly changing its live setting would
break startup. No allowlist or preview source was changed. Making the old preview
interactive on this alias requires a separately deployable hostname-compatible
release; the currently approved local runtime packet does not authorize that
deployment. Prefer connecting the qualified Scribe runtime when that release is
ready, rather than confusing a repaired silent preview with beta acceptance.
Do not relabel the preview as the runtime or use this
web origin as the phone API until a compatible endpoint is actually qualified.

No deployment, source upload, root/www record, other app/auth/Zoom/staging DNS,
identity or shared database was changed. Readback confirms the clinical Scribe
environment remains `internal=true`, `publicNetworkAccess=Disabled` and
`provisioningState=Succeeded`. No live Speech/translation call ran. The alias and
SWA custom-domain binding are the entire external change. Preserve this binding
as recorded external state for later IaC reconciliation; no broad infrastructure
apply or state import was performed. Remove the DNS alias before any future
retirement of the binding/site to avoid a dangling hostname.

The local runtime approval supersedes the earlier local no-integration
restriction only: connect Speech, encrypted jobs, translation and creator-only
review on the existing unpushed branch in disposable synthetic storage, with
live services disabled. Core/Auth/IAM/Zoom/staging and other repositories stay
unchanged. The first implementation increment is the persisted creator review
service in ADR 0041, with qualification below.
The complete runtime packet and the five owner goals remain incomplete.

### First runtime increment: persisted creator review

Added default-off `CreatorTranscriptReviewService` and repository reads for the
creator's current, published pre-handoff bilingual evidence. They recheck tenant,
creator, consent, retention and current source/working versions, reconstruct the
canonical view from persisted source/attempt/review records and compare it to the
saved fingerprint/status. Reading cannot publish or approve. Explicit decisions
reuse the existing immutable writer and its exact retry semantics. Errors expose
no raw driver context; cancellation propagates. No public route, auth parser,
settings/permission activation, new migration or live provider was added.

The six-case Speech/encrypted-job/translation seam now uses the application
reader and compares it to independently loaded PostgreSQL rows, including after
pool restart. New tests cover wrong tenant/session/creator, missing/unpublished
source, no publish-on-read, explicit decisions/exact retry/conflicting retry,
revocation, expiry, corrupt projection, disabled service and cancellation/error
handling. Identity/Speech/model/network/key material remain synthetic fixtures.

Final complete Python regression: **961 passed, zero failures/errors/skips**,
61.302 seconds. Ruff and strict Pyright on changed application/repository modules
pass; OpenAPI regenerated with no difference; ADR and whitespace checks pass.
JUnit: `/private/tmp/scribe-runtime-review.kVwWZG/verified-results.xml`, SHA-256
`9df1923676bb5a0af9239b4bf4de15b6d36e23bd227ae6311a4846d2a4cf7513`.

Earlier test invocations corrected the database driver and requested the needed
local socket permission. Full regression exposed two prior seam-test issues:
retained encrypted jobs conflicted with an older migration downgrade test, and
its SQL-only reader sorted quality blockers by random IDs rather than saved
ordinal. The seam now cleans up its own disposable records through the existing
retention cascade and reads saved ordinal order. No migration guard was weakened.

The new cluster is `/private/tmp/scribe-runtime-review.kVwWZG/data`, private Unix
socket only, no TCP listener. Tests used UTF-8 database
`scribe_runtime_review_utf8_test`; the initially created empty SQL-ASCII database
was not used. Teardown leaves only `alembic_version` in the tested schema. Retain
the stopped cluster and logs; other databases/apps are untouched.

Next within the existing approval: connect captured-source provenance and
translation execution without using the external-source label for Azure capture;
then connect the authenticated receiver and its durable request-idempotency
envelope. This application increment is not HTTP/native integration, the full
runtime packet, live bilingual audio acceptance or release qualification.

## Earlier: separate Scribe URL and iPhone package preflight — 17:00 UTC

The owner requested a beta URL and then explicitly confirmed **two separate
URLs: standalone Scribe and CosmaBot/CosmasOS**. The existing standalone preview
origin is available for the Scribe side:

`https://green-rock-0cd7d7e0f.7.azurestaticapps.net/`

Read-only Azure inspection resolved that origin from Static Web App
`cmn-capture-preview-p8x6m2` in the dedicated
`cosmaneura-capture-preview-development` resource group, Standard SKU, no custom
domains. An ordinary HTTPS GET returned 200 with certificate validation result 0.
Browser inspection showed **Cosmaneura Capture — SYNTHETIC DATA · SILENT SOURCE**,
disabled consent/record controls and the explicit notice that this preview does
not connect to patients, Scribe, Speech or a clinical tenant. No control was used.
This is an existing, verified **web address**, not a newly provisioned service,
an authenticated native API, or operational beta acceptance. Do not configure it
as the phone's API merely because its web page loads.

The separate clinical Scribe environment still reports internal ingress and
public network access Disabled. The preview API reports Running and HTTPS-only.
No cloud resource, custom DNS, ingress, identity, token setting, deployment flag,
app package, shared database or other checkout was changed. CosmasOS's URL work
remains untouched. Replacing the preview requires a qualified standalone-facing
API/canonical Core boundary and matched client configuration, exact deployable
artifacts, reviewed deployment/recovery, and fresh identity/device acceptance.
The old synthetic preview backend must not be relabeled as that implementation.

The owner-completed iOS update now permits Device Hub screen inspection. The
physical iPhone 12 displays iOS 27.0 and W13 opens its welcome page. The owner's
tap on Choose an encounter returned to the top of that page without an observed
encounter list. The retained package's referenced entry bundle contains the
Mac-local API origin; the inspected source dispatches this button to the catalog
read. These are configuration/UI observations, not a proven runtime exception or
successful Tester sign-in. W13 remains an OS qualification app, not standalone
Scribe; support remains iOS 17+ and is not qualified by this iOS 27 observation.

Added the offline `scripts/check_ios_candidate.py` diagnostic. It reads the IPA
without extracting or running it, binds the archive and expected inputs by hash,
checks bundle/Capacitor identity, iPhone platform, retained iOS 17 floor, native
auth trial flags, bridge logging, and the referenced Vite entry's API origin.
It rejects local/numeric/placeholder/credential-bearing destinations, missing or
mismatched approved origins, ambiguous metadata/assets, unsupported layouts and
bounded-read violations. It performs **no network or signing check**. The parser
supports the reviewed Vite/Capacitor native-auth trial shape, not arbitrary JS
program semantics or every possible standalone package. Even a static pass keeps
authentication, physical-device, network, signature and release acceptance false.
It is a manual diagnostic, not a newly installed CI/deployment gate.

Actual W13 IPA SHA-256 remains
`097754a4370de69921dd1f55f9b851cabaffbd85505f2ff44c7c9ec2cd78eaa8`.
Its check exits 1 with `api_origin_not_device_candidate` and
`approved_api_origin_missing`. Comparison with the retained standalone Capture
bundle identity also reports `bundle_identity_mismatch`. No future beta bundle
identifier is selected by that comparison. Reports are retained in
`evidence/ios-candidate-preflight-20260921.json`.

Verification: **83 tests passed, zero skipped**, including 66 new offline cases
and the existing artifact/beta-gate/ADR checks. Ruff and strict Pyright on the new
script pass. The existing Starlette dependency warning remains. No database or
provider call ran. JUnit: `/private/tmp/scribe-ios-preflight.imxSFP/final-results.xml`,
SHA-256 `6192274475ad4a9e3dfcb71ac5c077494c2e0db7c6d928c0959f67b9fe53fe19`.

## What “clinical evaluation” means here

Core alone continues to generate SOAP notes. No second clinical note engine is
being introduced. The Scribe check is source fidelity: do negation, dosage/units,
uncertainty, speaker attribution and the meaning of Spanish survive capture,
transcription and translation before Core receives them? A low overall word-error
rate can still conceal a changed dose or dropped “not.” Reuse Core's existing SOAP
evaluation for the downstream note, and add targeted audio/translation fixtures.

The eight fixed invented translation cases below are a connectivity/fidelity
smoke check, not a clinical accuracy percentage. They do not exercise live audio,
accents, overlapping speakers, sustained within-phrase code-switching, background
noise, omissions, or end-to-end Core notes. Those remain acceptance work.

## Results by goal

| Goal | New evidence | Remaining gate |
| --- | --- | --- |
| Real auth/token custody | Reused selected W13 Clerk/Keychain candidate and initiated owner sign-in. Timeout kept workspace closed. No password/token was read or recorded. | Successful owner sign-in, organization/audience verification, restart/refresh, revocation/logout and native-only custody evidence on Mac and iPhone. No new IdP/auth path is proposed. |
| Real STT/model/translation | Concrete Azure GPT-4.1 translator now implements the existing adapter interface. Final real run returned seven HTTP 200/reference agreements and one HTTP 400 rejection. Azure phrase-language evidence now survives into an opt-in normalized-source bridge. The private Speech job passed disabled-state and real, two-case synthetic inference acceptance; its temporary permission is removed. | Admitted provider/model profiles; durable normalized receiver/translation/review integration in the current standalone and OS paths; full mixed-language audio acceptance. No runtime route or worker registers the new bridge/translator yet. |
| Physical iPhone | Verified development package installed and launched on the physical iPhone 12 after owner passcode entry. Exact bundle was absent before installation, installed version/build is `1.0/1`, and its process was observed running. Signature and artifact hashes reverified. | Rendered UI, successful Tester login, token custody, recording/interruption/recovery and end-to-end services remain unqualified. Phone also needs an approved reachable HTTPS backend, not the Mac's localhost. |
| Source fidelity | Fixed tests cover negation, dose, self-correction, uncertainty, pregnancy, allergy, attribution and quoted instruction text. Golden references were defined before service calls. A diagnostic call confirms Azure content filtering rejects the quoted-instruction case; the real adapter and synthetic writer test preserve source and block note handoff/review approval. | User-facing blocked/recovery UX, full consented synthetic audio/translation/Core-note loop and human review remain. Do not change references or bypass provider filtering merely to get a pass. |
| Signed/reproducible artifacts | Canonical-path clean builds now match compiled payloads and UUIDs; signatures, public entitlements and all 332 source inputs verify. The exact exported development IPA, source and symbols are retained outside temporary storage. | Signing/ZIP bytes still vary; cross-machine/hermetic reproducibility is unproven. No Apple Distribution identity, TestFlight acceptance, desktop notarization, cross-client installer/update acceptance or production artifact set was established. |

## Follow-on: bilingual service/storage seam acceptance

After encrypted-store commit `b673fbf`, the same local branch gained a test-only
composition in `tests/test_bilingual_service_storage_seam.py`. It connects the
actual Azure Speech result parser/normalizer, existing normalized receiver, real
encrypted PostgreSQL job store, actual Azure translation adapter, immutable
attempt/review writers and existing Core handoff serializer. Speech SDK results,
HTTP responses, credentials, network guards and RSA keys are synthetic. No audio
recognition, live inference, real user authorization or Core note generation ran.

Six cases pass: successful translation, Azure HTTP filtering, structured refusal,
incomplete output, unknown source language and overlapping speech. The successful
case preserves English provider text and a single patient speaker switching from
Spanish to English; only the Spanish segment reaches the translation adapter.
Source text/locale/timing/speaker IDs are unchanged in PostgreSQL. Reopening the
repository/connection pool recovers the committed job without another provider
call. Persisted English working rows are read independently of in-memory results;
only creator review permits handoff. Failed translations cannot be accepted, and
unknown-language/overlap sources cannot reserve provider work. These checks are
plumbing/contract evidence, not a measurement of clinical transcription accuracy.

**108 related tests passed, zero failures/errors/skips, 8.950 seconds**; Ruff,
strict Pyright and `git diff --check` pass. This run includes the six new tests
and existing encrypted-store, Speech-source, Azure translation, execution,
vertical handoff and fidelity suites. The prior 881-test full run remains the
unchanged-runtime baseline; the full suite was not rerun for this test-only delta.
Initial attempts corrected the command's database driver and filled required
confidence fields in the mocked Speech responses; no runtime was changed.

The fresh disposable PostgreSQL 16.15 cluster used only a private mode-0700 Unix
socket, with no TCP listener, at `/private/tmp/scribe-bilingual-seam.P5auNi/data`;
database `scribe_bilingual_seam_test`. Teardown left only `alembic_version` and
removed the temporary roles. Its exact process (93321) was stopped and the
stopped state verified; logs/data remain. JUnit evidence:
`/private/tmp/scribe-bilingual-seam.P5auNi/final-results.xml`, SHA-256
`db1e8790db0aed3e8968fe713ab559b6cf075bb2950ab53eaffcf4cb1309f206`.
The existing W13 database was untouched. Its API execution handle `62456` remained
live when polled; that is not evidence of successful Tester authentication.

The OpenAI Docs skill directed inspection of the official
[Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
The new integrated checks carry refusal/incomplete-output rejection through the
database and review/handoff gates. A valid schema still does not establish
meaning or fidelity. Model, prompt, reference corpus and provider filters remain
unchanged; this follow-on made no live model request.

### Remaining seams exposed by this composition

- The source receiver still stamps its existing external-source profile. The
  test does not admit an Azure recognition profile or connect a captured session
  to that receiver. Preserve actual provenance in the eventual integration.
- Persisted working-text inspection here is a test-only SQL reader, not a new
  creator-authorized endpoint. Runtime reads/dispatch/review and current
  standalone/CosmasOS clients still require integration.
- Speaker identity survives language changes, but the parser correctly leaves
  provider/patient roles unknown. The existing generic handoff labels them
  `Unknown`; it does not carry speaker IDs. This is **not** acceptable evidence
  of provider-versus-patient clinical attribution. Qualify explicit role review
  and downstream attribution; never infer roles merely from spoken language.
- The phone remains untouched while the owner updates iOS. W13 on the Mac was
  closed/reopened at the owner's request and its helper window was observed;
  the actual hosted login form and successful Tester sign-in are not verified.

### Reuse of Core's existing SOAP evaluation

Read-only inspection of `/Users/jw/Desktop/Cosmas/cosmas-os-core-integration`
(HEAD `e21ba4c1fb1027de8123aca9b8aee25b8a11b612`, dirty; no edits here) found the
existing live-note suite `tests/job/summarize_test.py` and `tests/eval.py` judge.
The suite covers schema order, patient/doctor actions, pronouns, subjective versus
doctor interpretation, current versus prescribed medications, reasons and ROS.
It is gated by `RUN_LIVE_LLM_TESTS=true` and existing Azure credential settings;
it was neither imported nor run. Source SHA-256 values:

- `tests/job/summarize_test.py`:
  `93ff3b13576465679c18aff5017ef3710749f9d10095c9f0ca4dc2cd939da5c1`.
- `tests/eval.py`:
  `e4a0318f6fb081991ffe26d3bebc621ec03e0248957d09ef5a55b605125751e7`.

Reuse these criteria and Core's generator when the exact integrated synthetic
trial is authorized. Add source-to-English checks for negation, doses/units,
omissions, uncertainty and attribution, with human adjudication of critical
errors. The existing `n=1, m=2` best-of-two helper is not a fidelity pass rate:
retain every attempted output/outcome in the qualification denominator. Do not
create another clinical generator, collect API keys, or change Core to make this
local test pass. The full five-goal objective remains open.

## Translation implementation and final real run

`azure_translation.py` uses server-side Entra credentials, fixed Spanish-to-English
direction, a bounded one-request HTTP call with no automatic retry, and a strict
closed JSON response. It rejects redirects, incomplete/refused/tool responses,
unexpected model snapshots, duplicate keys and oversized results. Official
Structured Outputs guidance informed these checks; schema validity is not proof
of preserved meaning. Existing reservation, immutable attempt, creator review and
working-transcript contracts remain authoritative.

The fixed synthetic script uses the existing `CosmasCode` deployment `gpt-4.1`.
Its public-endpoint exception is confined to eight invented strings in this
script. It is not a clinical-runtime network guard or permission to send PHI.
The service response was pinned to `gpt-4.1-2025-04-14`.

- Adapter: `azure_gpt41_translation_v1`.
- Final profile: `azure_gpt41_es_en_bbebc4d661d126412cde590f11fc15b9`.
- Corpus SHA-256: `8cb6b0f53114535b78ecff962cf8bf737e54f07e4829806ca6159974e0bfca66`.
- Final HTTP statuses: `200, 200, 200, 200, 200, 200, 200, 400`.
- First seven case IDs matched their fixed references; `quoted_instruction`
  returned `provider_rejected`. No provider error body was retained; the specific
  reason for HTTP 400 was not established in that run. The follow-on diagnostic
  below identifies the rejection without changing its input or acceptance reference.
- Evidence: `/private/tmp/scribe-real-services-20260921.ySJT7W/translation-live-final.json`.
- Evidence SHA-256: `913af2c2be54fe7857f515fc3ec70857528ac7ec230ea6765a855705b0bc2355`.

`azure_speech_source.py` preserves actual `en-US`/`es-US` phrase evidence and exact
text/timestamps. Missing/unsupported locales stay unknown, language confidence is
unset, and speaker roles are not inferred from language or channel. The manually
selected mixed mode supplies Azure with two candidates rather than the invalid
single locale `en-US+es-US`. Unknown source language remains a note-readiness
blocker. The legacy raw transcript writer does not persist these locale fields;
the versioned receiver must be wired before calling bilingual capture complete.

### Follow-on: diagnose the rejected fixed case without weakening filtering

On 2026-09-21, between 13:52:08 and 13:52:32 UTC, one diagnostic request reused
the exact `quoted_instruction` synthetic case, GPT-4.1 deployment, prompt,
qualification profile and endpoint. The model adapter and fidelity corpus were not
edited. Azure returned HTTP 400 with fixed allowlisted metadata:

- `error_code=content_filter`;
- `inner_code=ResponsibleAIPolicyViolation`;
- `jailbreak_detected` and `jailbreak_filtered` flags.

This establishes a provider filtering rejection, not a malformed-request or
authentication diagnosis for this case. It does not establish why Azure's policy
implementation classified the quotation that way, nor quantify clinical accuracy.
There was no translated result; the prior seven reference agreements remain
separate, unchanged evidence. No prompt/source/reference rewrite, alternate
model, filter setting, endpoint/network change or automatic retry was performed.

The qualification script now reads at most 16 KiB of an uncompressed error body
and retains only hard-coded codes/true flags. It excludes provider messages,
unknown field values, headers and raw bodies. Encoded, oversized, malformed,
duplicate-key and unreadable bodies produce only fixed diagnostic labels.
Cancellation propagates. Successful response handling is unchanged. These
diagnostics exist only in the fixed synthetic script; the runtime adapter still
returns its bounded `provider_rejected` outcome and remains unregistered.

The OpenAI Docs skill directed an official-documentation search and opening of
[the API error reference](https://developers.openai.com/api/docs/guides/error-codes).
Its guidance to inspect structured error codes informed the diagnostic approach;
the specific Azure classification above is actual service evidence, not an
OpenAI-documentation claim. No new API key or identity path was created. Browser
documentation access is now working; no Clerk or native-session state was changed.

**54 focused tests pass**, plus Ruff, strict Pyright and `git diff --check`.
The added offline vertical test feeds the observed error shape through the real
Azure adapter, completed-job envelope, existing attempt writer and English
projection. It proves one call, unchanged Spanish source, a failed/null
translation, `TRANSLATION_FAILED` blocker, rejected Core handoff construction and
rejected attempted creator acceptance. HTTP/identity and the repository are
synthetic in this test; it is not a deployed end-to-end or rendered UX trial.
Tests used task-owned pytest temporary directories, avoiding shared temp cleanup.

Exact metadata evidence is retained in the artifact package as
`translation-filter-diagnostic.json`, SHA-256
`de111e141c5f44a3e8f4cf1c90e7cd0124ce06eb1ba82bc58d3346f7fa24c1a1`.
No additional live request is needed to re-establish this terminal result. Before
beta, the integrated UI/operations path must make this blocked state clear and
support a reviewed resolution without omitting source or looping provider calls.
The encrypted-store scope extension and physical iPhone sign-in remain pending.

## Private Speech approval and disabled-state acceptance

**Correction to the earlier inventory:** `cosmaneura-scribe-dev-smoke` is the
Speech acceptance job, not API-route acceptance. Direct command readback shows
`python -m cosmaneura_scribe.speech_smoke_runner`. No replacement job is needed.
The owner explicitly approved the previously requested isolated qualification
setup/execution after connecting the phone. That approval is recorded in the
flight plan; it is not approval for shared Auth/IAM/Zoom/staging, unmerged-code
deployment, production/PHI use or release publication.

The existing job uses merged source
`eaf343a1152eccf7fff0a96652a1c3731902c30c`, verified as an ancestor of the local
`origin/main`. ACR resolves its tag to
`sha256:6ee5a221e50e284cf37d58f01746cbfe632c487c32fbcbd40158e7a713c1253c`.
ACR reports write/delete enabled; the tag is mutable, and this lookup does not
prove the digest actually pulled by the terminated execution.

Preflight found no retained/active executions and only exact-registry `AcrPull`
on the dedicated smoke identity. The raw gate was false and backend `none`.
One no-override start created `cosmaneura-scribe-dev-smoke-mff21ng` at
`2026-09-21T13:02:16Z`. Azure reported terminal status `Failed`, which is expected
for the disabled gate. Exact-execution Log Analytics returned only projected
metadata: `speech_smoke.disabled` / `SpeechSmokeDisabled` at
`2026-09-21T13:02:39.8732154Z`. The effective container template and post-run job
readback retain the same image, command, no arguments, four environment entries,
0.5 CPU/1 GiB resources and dedicated identity. The execution API omits identity;
identity evidence is from job readback. Replica metadata says `Terminated` but
does not expose an exit code. Do not claim a specific observed numeric exit code.

This proves the deployed disabled-state boundary, **not Speech inference**.
No role, job definition, foundation resource, network rule, API revision or live-data
setting was changed. Speech still has public access disabled, local/key auth
disabled, default-deny ACLs with no IP rules, and an approved private endpoint.

The metadata-only device/Speech record is retained in the artifact package as
`device-and-speech-preflight.json`, SHA-256
`9408e3d8dfd392a81b7d0b7d7efbe9e117d1991b07e8075a1545e4b71142c14a`.

At that checkpoint, enablement was a technical prerequisite, not renewed consent:
follow [Private Speech acceptance](SPEECH_PRIVATE_ACCEPTANCE.md) using a current,
reviewed saved plan and qualified private infrastructure path. No such runner is
currently present in the isolated resource inventory. The retired temporary
runner's code targets API/key reconciliation, not Speech-only enablement, and
must not be repurposed through command overrides. The older main checkout is
dirty and its local tfvars image differs from deployed state; do not apply it.
Reconcile and retain the deployed API untouched. The permitted enablement delta
is the smoke gate/owned endpoint configuration plus account-scoped Speech User.
Clinical transcription remains off, and no public-network bypass is permitted.

### Follow-on: enablement execution-path preflight

The infrastructure sources are byte-identical to the local `origin/main` tree;
no infrastructure source was edited. OpenTofu 1.12.5 reused the cached, locked
AzureRM 4.81.0 provider with `init -backend=false -get=false -lockfile=readonly`.
Offline `validate` passed using the macOS local IPC service outside the sandbox.
No remote backend was initialized, state read, plan produced or apply attempted.
`graph` refused to run without backend initialization; it is not graph evidence.

A fresh API read still reports revision `cosmaneura-scribe-dev-api--0000004`
and image `804c4bacd692bc157ab101ff5055d999e00a37cc`. The Speech job retains
`eaf343a1152eccf7fff0a96652a1c3731902c30c`. Both resource definitions consume
the same `container_image_tag`, so a naive full apply could change one of them.
The two commits' Speech runner, transcription adapter and private-network guard
have no diff, but that does not establish equivalence of their complete images.
The selected Speech runner source hash is
`e639b7387dc22e2d5a401e521df2a0f2dc314f9acefcc8c750e0ef5500a3a56c`.

The owned account endpoint and linked private-endpoint NIC were read through
Azure management APIs. A bounded DNS-only check on this Mac resolved the
hostname, but answers were **not exclusively private and did not match the owned
private endpoint**. No address was printed, credential requested or HTTP request
sent. This Mac therefore cannot be called the qualified private runner.

Execution-method exception, **explicitly approved by the owner on 2026-09-21**: use this
Mac only for an authenticated, saved, refresh-enabled management-plane plan
targeting the existing Speech job and its account-scoped Speech User assignment.
The job continues to execute audio processing only inside the existing private
environment. This changes the runbook's private-operator-location requirement,
not the Speech network boundary. The scoped approval is recorded in the flight
plan; the completed saved-plan review, execution and reversal are recorded next.

The reviewed plan must allow only the job's raw gate/backend/owned endpoint and
private-IP settings plus the single temporary Speech User assignment. Reject
image, command, identity, resource, trigger/retry, API, key, shared IAM, network,
database, diagnostics or other dependency changes. Record the API/image drift as
`retain temporarily`; a targeted acceptance plan is not full-stack convergence.
Bind the existing remote backend state and saved plan, preserve its lock, verify
effective execution configuration, run once without overrides, and use a fresh
reviewed reverse plan to close the gate/remove only that temporary assignment
after the terminal result. Do not use local state, force-unlock or a public
Speech endpoint. If the actual saved plan cannot satisfy these conditions, stop.

Native identity remains a separate open gate: the physical app is installed and
running, but Tester sign-in has not been reported or verified. Browser-based
identity inspection could not initialize because the computer-use connection was
unavailable; no Clerk setting or session was changed.

### Follow-on: private live Speech acceptance and verified reversal

The owner's approved management-plane exception was executed on 2026-09-21.
No new runner was created. Audio stayed inside the existing private job; the Mac
only performed authenticated management/state operations. The working source was
an unmodified export of merged `main` commit
`d6fcdb2d0a94c9f158b74593e0fb18d810209673`, whose infrastructure has no difference
from the previously inspected `1aab63c` tree. The local branch and remote-tracking
refs were not moved. OpenTofu 1.12.5 and locked AzureRM 4.81.0 were reused with
provider registration disabled.

Raw state, plans and apply logs stayed outside Git inside an AES-256 encrypted
temporary disk image, with ownership enabled and a private mount directory.
The pre-change Azure state blob was snapshotted conditionally on its ETag at
`2026-09-21T13:19:09.8023055Z`; that protected remote snapshot is retained. Its
SHA-256 is `e63dd5bc8bbdd207ac1eb1c727fdcce28d62b952fc4742227357ba1c92d7b996`.
Lineage remained `9cc263b9-f1e2-dfc8-4a33-a67cb73459a6`; serials were
**62 before, 63 enabled, 64 restored**. No force unlock or local-state replacement
was used.

The refreshed, saved enable plan changed exactly two resources: an environment-
only update to `azurerm_container_app_job.speech_smoke[0]` and creation of its
single Cognitive Services Speech User assignment, scoped to the owned Speech
account. Field-level review rejected all other job changes, dependency actions,
output changes and drift. Live job readback matched the plan before and after.
The existing API/image mismatch was retained temporarily, not reconciled through
a full apply. Enable-plan SHA-256:
`fa5e482e8242cb684ae68fc81b0b81af04678788092d106633dc567a2f727f57`.

Exactly one enabled execution, `cosmaneura-scribe-dev-smoke-0wnnz72`, ran without
command, argument, image or environment overrides:

- Azure start: `2026-09-21T13:35:11Z`; terminal **Succeeded** at
  `2026-09-21T13:35:40Z`.
- Exact-execution event: **`speech_smoke.completed`**, no error class, at
  `2026-09-21T13:35:38.6728992Z`; runner duration `1428.824` ms.
- The runner enforces the two hash-pinned, consented synthetic cases and a
  per-case WER ceiling of **0.25**, positive duration and nonempty segments.
  Individual WER values are not logged; no numeric per-case result is claimed.
- The effective execution template matches the enabled job after explicitly
  verifying empty probe/init/volume defaults and the execution API's extra empty
  `ephemeralStorage` field. Execution identity is omitted by Azure; the exact
  dedicated identity was verified from job readback.
- The image tag remained `eaf343a1152eccf7fff0a96652a1c3731902c30c`. The earlier
  registry digest is recorded above, but the actual pulled digest is not exposed
  in the inspected execution response. This remains a release-provenance gap.

After the terminal result, the separately generated and reviewed reverse plan
was revalidated against the unchanged enabled state (serial 63) and current job.
Reverse-plan SHA-256:
`ae951ae0d683f864f70bdacb732513841c3eaa53bf6e862d9daf3add0f51674c`.
Apply succeeded: one job update and deletion of only the temporary assignment
`53cd9a48-e2d8-c878-bcd6-f83644037df5`. The gate is false, backend `none`, and
owned endpoint settings are absent. Role readback shows only the original
registry-scoped AcrPull assignment. Both executions are terminal; none was retried.

Every resource and output in restored state matches the original snapshot
exactly: **37 resources; no changed resource content or outputs**. Azure readback
also verifies the unchanged API revision `cosmaneura-scribe-dev-api--0000004`,
image `804c4bacd692bc157ab101ff5055d999e00a37cc`, Speech public access disabled,
local auth disabled, default-deny ACL with zero IP rules and approved private
connection. Clinical transcription remains disabled. The retained evidence is
metadata only: no recognized/reference text, audio, endpoint, private IP or token.
The artifact package retains `speech-private-acceptance.json`, SHA-256
`07da93fb05a88c8742434a326048d57f1594de13189ba32db0429c909474d5c3`.
The final backend lease is `available` / `unlocked`.
After all nine artifact checksums passed, the exact encrypted temporary plan
image was cleanly detached. Its ephemeral passphrase was not saved; retain the
protected remote snapshot and metadata receipt, not reusable local apply files.
The original dormant job, Speech account and registry permission remain intact.

This closes basic real private Speech connectivity and the fixed two-case
acceptance gate. It does **not** qualify Spanish/English mixed-speaker audio,
the dormant translation runtime, clinical accuracy, Core SOAP output, native
identity, an end-to-end physical recording or a beta release. The existing seven-
case real Spanish-to-English reference agreements remain separate evidence.

## iPhone artifact provenance and repeat-build result

The retained W13 client composition was reused without editing its sources:
`/private/tmp/cosmas-w13-auth-work/apple-origin-fixed`. It is a qualification
snapshot, not the current complete OS product or a released standalone Scribe.

- Recorded base source: `ea7f99d0278a05706531ffb1288cb1df7acf507b` plus the existing
  composition overlays; all 332 `composed_sha256` entries matched.
- Composition manifest SHA-256:
  `5b1ea480dc44fa454418230528fb67c46d479b6d8dd8331970d335686dcf81c3`.
- Clerk 1.5.5 source archive SHA-256:
  `bad4b726cac296e2480c81199ef1c5b7759064d9cd0ffa10056d4f8122fcb5e4`.
- Capacitor 8.5.0 pinned revision:
  `4f71d0b979f2f957326f04353eca7604ee937e1e`.
- Xcode 27.0 / `27A266a`; Release; generic iOS; arm64; minimum iOS 17.
- Bundle `com.cosmasos.synthetic.w13`, version/build `1.0/1`.
- Apple Development signing, team `JVV65668U6`; `get-task-allow=true`.
  Simulator-only test entitlements were not used for the hardware build.
- The initial Debug signing step allowed Xcode to obtain a matching development
  provisioning profile. Both subsequent Release archives reused cached signing
  with no provisioning-update flag. Nothing was installed or uploaded.

Archive root: `/private/tmp/scribe-real-services-20260921.ySJT7W/`.

| Archive | Main executable SHA-256 | CodeDirectory SHA-256 |
| --- | --- | --- |
| `iphone-development.xcarchive` | `7970acb8474485bfbc823dfdc4a9d1b515010b4715a94ece2fbd5463769e9571` | `1e8dc383a420d0d57b83f41be1742d20a71cb1083b6d3025f6ef799263bb690b` |
| `iphone-development-rebuild.xcarchive` | `090de2ce12d9f7fadea8c70cd2a4ce8c03cfa4ce37f55c7b0631cf4d261e48b1` | `1265fa242d48e668cd2400c5c39ca149427b1811526cafc1ab1bb9f87b8e5e27` |

Both passed `codesign --verify --deep --strict` using macOS trust services outside
the sandbox. App Mach-O UUIDs, binaries and signatures differed; ordinary resources
matched. At this first checkpoint the reason for binary differences had not been
isolated; the follow-on below records the canonical-path result. Do not describe
these signed bytes as reproducible or distribution signing. Xcode emitted dependency/API
deprecation warnings and a Swift diagnostic saying a command failed with exit 0;
both archive commands exited 0 and their signed products independently verified.

Rebuild recipe: `xcodebuild` with project `apps/capture/ios/App/App.xcodeproj`,
scheme `App`, `-configuration Release -destination generic/platform=iOS`, separate
fresh `-derivedDataPath`/`-archivePath` for each build, the retained
`DerivedData/SourcePackages`, `-disableAutomaticPackageResolution`,
`-onlyUsePackageVersionsFromResolvedFile`, `DEVELOPMENT_TEAM=JVV65668U6`,
`CODE_SIGN_STYLE=Automatic`, `CODE_SIGN_IDENTITY='Apple Development'`, `archive`.
This is a development qualification recipe, not a release workflow.

### Follow-on: canonical build path and installable development package

The next local continuation isolated the earlier binary differences: all three
Mach-O binaries (App, Capacitor, Cordova) differed only in LC_UUID and embedded
signatures. The linker already used Apple's `-reproducible` option; merely adding
the flag was not a new solution. Two fresh builds using the **same canonical
build path** produced matching UUIDs and matching complete Mach-O bytes outside
their exact embedded-signature ranges. The app's dSYM UUID also matched both
builds, so crash-symbol identity was not disabled to obtain agreement.

Those builds used `iphone-repro-one.xcarchive` and `iphone-repro-two.xcarchive`
under the temporary archive root above. The canonical DerivedData path was
`iphone-repro-one`; the first finished build directory was moved to the new
`iphone-repro-one-retained-build` before creating the second from scratch. No
original archive or client source was removed or modified.

| Binary | SHA-256 with only its embedded-signature range zeroed |
| --- | --- |
| App | `4e0f49e9816e8b0f8604c6e4bceb9e315a89d88a52ca204cca9dd1eb764d558f` |
| Capacitor | `789f27cf276dd5fc9ca5391b539df7a0d76243d11a0c0fe510a19933fd0d8bf3` |
| Cordova | `c93f85deb79318c165f026665eecd5b82d25b183bd6f0abea2998c5428b9381d` |

App and both matching dSYMs use UUID
`395BDEE7-DEBE-3468-BCE8-D3A1097217E0`. Resources outside signing records matched.
Public app entitlements and designated requirements were independently compared
and matched; both complete app signatures verified with macOS trust services.
This is reproducible compiled-payload evidence for the selected development
composition, not byte-identical signatures, a hermetic cross-machine build,
distribution qualification or completion of the full release goal.

An export-only development IPA was then produced. The initial manual export
failed because the existing profile is Xcode-managed. The successful export used
automatic selection of that same cached profile, without
`-allowProvisioningUpdates` or `-allowProvisioningDeviceRegistration`. Export
destination was `export`, method `debugging`, with no upload or version management.
The extracted **exported** app (not merely its pre-export archive) passed strict
deep signature verification and retained the expected bundle/team/entitlements.
Its profile explicitly includes the already-paired physical iPhone.

The retained, approximately 11 MB qualification package is at:
`/Users/jw/Desktop/Cosmas/scribe-device-qualification-20260921.AGGjR0/`.
It contains the IPA, exact 332 verified composed source inputs, source manifest,
matching dSYMs, export options, translation evidence, README and SHA256SUMS.

- IPA: `Scribe-W13-development.ipa`.
- IPA SHA-256: `097754a4370de69921dd1f55f9b851cabaffbd85505f2ff44c7c9ec2cd78eaa8`.
- Exported executable SHA-256:
  `94b8dad6f7e38e4ec547b33e72a404a22547d978bba095ba9e26d8d33fa55700`.
- Exported CodeDirectory SHA-256:
  `a4c13e7b43c23b2133da005e994a70adbe88adce3bfecb5b3a6728b49b8169f4`.
- Profile `265a06ef-aa78-45a2-863a-b8694daf4dee`, expiration
  2027-09-21 12:20:20 UTC; paired-iPhone membership verified without retaining its
  device list in the evidence record.

At the archive checkpoint, this remained the W13 authentication qualification snapshot, whose real
STT/model/capture service wiring is disabled. Translation service evidence is a
separate artifact, not proof of connection to this app. No installation, physical
recording, successful login, TestFlight upload or new Apple account configuration
was performed in that archive continuation. Promote the exact verified package for its
scoped trial; do not rebuild and call it the same artifact.

### Follow-on: physical iPhone installation and launch

After the owner entered the passcode, Apple's device service reported
`passcodeRequired=false`. The exact `com.cosmasos.synthetic.w13` installed-app
query succeeded and returned no app, clearing both the lock and overwrite gates.
All seven existing package checksums passed; the exported executable retained
SHA-256 `94b8dad6f7e38e4ec547b33e72a404a22547d978bba095ba9e26d8d33fa55700`.
Strict deep signature verification passed again using macOS trust services.

The preserved **exported** app was installed through Apple's native device
service. Readback confirms **CosmasOS Synth W13**, bundle
`com.cosmasos.synthetic.w13`, version/build `1.0/1`. The launch command succeeded;
a process query filtered to the newly installed bundle path observed PID 21634.
No existing app was replaced, data reset, recording started, console attached or
credential/token output collected. No new build, profile, distribution signature
or upload was performed. The earlier locked-device evidence remains preserved;
`iphone-installation.json` in the artifact package records this later progress.
Its SHA-256 is
`4b669a5adaf828f56d773dc4d5ea2789b2d036fcf71a7c92ae1287bbf694fa68`.

This is physical installation/process evidence, not an observed rendered screen
or completed native-auth trial. The owner was asked to use the existing Tester
account through the app's sign-in UI and report the resulting screen/error.
Actual session claims, Keychain restoration/refresh/logout, reachable backend,
recording and full service acceptance remain open. The W13 snapshot still has
STT/model/capture service wiring disabled.

## Local verification and next acceptance sequence

Initial Python regression: **647 passed, 183 skipped**. That run lacked the
disposable PostgreSQL test configuration; the later complete run below supersedes
its storage-validation gap. Ruff and strict Pyright pass. The initial run exposed an ADR-number
collision (fixed by using 0039) and system Node 22; the final run selected the
existing required Node runtime through `CAPTURE_PROTOCOL_NODE`. No dependency or
global runtime upgrade was made. No API or storage schema changed.

### Follow-on: complete local PostgreSQL regression

A new PostgreSQL 16.15 cluster was initialized only at
`/private/tmp/scribe-storage-qualification.2w4AVy/data`. It used a mode-0700 Unix
socket, no TCP listener, and the new `scribe_qualification_test` database. Before
tests, SQL confirmed the exact data directory, empty `listen_addresses` and no
network server address. No main, integration, cloud or production database was
addressed. Existing migration up/down, downgrade refusal and destructive cleanup
tests were run only in this newly created throwaway cluster.

The first fixture run exposed a real packaging gap: SQLAlchemy's default Greenlet
dependency marker excludes macOS `arm64`. Without its `asyncio` extra, the local
async engine failed before reaching storage assertions. The existing read-only
integration checkout already carried the exact fix, `sqlalchemy[asyncio]>=2.0,<3`.
That one-line declaration was reused here and the lockfile regenerated offline.
Both dependency files match the inspected integration checkout byte-for-byte;
that checkout was not modified. All 64 locked package versions are unchanged;
the existing locked Greenlet 3.5.5 was installed from cache into this branch's
own virtual environment. No unrelated packages or global runtime were removed.

A new non-database test exercises SQLAlchemy's async bridge so this environment
failure is detected even when the optional PostgreSQL fixture is absent.

**Final full result: 831 passed, zero skipped, zero failures, in 40.46 seconds.**
Ruff and strict Pyright pass. This includes the existing PostgreSQL migration,
restricted-role, tenant isolation, immutable source/translation, creator review,
consent/retention, competing-write and ambiguous-commit recovery tests. It does
not prove cloud deployment, real Speech inference, native login, physical-device
capture, or end-to-end real-service note generation.

After fixture teardown, the disposable public schema had only its Alembic
bookkeeping table. The cluster's process was verified as PID 51412 with the exact
owned data directory, then stopped using `pg_ctl` for that directory. Temporary
data/logs were retained; no shared server, database or user data was removed.

The remaining runtime integration was rechecked: `DurableTranslationJobStore`
is still a protocol, with only a test implementation. Its approved encrypted
production store, current consent/source authorization at provider-call admission,
worker configuration and connection to the newer capture integration remain
activation prerequisites. Do not use the in-memory test store as a production
substitute or treat the real adapter smoke test as a working clinical pipeline.

### Follow-on: preserve translation reservation through worker transitions

A local review found that the dormant worker checked returned tenant/session/job
IDs but did not compare the protected reservation across store transitions.
An inconsistent store could return different source text or versions under those
same IDs; the old worker could call the provider before detecting a mismatch, or
accept the changed reservation on later result/recovery paths.

The worker now pins the initially read reservation fingerprint and timestamp,
rejecting changes at claim, competing-claim reload, stored result and committed
acknowledgement. Claim changes fail before a provider call; stored-result changes
fail before the attempt writer. Nine new tests cover five claim mutations, three
later transition mutations and unchanged competing-claim recovery. The eight
negative cases reproduced failures before the fix; all pass afterward. Existing
database-retry recovery still reuses the stored result without calling the
provider again. No protected source or fingerprint is included in the new error.

Focused result: **40 passed**. Full result: **840 passed, zero skipped, in 43.15
seconds**, including the existing PostgreSQL migration/restricted-role/recovery
suite. Ruff, strict Pyright, ADR numbering and `git diff --check` pass. The full
run emitted existing dependency deprecation warnings and old pytest temporary-
directory cleanup warnings; no manual cleanup of those directories was attempted.
Future full runs should select a new task-owned `--basetemp` to avoid pytest's
shared default temporary-history cleanup.

Database tests used only a newly created PostgreSQL 16.15 cluster at
`/private/tmp/scribe-reservation-qualification.lgdCAk/data`, private Unix socket,
no TCP listener, database `scribe_reservation_test`. The first sandboxed init
failed on macOS shared-memory access and removed its own incomplete data directory;
initialization outside the sandbox then succeeded after verifying that directory
was absent. Before tests, SQL verified the exact data directory and empty
`listen_addresses`. After teardown only `alembic_version` remained in `public`.
The exact server PID/data directory was verified and the server stopped; files
were retained. No shared database, other checkout, service configuration, provider
call or API route was changed by this follow-on.

This is a store-response integrity check, **not** a production encrypted store,
authentication of the initial read, current consent authorization, or full
bilingual runtime integration. Those gates remain open. Read-only inspection of
the newer Scribe integration still finds only the same durable-store protocol,
not a reusable production implementation.

### Approved local encrypted-store packet — implemented and rehearsed

The owner explicitly approved a Scribe-only encrypted job store and dormant
migration, with tests confined to a disposable local database and no cloud/shared
platform changes. The implementation is on the existing unpushed branch:

- `TranslationJobCipher`: authenticated AES-256-GCM envelopes with fresh job-only
  keys/nonces, wrapped through the existing RSA-3072 server key-custody interface.
  Protected source, result and call token are encrypted; scope, lineage, lifecycle
  times and expiry are authenticated. No plaintext job content/digest in storage
  metadata or audit; raw SQL/validation exception context is removed.
- `PostgresTranslationJobStore`: durable reservation, atomic claim, encrypted
  result and exact immutable-attempt reconciliation. It reuses existing consent
  and session locks and rejects stale source/content, revoked consent, expired
  retention and conflicting identities. A committed claim with unknown outcome
  never automatically calls the provider again, including with a different job ID
  for the same source/next-attempt slot.
- Dormant migration `0018_translation_jobs`, parent `0014` here: one new
  Scribe-only table, forced tenant RLS, monotonic lifecycle and deferred authority
  guards, source-retention cascade, no role or runtime grant. The distinct revision
  avoids IDs 0015–0017 observed in the separate integration checkout. The combined
  migration graph must still be reconciled/rehearsed before promotion.
- Existing immutable translation attempt, English working projection and
  creator-only review remain authoritative. A constrained local role using the
  existing translation-grant pattern plus only job-table access passes the full
  store/writer path without consent UPDATE, review INSERT or job DELETE rights.

**Final verification: 881 passed, zero skipped, 57.78 seconds.** The new focused
suite has **30 passing tests**: envelope tamper/tenant/state/time/key failures,
fresh-process restoration, competing claims, revocation-before-claim, stale
source/content, encrypted database corruption, retention cleanup, immutable
attempt/creator review, lost claim/result/writer/marker acknowledgements, downgrade
and reset rejection, raw-error suppression and constrained-role execution.
Ruff, strict Pyright, ADR numbering and `git diff --check` pass. OpenAPI was
regenerated and is unchanged. The 27 full-suite warnings are existing dependency
deprecations. An older migration-rehearsal test needed its expected head updated
and its disposable test-role grant restored after recreating the new table;
runtime/bootstrap permissions were not changed.

All database actions used the newly created PostgreSQL 16.15 cluster at
`/private/tmp/scribe-encrypted-jobs-qualification.YtD3yU/data`, database
`scribe_encrypted_jobs_test`, private Unix socket and **no TCP listener**. Before
shutdown, exact SQL readback verified that path, only `alembic_version` remained
in `public`, and both test application/job roles were absent. The exact server,
PID 84227, was stopped and rechecked; data/logs were retained. Final JUnit report:
`/private/tmp/scribe-encrypted-jobs-qualification.YtD3yU/final-results.xml`, SHA-256
`d94bd0e6c7e22faeff9503cc515aca23d417de2f63e4c378975eae918e8a7e75`.

No provider/cloud/key-vault calls, shared database changes, runtime registration,
Core/Auth/IAM/Zoom/staging edits, other checkout edits, new branch, push, PR or
deployment occurred in this packet. Generated local test keys are not runtime
key-custody qualification. Independent review, combined migration graph,
real worker/key authority, current-client receiver/review wiring and complete
mixed-language physical-device acceptance remain promotion gates. Recovery keeps
the additive table dormant; nonempty/non-test downgrade is rejected. See ADR 0040.

### Physical phone and older-iOS requirement — latest observation

The reconnected iPhone was detected as available/paired and W13 `1.0/1` remained
installed. An attempted foreground launch was rejected because the phone had
locked again. The owner then reported W13 open on the phone. No password, passcode
or token was collected, and successful Tester sign-in/resulting W13 UI has **not**
been independently observed.

Xcode 27's Device Hub was opened and the physical **Johns Phone** selected, not a
simulator. Its View Screen action ultimately reported: “Screen Sharing Unavailable
Johns Phone must be running iOS 27.0 or above to screen share with this Mac.” This
is a developer-viewing limitation, not a W13 launch error or product minimum.
The owner elected to update the phone and will report completion; no further
device action should be attempted during that update.

The exact preserved W13 app's Info.plist declares `MinimumOSVersion=17.0`; composed
Xcode/SPM inputs also target 17. Preserve **iOS 17+** as the current compatibility
target and explicitly qualify older versions. Do not raise the product floor to
27 merely for screen sharing, or claim an iOS 27 test proves older-version support.
No device OS update or native deployment-target change was performed by the agent.

### Historical scope request — subsequently approved, 2026-09-21

The owner has now explicitly approved the Scribe-only encrypted job store and
dormant migration below, tested only in a disposable local database. No cloud or
shared-platform changes. The following paragraph records the earlier boundary,
not a remaining approval request. Implementation evidence is recorded separately.

ADR 0037's earlier pre-integration restriction explicitly excludes a production
job-store schema. The completed Speech execution-method exception did not remove
that restriction. The next proposed extension is limited to the existing local,
unpushed Scribe branch:

1. Implement encrypted durable translation reservation/result storage using
   existing dependencies and key-custody interfaces; no plaintext test-store
   substitute in runtime.
2. Add only the Scribe-local additive storage migration and qualify it in a new
   disposable local database. Do not apply it to existing or cloud databases.
   Account for the newer integration checkout's migration IDs before selection.
3. Atomically recheck current consent, tenant/session and exact source lineage
   when claiming provider work, with bounded handling of ambiguous outcomes and
   no automatic repeat of an uncertain provider call.
4. Verify process-restart, competing claim, stale source/revocation, wrong-tenant,
   tamper and lost-acknowledgement cases with synthetic data; preserve the existing
   immutable attempt and creator-review flow for both standalone and OS callers.
5. Keep routes, workers and live services disabled; no Core/shared Auth/IAM/Zoom/
   staging edits, cloud actions, deployment, push or PR. Actual phone identity,
   reachable HTTPS services and distribution signing remain separate acceptance
   requirements.

Next sequence:

1. The distinct W13 app is now installed and launched on the physical iPhone.
   Complete selected test-account sign-in and qualify real token custody, restart
   and logout. Preserve all existing apps/drafts and enter credentials only in
   native/hosted UI; never send a passcode or password to the agent.
2. Basic private Speech acceptance is complete and its temporary authority is
   revoked. Do not repeat the terminal trials. Keep clinical transcription off
   until the separate reconciled runtime and bilingual acceptance gates pass.
3. Wire the admitted Speech source and real translator through durable receiver,
   current consent/creator checks and review in a reconciled Scribe integration
   slice; reuse the same capability from standalone and CosmasOS.
4. Run the physical consented invented audio → bilingual source → reviewed English
   → Core SOAP loop, then interruptions, restart, revocation and retry recovery.
5. Resolve reproducibility differences and distribution inputs; build/verify the
   exact desktop+iOS artifact set with installer/update/rollback evidence. No
   cohort admission, PHI use, release upload or production activation is implied.

## Completion/blocker audit — 2026-09-21, approximately 13:59 UTC

The full standalone-plus-CosmasOS goal is **not complete**. The last continuation
made progress by diagnosing the actual filtering response and verifying its
source-preserving failure path. Current read-only checks establish these gates:

| Required outcome | Authoritative evidence | Remaining blocker |
| --- | --- | --- |
| Real native authentication/token custody | W13 installed/launched earlier; no successful owner sign-in or native custody receipt. Current app/process queries cannot reach the phone. | Owner Tester sign-in result, then claim/Keychain/refresh/restart/logout/revocation qualification. Do not read or collect credentials to substitute for that trial. |
| Real STT/model/Spanish-to-English integration for both clients | Private Speech acceptance passed; seven fixed translation reference agreements and one diagnosed filter rejection; source/translation bridges remain unregistered and `DurableTranslationJobStore` remains only a protocol. | Approval for the proposed local encrypted-store/additive-migration packet, current-authority admission and reconciled runtime integration. The earlier no-new-job-store restriction has not been lifted. |
| Physical iPhone qualification | The stable hardware identifier now resolves to `Johns Phone`, iPhone 12, state **unavailable**. Exact W13 app queries through both the earlier CoreDevice identifier and the hardware identifier fail with CoreDevice 4016. | Reconnect/unlock the phone and complete sign-in; approved reachable HTTPS backend and real capture/interruption/recovery trials remain. Query failure does not mean the earlier installation was removed. |
| Source fidelity plus existing Core SOAP evaluation | Fixed synthetic reference and failure-path evidence only; no second note engine introduced. | Complete consented mixed English/Spanish audio → reviewed English → existing Core SOAP output and human evaluation on the integrated service path. |
| Reproducible signed release artifacts | All ten retained artifact checksums pass. Fresh signing-identity inventory shows one Apple Development identity only. Canonical-path development payload reproducibility is recorded above. | Appropriate distribution/notarization identities, exact integrated release source/artifact selection and installer/update acceptance. Development signing is not a production release. |

The phone's `unavailable` state was verified by name and its recorded hardware
identifier after the initial CoreDevice lookup failed; no inference was made
from a timeout alone. The Mac app inventory exposes only the older CosmasOS W6
qualification app, whose existing state remains protected. No app, auth helper,
device trial or terminal Speech execution was restarted. No token/data container
was inspected. The W13 packaged web assets still contain the Mac-local
`127.0.0.1:8046` backend address; that is not a phone-reachable service.

The encrypted-store approval and native sign-in input have remained outstanding
through the worker-integrity continuation, filter-diagnostic continuation and
this audit. Independent safe work in those turns is now finished. Advancing the
actual integration/device/release requirements needs owner input or the identified
external-state changes; additional synthetic checkpoints do not close those gates.
Keep the full goal intact and resume from these saved results when unblocked.
