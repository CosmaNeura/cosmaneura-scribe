# Scribe real service and client qualification

### Receiver correction and native presentation — 2026-09-22

Within the existing local integration scope, replace the receiver's impossible
capabilities/session comparison with the existing configured creator-review read.
Preserve exact session checks and suppress review content in the recorder reply.
The actual schema fixture reproduces the old 422; twenty isolated receiver checks
now pass (ADR 0051 amendment). Prepare default-disabled native picker/indicator
source using existing Apple frameworks, preserving macOS 14.2 and all protected
authority/audio/helper source. Typecheck only; installed GUI/physical acceptance
remains open (ADR 0063). The unresolved desktop grant/lease design is documented
separately; no new server authority, dependency or runtime profile is applied.

### Desktop resource connection — 2026-09-22

Within the approved local provider controls below, compose authorized backend
mounts with the existing encrypted desktop stores, journals, Core client and
recorder. Keep native custody and fresh backend start authority supplied by the
reviewed host; invent no identity, key, capability or environment. Retain failed-
stop ownership and late acquisitions; verify scoped journal recovery and actual
Core envelope binding using invented inputs. ADR 0062 records the passing checks.
The new connection remains unmounted; recovery preserves stored records. Core
release/issuer/receiver configuration remains a separate, unapplied packet.

### Approved local provider controls — 2026-09-21

The owner approved completing the local configured capture → review → existing
Core SOAP and creator encounter flow. Connect the retained recorder to Core's
configured admission, then expose encounter/language/consent, transcript review,
template selection and version-checked Core note editing in the provider entry.
Reuse Core's authenticated operation facade and note engine. The trusted host
owns encounter authorization, credential custody, recorder storage and lifetime;
the view never acquires workload credentials or asserts a creator/tenant.
Persist exact admission and save recovery in encrypted, scoped journals before
mutation. Keep explicit recording/review/note actions and clear protected views
on host deactivation. Tier 2; test lost replies, scope changes and the rendered
local flow using invented fixtures. No default preview activation, native auth
policy, hosted deployment, live-service trial or release qualification. Recovery
is to leave the separate provider entry unmounted; preserve pending journals.

Latest approved local increment: configured admission and existing Core SOAP,
2026-09-21. Reuse the existing Scribe admission repository, Entra dependency,
review contract and Core canonical transcript/note engine. Add a default-off
Scribe receiver, immutable configured Core reservation and reviewed-source
mapping; no existing-session conversion. Core's generated additive revision
c8526f5e8d80 follows its separate 9172abd84a3d history. Scribe's graph is unchanged.
Rehearse only in newly owned private-socket synthetic databases. Retain original
source and note history, recheck current authority/readiness before publication,
and keep notes explicitly unreviewed. See ADR 0047 and the latest checkpoint
for evidence. Native host binding, real credential lifecycle, device acceptance
and releases remain open; no deployment or live trial is included.

Owner direction: 2026-09-21. Work toward one standalone Scribe capability used by
both its own clients and CosmasOS. The priorities are real authentication/token
custody, real STT/model/Spanish-to-English services, physical iPhone acceptance,
source fidelity, and reproducible signed artifacts.

## Boundaries and reuse

Use the existing local, unpushed `codex/beta-preintegration-20260904` branch
(starting at `1e48c12`, descendant of the authorized `b46ade8`). Inspect newer
CosmasOS/Scribe integration sources read-only; their uncommitted work belongs to
other ongoing work. Do not open a PR, push, or change shared staging/IAM/Zoom.
The initial packet prohibited deployment; the bounded owner-approved extension
below is the only exception. No cross-task coordination.

Core remains the SOAP generator. Scribe captures, transcribes, translates the
Spanish portions, preserves source/version/speaker evidence, and hands reviewed
English working text to Core. Fidelity evaluation checks negation, numbers/units,
medications, speaker attribution, omissions and translation meaning. It does not
introduce another diagnostic model or duplicate Core's note evaluation program.

Reuse the Azure Speech adapter, translation planner/writer/review contracts,
Clerk native SDK qualification, encrypted recorder and existing Apple/Electron
packagers. Translation uses the existing GPT-4.1 family and Azure API contract.
Credentials stay server-side and are never written to source or evidence.

### Separate beta URL direction and offline client check — 2026-09-21

The owner requested a standalone Scribe beta URL distinct from the separate
CosmaBot/CosmasOS URL. Read-only inspection found the existing isolated Scribe
capture-preview web origin; its HTTPS page works, but it is the older disabled
synthetic preview, not the real authenticated Scribe backend. Preserve the private
clinical environment and do not point the W13 OS app at an incompatible Scribe
API or conflate its package with standalone Scribe. Existing-user platform
interoperability remains a distinct identity/authorized-read/canonical-write
acceptance requirement; separate hostnames do not prevent that integration.

The bounded local follow-on adds only an offline IPA preflight and its tests,
not authentication, deployment/workflow, runtime, schema or environment changes.
Run `python scripts/check_ios_candidate.py --ipa <retained-ipa>
--expected-bundle-id <exact-intended-app-id>`; add `--approved-api-origin` only
after selecting the actual authorized API, not merely a reachable web site.
Exit 1 denotes a blocking/unsupported static candidate. Exit 0 is not evidence
of signing, TLS, API compatibility, login, capture, or release acceptance.
Recovery is to stop using the diagnostic; no deployed state changes. Exact
results and outstanding deployment/connection gates are in the checkpoint.

### Branded URL and local runtime approvals — 2026-09-21

The owner requested a real URL under `cosmaneura.com` and completed Cloudflare
sign-in for `scribe-beta.cosmaneura.com`. The limited external change is one
DNS-only CNAME to the existing `green-rock-0cd7d7e0f.7.azurestaticapps.net`
preview, plus that exact hostname binding and managed TLS on Static Web App
`cmn-capture-preview-p8x6m2`. Inspect for a conflicting record before adding it.
Leave apex/www, other apps, Auth/IAM/Zoom/staging and the private clinical
environment unchanged. No source deployment, recording, clinical API exposure
or identity activation is included. Verify authoritative DNS, Azure validation,
certificate verification and the rendered synthetic page. Recovery must remove
the DNS alias before retiring its Azure binding to avoid a dangling hostname;
perform no resource deletion or unrelated DNS change.

Separately, the owner explicitly stated, “I approve the runtime-integration.”
This approves connecting the existing Speech adapter, encrypted jobs, translation
and creator-only transcript review locally on this existing unpushed branch,
using only a disposable synthetic database with live services disabled. It
supersedes earlier no-runtime-integration wording for that local packet only.
No Core/Auth/IAM/Zoom/staging or other-repository edits, push, PR, deployment or
new live service call. Preserve actual source provenance, current consent,
tenant/creator boundaries, immutable lineage and fail-closed handoff. An Azure
captured result must not be mislabeled as an external transcript. Default-off
runtime integration and migration/contract reconciliation require their own
local negative/recovery tests before any later promotion is considered.

First runtime increment: default-off creator review application service plus
tenant/creator/current-evidence reads. No HTTP route or migration is added. Reuse
the immutable decision writer and preserve exact retry IDs/times; require the
future receiver to bind them durably. Test both repositories, opaque errors,
revocation/retention, no publish-on-read and offline encrypted-job seam recovery.
See ADR 0041 and the checkpoint. DNS/TLS is ready; the older preview's live host
allowlist rejects the new alias and needs a separately authorized deployable
release, not an unchecked live configuration edit.

## Ordered work

1. Add a concrete Azure GPT-4.1 Spanish-to-English adapter behind the existing
   provider interface. Bound payloads, reject redirects/refusals/incomplete
   results, require network verification, and never automatically repeat a call.
2. Qualify fixed invented bilingual cases through an available real service;
   retain aggregate/opaque evidence and keep source fidelity distinct from
   provider connectivity. Then connect durable execution and creator review.
3. Finish the already-approved W13 native sign-in/Keychain trial using the
   selected test account. Reuse its issuer/audience/organization and explicit
   owner credential entry. Preserve existing apps and their recorded data.
4. Compile the selected iPhone candidate for the physical device; qualify
   installation, consented invented capture, interruption, restart and logout.
   Produce matching standalone/CosmasOS integration evidence.
5. Produce artifacts from recorded source/dependency inputs, verify signatures
   and installer/update behavior, and identify any unavailable distribution
   certificate/profile explicitly. A development signature is not distribution
   acceptance. Publishing/admitting testers requires its applicable authority.

### Older iOS compatibility — owner clarification, 2026-09-21

The owner may update this test phone to iOS 27 to enable Apple's Device Hub screen
sharing, but explicitly requires support for older iOS releases. The preserved
W13 IPA declares `MinimumOSVersion=17.0`; its composed Xcode/SPM inputs also target
iOS 17. Do not raise that target to 27 for tooling convenience. Qualify iOS 17+
separately: minimum-version build/API availability, representative older OS
runtime, authentication/Keychain/refresh/logout and capture/recovery on physical
hardware. A successful iOS 27 test cannot qualify all older releases. Earlier
generic recorder documentation mentioning iOS 15 does not lower W13's actual
native-auth composition minimum. If supporting iOS 15/16 becomes required, assess
SDK/API compatibility explicitly before changing the product support floor.

## Evidence and recovery

Tier 2: protected text, credentials and cross-service contracts. Run focused
negative/recovery tests, then relevant lint/types and regression checks. This
first adapter change has no route, default setting, schema, worker activation or
environment mutation. Recovery leaves it unconfigured. Source review and exact
artifact evidence remain prerequisites to promotion.

The follow-on translation-worker integrity fix stays within the dormant local
contract: reject a store response that changes the initially read reservation's
source content, lineage or timestamp, before provider work or writer acceptance
as applicable. Qualify competing claims and stored-result recovery with fixed
synthetic tests, then run the complete disposable-database suite. No new store,
schema, route, consent/auth contract, provider call or runtime activation is part
of this fix. The production encrypted-store and current-authority admission gates
remain separate requirements; a matching fingerprint does not establish either.

The same fixed synthetic provider qualification also permits bounded diagnosis
of its rejected case. The follow-on changed only the script's metadata collection
and offline tests, then made one request with the unchanged `quoted_instruction`
fixture/profile. Actual metadata identifies Azure content filtering; no source,
prompt, model, reference, filter configuration or retry policy was changed. The
preserved-source/blocked-handoff behavior is tested locally. Runtime diagnostics,
user-facing recovery and live clinical activation are not delivered by this check.

Initial observations: the physical iPhone 12 is paired, iOS 26.7, Developer Mode
enabled; Xcode 27 reports its developer disk image cannot be mounted. One Apple
Development identity is available; no distribution identity was listed. The
owned Azure Scribe Speech resource exists in East US with public access disabled.
These observations do not prove successful capture, service inference or release.

Implementation and live evidence are recorded in
[the 2026-09-21 checkpoint](../SCRIBE_REAL_SERVICES_CHECKPOINT_20260921.md).

## Disposable storage acceptance extension

### Captured bilingual source — owner-approved 2026-09-21

Next local runtime increment: bounded automatic capture/transcription/translation
dispatch, using trusted tenant scope and existing encrypted reservation/execution
and source/review writers. Atomically reserve only missing initial translations;
failed/rejected attempts require an explicit later retry decision. Never repeat an
uncertain started model call. Resume stored results, keep creator approval manual,
and report exhausted Speech and translation failures explicitly. Worker evidence
reads must not impersonate the creator or write creator-read audit events. Test
concurrent dispatch, crashes/lost replies, bounded batches, stale/revoked/expired
source and actual local capture-to-review composition in a new disposable
synthetic database. No model/prompt/API change, new migration, cloud setting,
auth parser, route registration, live provider call, push, PR or deployment.

Next local runtime increment: pair the configured-capture repository explicitly
with the existing encrypted capture protocol and leased audio assembler. Default
legacy/imported access stays unchanged; configured capture cannot create legacy
transcripts or use the legacy worker. Capture status is only a recorder-phase
projection: bilingual source/translation/review/quality-pending states remain
`processing`, never `transcript_ready`. Only capture-phase transitions may use
the recorder writer; source publication/review retain their immutable writers.
Reuse the leased audio execution/heartbeat mechanism, derive language from the
immutable admission, and recover completed publication without another Speech
call. Test actual encrypted synthetic WAV assembly through the capture protocol,
lease/consent/cancellation negatives, creator review and legacy isolation in a
new disposable local database. No public route registration, live provider call,
cloud migration, new permission, client activation or deployment is included.

Follow-on runtime increment: add explicit captured-mode PostgreSQL admission and
atomic leased Speech-result publication, default off and without public routes.
Reuse the normalized writer, encrypted execution store and creator-review service;
keep all legacy/imported queries and defaults isolated. Validate exact job ID,
attempt, lease, source profile, current consent and retention. Bind exact replay to
an existing receipt; never turn a completed worker retry into a source correction.
No provider call or worker dispatch is introduced by the result publisher itself.
Test synthetic result publication, translated creator review, lost commit reply,
pool/process recovery, concurrent calls, stale/revoked/expired work and rollback.
Use a new local cluster; tests may remove only their exact generated tenant rows
with the disposable administrator after assertions, so later historical migration
rehearsals encounter no configured-capture fixtures. This test-only cleanup may
disable immutable-row triggers for those rows inside its transaction; it is not a
runtime deletion/retention path or permission to touch any existing database.

The owner explicitly approved an additional Scribe-only dormant migration to
connect captured audio to bilingual storage, tested only in a **new disposable
local database**. No cloud/shared database, Core/Auth/IAM/Zoom/staging edit,
push, PR or deployment. This does not permit converting existing recordings.

Tier 2 expand rung: admit newly configured `chunk_upload` sessions with immutable
creator/language/Azure-source profiles. Preserve every existing unconfigured
capture and configured imported session. Captured sessions must traverse capture,
upload and processing before receiving normalized source; imported sessions keep
their direct source-receipt path. Only capture/audio/job child roots are permitted
for configured capture. Legacy transcript/delivery writes remain fenced so they
cannot bypass bilingual review. Reuse the existing normalized source, translation,
working projection, consent, tenant and retention guards; no second transcript
store or external-source relabeling.

First qualify the dormant schema and its unchanged legacy behavior. Runtime
admission, leased Speech-result persistence, dispatch and authenticated routes
follow separately within the local runtime approval. Existing endpoints stay
unmodified and cannot see the new configured captures. A schema pass is not
capture-to-translation or beta acceptance. Record the new local revision after
`0018_translation_jobs`; reconcile the separate integration graph before promotion.

Recovery leaves the expansion dormant. Reversing its guards is allowed only in
the disposable-test database with no configured captures, under table locks;
refuse removal after use. Test tenant isolation, immutable provenance, forbidden
shortcuts/children, source/translation/review guards, preservation across upgrade,
unused downgrade/reapply, and the complete regression. Keep the stopped local
cluster/evidence and do not touch existing databases or other running apps.

### Encrypted translation job store — owner-approved 2026-09-21

The owner explicitly approved the Scribe-only encrypted job store and dormant
migration, tested only in a disposable local database. This supersedes ADR 0037's
earlier no-store restriction only for this local packet. No cloud or shared
platform changes, runtime registration, new endpoint, push, PR or deployment.

Tier 2 expand rung: add one encrypted job table, with tenant RLS, immutable
reservation identity, monotonic transitions and a source-lineage foreign key.
Reuse the existing RSA-3072 key-publication/unwrapping interfaces, but generate
fresh job-only AES-256 keys; never reuse a recorder's content key. Authenticate
scope, state and timestamps with the ciphertext. Reuse existing consent/session
locks and recheck current source/retention before atomic provider admission.
An ambiguous started call remains non-replayable. Source-retention deletion must
cascade to the encrypted jobs. No plaintext content or content digest in audit.

Use a distinct revision `0018_translation_jobs`, parent `0014` on this isolated
branch. Read-only inspection found revisions 0015–0017 in the separate integration
checkout; do not edit or import them. Before eventual integration, reconcile the
migration graph explicitly and rehearse it again; this local parent is not a
claim that the combined graph is ready to deploy.

Acceptance: fresh local PostgreSQL only, restricted non-owner role, encryption
and tamper negatives, process restart, competing claims, stale source, revoked
consent, retention cascade, immutable attempt/review reuse, lost acknowledgements,
and full regression checks. Tests use generated local RSA keys, not cloud keys.
Recovery leaves the expand table dormant. A used table cannot be downgraded;
empty-table removal is permitted only by this disposable-test rehearsal. Stop
the exact owned database after testing. Independent review and least-privilege
runtime grants remain promotion gates; existing runtime bootstrap is unchanged.

Follow-on local acceptance composes the existing Speech-result normalizer,
versioned source receiver, encrypted job store, actual translation adapter with
offline HTTP responses, immutable attempt/creator review and English handoff.
Use the same disposable-only boundary. Cover an English provider with a patient
switching between Spanish and English, refusal/incomplete results, unknown
language and overlap. Preserve source and speaker identity, reject handoff until
review, and reconnect before reconciliation to detect accidental process-memory
dependencies. This is a test-only composition: it does not register a worker,
admit an Azure source profile, implement a runtime transcript reader, connect
Core, exercise real speech recognition or qualify a physical client.

Run the existing migration/restricted-role/recovery tests against a new local
PostgreSQL cluster under an owned temporary directory, database name ending in
`_test`, Unix socket only, no TCP listener. Only invented test data is admitted.
This exercises the existing additive schema; it does not apply a migration to
the main, integration, development-cloud or production database. The existing
fixture's destructive downgrade tests are permitted only in this newly created
throwaway cluster. Stop only this cluster's verified process when finished;
retain logs/data for inspection without deleting any shared resource.

## Owner-approved private qualification extension — 2026-09-21

After connecting the iPhone, the owner stated: “You have the explicit approval
you need.” This approves the previously requested isolated Scribe private Speech
qualification setup/execution and selected native-device trial. It does not
authorize shared Auth/IAM/Zoom/staging changes, a push/PR, deployment of unmerged
code, production/PHI use, cohort admission or release publication.

Readback corrected an earlier inventory error: `cosmaneura-scribe-dev-smoke`
already runs `cosmaneura_scribe.speech_smoke_runner`, not API-route acceptance.
Its gate is false, backend is `none`, and its dedicated identity has only
`AcrPull` on the Scribe registry. Reuse this existing job. The deployed source
`eaf343a1152eccf7fff0a96652a1c3731902c30c` is a merged ancestor of the locally
recorded `origin/main`; registry readback resolves its tag to
`sha256:6ee5a221e50e284cf37d58f01746cbfe632c487c32fbcbd40158e7a713c1253c`.
The tag is mutable; do not describe it as an immutable deployment.

Run one no-override disabled-state execution, retain only fixed action/error
metadata, and verify the effective execution template. Do not treat this as
Speech inference. Enablement still requires the private acceptance runbook's
reviewed saved plan, current-state reconciliation and a qualified private
infrastructure execution path. No account/public-network relaxation or arbitrary
job command/environment override is an alternative. Leave clinical transcription
off. Removing any temporary Speech call authority follows the same reviewed plan
path, preserving the existing dormant job.

The phone must pass current unlock/developer-service and exact installed-bundle
checks before installing the preserved development package. Never overwrite an
existing unrelated app or collect a password, code or token. The W13 identity
snapshot still has capture/model services disabled and does not qualify full
device capture or a phone-reachable backend.

### Approved management-plane execution method

On 2026-09-21 the owner explicitly approved the proposed method instead of
creating another private infrastructure runner. Use this Mac only for the
authenticated, refreshed, saved Speech-only infrastructure plan. Audio execution
remains in the existing private Scribe job. This is the scoped exception to the
private-operator-location requirement in `SPEECH_PRIVATE_ACCEPTANCE.md`.

Protect the exact existing remote state before planning; keep all plans/state
outside Git, preserve locking and review current lineage/serial before apply.
The only permitted enablement changes are the existing smoke job's raw gate,
backend and owned endpoint/private-IP environment settings, plus its single
account-scoped Speech User assignment. Reject image/command/identity changes or
any API, network, key, database, shared IAM or other dependency action. Execute
the job once without overrides, verify its effective template and retain only
fixed outcome metadata. After the terminal result, use a fresh reviewed saved
reverse plan to close the gate and remove only the temporary assignment.
No new runner, unmerged deployment, PR/push, cohort activation or PHI use is
authorized. Existing image drift is retained temporarily, not silently reconciled.

Execution completed on 2026-09-21: one enabled, no-override private Speech run
`cosmaneura-scribe-dev-smoke-0wnnz72` succeeded and emitted
`speech_smoke.completed`. Both pinned synthetic cases passed the runner's 0.25
per-case WER ceiling. A reviewed reverse plan then restored the disabled job and
removed only the temporary account-scoped Speech User assignment. All 37 original
resource records and outputs match the protected snapshot; state lineage is
unchanged, serial 62 → 63 → 64. The API image/revision and private Speech network
boundary are unchanged. No trial retry or clinical activation is authorized by
this result. See the checkpoint for exact plan hashes, timestamps and limitations.

## Provider review surface — local runtime continuation

Tier 2: expose the persisted captured transcript and explicit creator decisions
through the existing app-only trusted-platform authentication dependency. Core
must supply freshly authorized creator context; the browser never chooses an
actor or receives a workload token. Reuse the existing idempotency table and
immutable review writer in one transaction. No auth parser, shared Core/IAM/Zoom,
environment setting, migration, live service, deployment or release changes.
The receiver remains unavailable without explicit server-side runtime binding
and a tenant allowlist. Build the reusable provider review screen against this
contract, not the old process-local synthetic ingest contract. Verify the
record-to-review feature and essential authorization/retry boundaries using a
new disposable local PostgreSQL cluster; one full regression at packet end.
Local runtime completion is not existing-user/native sign-in acceptance.

### Retained provider recorder and recovery continuation

Mount the existing review panel after upload in the retained capture component,
through an explicit host-supplied admitted session/controller and authorized
transport. Preserve default preview startup. Require encrypted scoped recovery
before sending decisions, using the existing native plugin and exact metadata
only; no new native key authority, database migration or auth parser. Clear the
view on binding loss and retain honest stop-failure state. Continue to note invokes
only a supplied existing Core entrypoint after a fresh readiness read.

Qualify actual rendered desktop/phone controls against the existing review API and
a newly owned disposable PostgreSQL database. Reuse generated encrypted capture
and offline Speech/model fixtures. Check acceptance, rejection, exact replay after
document loss, revoked-access clearing and failed host deactivation. This remains
local integration evidence, with host identity/native storage/Core entry explicit
fixtures. Run the affected capture/review workspace regression and static checks;
the prior 1,065-test Python checkpoint remains applicable to unchanged backend
source. No repeat live-service trial or native installation is included.
