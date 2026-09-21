# Scribe implementation handoff — 2026-09-21

This is the continuation prompt and current checkpoint for the user-created
replacement task. Read this file completely. Do not import the entire old
conversation or restart completed work. Statements about live services/devices
are dated evidence, not promises about their present state.

Continuation note: the replacement task resumed the full goal after verifying
clean HEAD `99324d87628ec22f038f5ee9a4918de8cb46abb8`. Read the latest section of
`SCRIBE_REAL_SERVICES_CHECKPOINT_20260921.md` for the subsequent recorder-mounted
review, durable decisions and browser/API evidence. The bounded Core consumer
packet in `beta/SCRIBE_PROVIDER_CORE_PACKET_20260921.md` was subsequently approved
and implemented locally. The configured-admission/Core SOAP packet in
`beta/SCRIBE_CONFIGURED_CORE_WORKFLOW_PACKET_20260921.md` was then explicitly
approved and implemented locally. The owner then approved the full local provider
controls. See `beta/SCRIBE_PROVIDER_WORKSPACE_20260921.md`, the newest checkpoint
and ADR 0048 for the mounted encounter/record/review/Core-note workflow and its
passing local browser/server evidence. Native/hosted activation remains open.
The checkpoint below remains historical; native/hosted/full-workflow acceptance
has not been declared complete.

Latest recovery: read `beta/SCRIBE_RECOVERY_20260921.md` before using any temporary
path below. The temporary W13 and local browser evidence directories are absent;
committed implementation survives. Verified recovered native inputs, a provider
build and a separately built diagnostic now live in a durable workspace folder.
The diagnostic is closed pending the specific launch confirmation required by
automatic approval review.

## 1. Your assignment

Take over the existing Scribe implementation at this checkpoint. Preserve the
full outcome:

> Deliver a standalone Scribe capability usable by both standalone clients and
> CosmasOS by closing real authentication/token custody, real STT/model/Spanish-to-
> English translation integration, physical iPhone qualification, targeted
> transcription/translation fidelity evaluation with reuse of Core SOAP
> evaluation, and reproducible signed release artifacts. Preserve existing work,
> use local Git inspection for deconfliction, reuse existing services and
> approvals, and obtain only missing device/account/release inputs needed for
> actual acceptance.

The owner wants operational MCD-provider use, not a synthetic demo, a library
alone, more test coverage alone, or a newly narrowed definition of beta.
The owner specifically expressed concern that too much effort was going into
testing/backend hardening instead of usable features. Prioritize completion of
the provider workflow. Retain essential security/consent/isolation/data-loss
checks, focused tests during implementation and a full regression at meaningful
checkpoints. Do not begin another standalone reliability tranche without a
concrete workflow blocker. Report what providers can do, not test counts first.

The owner requested this detailed handoff and explicitly said **pause the old
goal after the handoff**. The old task will call its pause tool after saving the
checkpoint. The owner, not an agent, opens the replacement task. One task should
own implementation on this branch at a time. Do not message or poll the old task.
This document does not automatically create/resume a goal in a different task;
follow the owner's new-task instruction and the tools available there.

## 2. Exact workspace and read order

Use this existing checkout; do not create another branch or worktree:

`/Users/jw/Desktop/Cosmas/cosmaneura-scribe-beta-preintegration-20260904`

Branch: `codex/beta-preintegration-20260904`.

Latest implementation commits, in order:

- `b28471d215749d41ab8d354eb5c4f7df43d6f84d` — automatic capture-to-review dispatch.
- `351463952089060dcdcb6c993e145d8531e6b9e9` — paired creator review receiver.
- `67d58a45a6c541e5f70a9dc6aa6b662cc5e5ef2f` — reusable bilingual provider panel.
- A following documentation-only commit contains this handoff and latest checkpoint.

The implementation tree was clean at `67d58a4`; verify current Git state before
editing. All changes are local/unpushed. The branch began from `1e48c12`, a
descendant of the originally authorized `b46ade8`; both ancestry relationships
were checked locally. Do not reset/rebase to the historical base.

Read, in this order:

1. Applicable `/Users/jw/Desktop/Cosmas/AGENTS.md`, then this checkout's
   `AGENTS.md` and `CLAUDE.md` in full.
2. This handoff and the **latest section only initially** of
   `docs/SCRIBE_REAL_SERVICES_CHECKPOINT_20260921.md`.
3. Mandatory CosmasOS product pointer, read-only:
   `/Users/jw/Desktop/Cosmas/d3-compact-proof-worktree/docs/reference/cosmasos-beta/START_HERE.md`.
   Use its current product/authority rules; do not confuse its broader OS beta
   percentages with standalone Scribe readiness. Do not replay the old
   insurance-only pilot as current scope.
4. `docs/beta/BETA_ONBOARDING_AND_ACCESS_CONTRACT.md` and
   `docs/beta/BETA_EXACT_ARTIFACT_ACCEPTANCE.md`.
5. Relevant current sections of
   `docs/flight-plans/scribe-real-services-qualification.md` and ADRs 0045/0046.
   Read earlier sections only when needed for a specific approval/evidence question.

Use absolute working directories in tools. The outer `/Users/jw/Desktop/Cosmas`
folder contains many unrelated checkouts and is not the implementation root.

## 3. Locked product features and boundaries

- **Separate products:** standalone Scribe and CosmaBot/CosmasOS are separate
  apps. Scribe must be easy for CosmasOS to use through an API. Do not collapse
  their deployment/origin/auth boundaries just to obtain a demo.
- **Desktop and Apple iOS together:** both are required at the initial beta.
  Preserve **iOS 17+** support. The owner's iOS 27 update was device/tooling
  qualification, not permission to raise the minimum supported OS.
- **Desktop telehealth:** Google Meet in Chrome and local Zoom Desktop meeting
  audio are in beta scope. Desktop Scribe replaces the Zoom meeting bot as the
  primary path. The bot is an explicit **pre-start fallback only**, never an
  automatic mid-recording switch.
- **Mobile:** consented foreground recording; visible state, deliberate Start/
  Stop, interruption/offline recovery and explicit resume. Background/lock must
  never silently record. Physical iPhone acceptance is required.
- **Encounter binding:** provider selects an authorized existing appointment or
  enters name/DOB for an unscheduled encounter. Possible matches require an
  explicit choice, not automatic merge. Core owns demographics and canonical
  encounters; Scribe receives opaque IDs, not names/DOBs.
- **Ownership:** every recording, transcript, translation and note is visible
  only to its creating provider, including scheduled and manually created work.
  Sharing a practice is not peer access or permission for support view-as.
- **Language:** manually select the supported language mode. Support mixed
  English-provider/Spanish-patient speech, including English spoken by the
  patient. Translate Spanish segments **to English**; preserve English speech
  and original source evidence. Earlier bidirectional plans were superseded.
  Other languages and automatic language-mode selection are not locked beta work.
- **Review and notes:** creator explicitly accepts/rejects proposed English.
  Preserve immutable source/translation/review history. Core's existing SOAP
  generation remains the sole note engine/system-of-record path. Do not build
  another clinical note generator. Unknown-language/overlap/failure states must
  be visible and prevent invalid handoff.
- **Micro-beta:** at most three internal/product testers, founder only inviter,
  one dedicated isolated synthetic practice/environment, no PHI. A limited
  synthetic dashboard is accepted. Outside-MCD testers must onboard safely too.
- **Authentication:** reuse existing Clerk user identity and existing Entra
  Core-to-Scribe workload authentication. Beta entitlement/grant is authorization,
  not a third login path. Existing MCD identity/session continuity must actually
  be tested. Do not promise “NO login issues” without evidence or as a guarantee.
- **Outside-MCD invite:** founder-only, exact verified-email binding, expiry,
  single atomic redemption, digest-only invite-token storage, revocation and
  metadata audit. Existing MCD users receive the beta grant without migrating
  their identities. Those Core gates remain unqualified here.

## 4. Non-negotiable deconfliction and authority

- No messages, polling, waits, forks, handoffs or coordination with any other
  Codex task/chat/project. Do not contact historical agents. Use local read-only
  Git/repository inspection. Do not create a new task or branch automatically.
- Continue only this local branch. **No push, PR, merge or unmerged deployment.**
  The old 36-hour stabilization estimate is not proof stabilization finished.
- No shared **Core/Auth/IAM/Zoom/staging** edits. In particular, reuse rather than
  change Scribe `service_auth.py` or desktop `capture-authority.ts` under this
  packet. A needed cross-repository change requires an exact new scoped approval.
- No PHI, live patient capture, cohort enrollment or production activation.
  No cloud/shared database migrations. No new cloud services, key grants or
  general infrastructure changes by implication.
- User approved the Scribe-only encrypted translation job store and dormant
  migration, and the later captured-audio/bilingual dormant expansion, tested
  **only in new disposable local databases**. These approvals were implemented;
  do not keep asking for the same completed packet. They are not cloud apply rights.
- User approved local runtime integration. This does not authorize exposing a
  live backend, deploying the branch or modifying shared authentication.
- User approved the exact private Speech execution method and selected device
  trial; the Speech job is completed/reversed. Do not rerun it or the terminal
  live translation trials. A fresh live-service campaign needs its exact scope.
- Branded DNS/SWA/TLS was approved and completed for `scribe-beta.cosmaneura.com`.
  This does not approve backend exposure, environment allowlist mutation or deployment.
- Preserve existing dirty foreign worktrees, saved native packages, unsaved app
  drafts and the owner's demos on **8125** and **8195**. Do not stop/restart them.
- Repository security rules remain: consent before processing, tenant from
  verified context, tenant-scoped queries, creator-only access, idempotency on
  mutations, metadata-only audits, no protected content/credentials in logs.
- New schema/auth/consent/environment/service/release scope requires approval.
  Independent non-implementer review is required before a future PR, but the
  present no-PR/no-cross-task restrictions remain. Do not claim that review happened.
- Use `apply_patch` for file edits; preserve unrelated changes. No destructive Git
  reset/checkout. Do not delete/restart resources just because an observation timed out.

## 5. What is implemented at the checkpoint

### A. Capture → Speech → translation → review

Read these existing modules rather than implementing parallel replacements:

- `captured_source_runtime.py`: explicit captured-session admission and atomic
  leased Speech result publication, consent/lineage/retention checks.
- `captured_transcription_worker.py`: captured worker reusing existing encrypted
  assembly, job leases/heartbeat, last-moment consent checks and cancellation.
- `captured_processing.py`: bounded discovery/dispatch, Speech exhaustion,
  initial Spanish translation reservation and encrypted stored-result recovery.
- `postgres_translation_jobs.py`, `translation_execution_v1.py`,
  `translation_job_encryption.py`: encrypted durable jobs and exact execution
  states. Started/uncertain provider calls are not automatically replayed.
- `azure_speech_source.py`: preserves source text/timing/phrase-language evidence
  and unknown speaker roles; no guessed clinical attribution.
- `azure_translation.py`: existing Azure GPT-4.1 Spanish→English adapter. Keep
  its model/prompt/filter/security contract unchanged unless separately scoped.
- `transcript_review_service.py`, `creator_review_contract_v1.py`, immutable
  attempt/review writers and existing English handoff serialization.

The dispatcher is a default-off callable runtime, not a registered automatic
scheduler/production worker. All provider/credential/key resources are injected.
Production credential/bootstrap/lifecycle integration remains open. Initial work
is bounded; failed or creator-rejected translations need an explicit retry
reservation. Stored results recover before new calls. No automatic review or
SOAP handoff occurs.

### B. NEW: paired review API — `3514639`

`services/api/src/cosmaneura_scribe/creator_review_routes.py`, registered in
`main.py`, exposes GET/POST `/v1/captured-sessions/{session_id}/review`.

Normal startup remains unavailable. Server bootstrap must explicitly attach a
`CreatorReviewRuntime` to `app.state.creator_review_runtime`, with enabled=true
and the permitted tenant IDs. Existing Entra app-only authentication remains
mandatory. The trusted Core/BFF must freshly authorize the real user and supply
`X-Scribe-Creator-Actor-ID`; it must not forward an arbitrary browser actor header.
This route does not itself authenticate a Clerk user or prove that Core already
implements the needed forwarding.

GET returns recording/transcription status before a source exists, then validated
source/English working transcript/review queue. After handoff it returns metadata
only. It never processes audio or calls a model. Detailed dispatcher states such
as an uncertain translation call are not all represented separately in this view
yet; inspect the stored status/blockers before designing the remaining UX.

POST accepts only exact source/translation lineage and accept/reject, plus an
`Idempotency-Key`. It authorizes and claims the existing receipt in the same
transaction as the immutable review write. Replays recover persisted review ID/
time. Changed retries conflict. This is current-source, pre-handoff recovery,
not an indefinite historical decision-resolution endpoint. No new migration.

Transport UUID/enum decoding is in `CreatorTranslationDecisionBodyV1`; version
integers stay strict. The underlying domain request remains strict. OpenAPI and
the existing capture TypeScript schema were regenerated, not hand-edited.

### C. NEW: reusable provider review panel — `67d58a4`

In `apps/review-ui`:

- `src/creator-review-api.ts`: generated API types, bounded response parsing,
  session/version consistency checks and an injected authorized request transport.
- `src/creator-review-panel.ts`: `mountCreatorReview(root, api)` returns a disposer.
  It renders original Spanish beside proposed English, unchanged English speech,
  explicit accept/reject, quality blockers, status and English readiness.
- `src/creator-review.css`: desktop/mobile responsive styling.
- `src/creator-review-entry.ts` and `creator-review.vite.config.ts`: reusable ES
  module/CSS build. The regular build creates the old app first, then this bundle.

The panel does **not** acquire/store auth tokens, invent a login, choose a tenant/
creator, generate/sign a note or persist a dashboard encounter. The authenticated
host must supply existing BFF/native transport and dispose on logout/session change.
Unavailable responses clear protected content; an uncertain save retains the
same metadata request/key in memory for explicit retry. There is **no durable
pending-decision journal across reload/native restart yet**.

IMPORTANT: the panel is built and API/contract/render tested, but **not mounted in
the actual standalone native or OS shell**. No browser visual/control or physical
device acceptance of this new panel has happened. Do not call it an operational
provider app. The original process-local synthetic ingest preview is unchanged.

## 6. Exact verification and retained artifacts

At this checkpoint:

- Complete Python regression: **1,065 passed, 0 failures/errors/skips**, 119.557 s.
- Four new API checks exercise generated capture → translation → review,
  concurrent/exact retry, fresh receiver receipt recovery, preserved original
  source, creator/cohort/auth rejection, consent revocation and invalid body/key.
- All **13 review-UI checks** passed (four new contract/render/transport checks).
- Strict API Pyright; affected Ruff; review-UI TypeScript and ESLint; generated
  OpenAPI/TypeScript; both UI builds; ADR numbering and whitespace checks passed.
- Tests used actual local PostgreSQL and capture protocol/encrypted generated WAV,
  but identity acquisition, Speech/model, blob/key services were explicit fixtures.
  Tests do not establish physical-device, real-login, clinical or release readiness.

JUnit: `/private/tmp/scribe-review-surface.0xben8/verified.xml`

SHA-256: `13e1ec050b5b5ffc70fac318a5e70642ef11d08b67759f677017bbfeb5cc1ef4`

Disposable database `scribe_review_surface_test`, owner
`scribe_review_surface_owner`, socket
`/private/tmp/scribe-review-surface.0xben8/socket`, port 55454, no TCP. Final public
schema contained only `alembic_version`. PID **82950 was stopped and confirmed
absent**. Retain data/logs. Do not restart this completed cluster for a new packet.

Panel build artifacts (ignored local outputs, not signed native releases):

- `apps/review-ui/dist/creator-review/creator-review.js`, SHA-256
  `a4879be15a8d839b84f424e933cbd58e28b6ee019d57e9e9503a7c98ab1bde46`.
- `apps/review-ui/dist/creator-review/creator-review.css`, SHA-256
  `564d42c3991cab1b0a665d13b4fa52e2a20419d6bb45686620b946e22bb0510c`.

There is no current review UI server or owned test database to wait on. Do not
mistake retained evidence files for live work. Older owner app/demo processes
must be inspected by exact PID/handle before any intervention.

## 7. Database isolation: explain this accurately

The Scribe-only schema additions are **dormant code**, rehearsed only in disposable
local databases. They were not applied to the main/shared/cloud MCD database.
Do not promise a permanently separate deployed database from this fact alone;
the exact runtime/deployment/database choice still needs its approved integration.

Relevant head: `alembic/versions/0019_captured_bilingual.py`, revision
`0019_captured_bilingual`, parent `0018_translation_jobs`.
0019 expands guards for captured bilingual sessions; it adds no new columns/
tables or backfill. It preserves legacy/imported paths and disallows raw legacy
transcripts/deliveries for configured captures. Expand recovery leaves structures
dormant. Removal/downgrade was allowed only under the disposable-test runbook.

Other integration checkouts have a different 0015–0017 migration history. The
combined migration graph is **not reconciled**. Do not silently retarget, copy,
merge or apply migrations from those branches. Flag exact reconciliation work
before any deployment/migration authority is requested.

## 8. Real-service evidence already obtained — do not rerun blindly

### Private Speech

Existing private Scribe job run
`cosmaneura-scribe-dev-smoke-0wnnz72` succeeded on 2026-09-21, approximately
13:35:11–13:35:40 UTC. Two synthetic cases passed its per-case WER ≤0.25 ceiling.
This is not mixed-language clinical/device end-to-end acceptance.

The temporary settings/permission were reversed through the approved saved-plan
method. Temporary Speech User assignment
`53cd9a48-e2d8-c878-bcd6-f83644037df5` was removed. Original 37 resource records and
outputs matched; state serial 62→63→64. Existing API dev revision `--0000004`
was not replaced. Speech remains private/public-disabled/local-auth-disabled.
The trial is terminal; no repeat call or public-network relaxation is authorized.

### Translation

Existing endpoint: `https://cosmascode.services.ai.azure.com/openai/v1`.
Model `gpt-4.1-2025-04-14`; prompt profile `scribe-es-en-fidelity-v1`.
Seven fixed invented cases returned HTTP 200/reference agreement; one quoted-
instruction case returned HTTP 400. Diagnosis was Azure content filtering,
`ResponsibleAIPolicyViolation`/jailbreak. Do not change the reference/prompt/filter
or repeat live calls merely to obtain a pass. Source-preserving failure and
blocked handoff are intentional.

No terminal live-service trial established the complete current client→real
Speech→translation→human review→Core SOAP→MCD dashboard flow.

## 9. Device, authentication and release evidence

Owner's previously observed phone: iPhone 12 (`iPhone13,2`), UDID
`00008101-0004452A0250001E`, updated by the owner to iOS 27. Recheck connection,
unlock/developer-service state and exact installed bundle before device work.
Never request/collect the passcode, password, code, access token or session cookie.

Installed/launched trial: **CosmasOS Synth W13**, bundle
`com.cosmasos.synthetic.w13`, version/build 1.0/1. It is an **OS native auth
qualification snapshot**, not the completed standalone Scribe app. Earlier owner
observation reached a DeviceHub/welcome/encounter-selection state. Successful
Tester sign-in, correct claims, Keychain custody, refresh/restart/logout/revocation
and recording-to-service acceptance remain unproven here.

W13's packaged API points to `http://127.0.0.1:8046`, which on a phone means the
phone, not the Mac. Do not present this as a reachable beta backend. A qualified
HTTPS backend/native-origin/callback combination is still needed.

Existing selected test identity context, not credentials:

- Clerk domain `sharp-bluegill-3253.clerk.accounts.dev`.
- App `app_3Ion1rG2Nz9xmRjoAb2JcsPNFie`, instance
  `ins_3Ion1s4mUNx4kYIeHYTLdVxjR0q`.
- Organization CosmasBetaLab, `org_3IonFhWeRdI0H9nOPcuyXiqqbmv`.
- Tester is the intended account; audience `cosmas-os-beta-api`.
- Existing origins `app://cosmas`, `capacitor://localhost`.
- Saved callbacks `com.cosmasos.synthetic.desktop.auth.w13://callback` and
  `com.cosmasos.synthetic.w13://callback`.

Prior W13 runner/package paths, for targeted inspection only:

- `/private/tmp/cosmas-w13-auth-work/run-signin-api.py`.
- `/private/tmp/cosmas-w13-auth-work/activation-signin/CosmasOS Sign-In Trial W13.app`.
- Existing W13 database at loopback port 55445, `w1a_w13_signin`: **preserve**.

Older API execution handle 62456 is historical, not verified live now. Later OS
documentation recorded its process absent. Check actual state; do not restart
based solely on an old handle, timeout or retained file. Do not touch owner demos.

Retained device/release evidence:
`/Users/jw/Desktop/Cosmas/scribe-device-qualification-20260921.AGGjR0/`.
`Scribe-W13-development.ipa` SHA-256
`097754a4370de69921dd1f55f9b851cabaffbd85505f2ff44c7c9ec2cd78eaa8`.
Development signing identity John Clemente / `86G53QQW94`, team `JVV65668U6`.
Canonical clean-build compiled payloads/UUIDs matched, excluding variable signing/
ZIP bytes. This is not cross-machine hermetic reproducibility, Distribution/
TestFlight acceptance or desktop Developer ID/notarization acceptance. Preserve
the old artifacts; never relabel them as a current standalone Scribe release.

## 10. Branded URL: DNS works; application is not operational

`https://scribe-beta.cosmaneura.com/` is provisioned as DNS-only CNAME to
`green-rock-0cd7d7e0f.7.azurestaticapps.net`, with SWA custom-domain Ready and normal
TLS/HTTP 200 observed. Resource: `cmn-capture-preview-p8x6m2`, resource group
`cosmaneura-capture-preview-development`, Standard SWA.

The page is still the synthetic silent-source preview, not a qualified Scribe
runtime. Last readback: branded health request 403 `preview_host_rejected`;
original Azure hostname health 200. Live `CAPTURE_PREVIEW_ALLOWED_HOSTS` allowed
only the original host. The local parser also requires an `.azurestaticapps.net`
suffix, so simply changing the live setting would break startup. No allowlist
change, app deployment or clinical backend exposure was approved/performed.

The clinical Scribe environment remains internal/public-network-disabled per
last readback. DNS ownership does not make it a phone API. Do not bypass TLS,
publicize the private backend or use the old preview as evidence of beta readiness.
CosmaBot/CosmasOS needs its own URL; this task did not provision/change that URL.

## 11. Next implementation checkpoint — prioritize the usable workflow

First inspect current Git, then read the new receiver/panel and the current
standalone capture/client transport. Reuse them. The next feature outcome is:

**An authorized provider finishes a recording in the real client, sees progress,
opens the persisted mixed-language transcript, explicitly accepts/rejects English
translations, and can continue through the existing Core note flow without
changing identity or viewing another provider's work.**

Concrete sequence:

1. Mount the existing panel in the actual standalone recording/review workflow,
   using the recorded session ID and the existing authenticated BFF/native
   transport. Do not invent another fake app, login path or browser-held Entra
   workload token. Dispose/clear on logout, revocation and encounter switch.
2. Determine the precise existing Core/BFF support for fresh creator context and
   the new receiver. If a Core edit is needed, prepare the smallest exact packet
   and obtain authority rather than silently editing the shared repo. Current
   Scribe-only approval does not manufacture that missing authorization.
3. Connect the current processing runtime and the real provider/key credential
   lifecycle at approved bootstrap points. Distinguish metadata progress,
   uncertain provider calls, explicit retry requirements and fatal quality blocks.
   Keep the audio DEK and encrypted job-store key authority separate.
4. Verify the usable local feature with the actual rendered controls and API,
   including one accepted translation, one rejected/blocked path and reload/
   interrupted-save recovery. Integrate the existing durable native journal
   where applicable; current panel memory alone is not crash recovery.
5. Qualify actual native authentication/token custody and a phone-reachable
   approved backend. Ask only for missing owner/account/device/release actions,
   not for already completed local-store or private Speech approvals.
6. Run the exact candidate on desktop and physical iPhone, with supported older
   iOS qualification, then a representative mixed-language audio-to-Core note
   evaluation. Obtain permission for a new live-service run when required.
7. Finish signed/reproducible distribution artifacts, installer/update/rollback,
   cohort onboarding and PHI-operating gates before controlled MCD activation.

Keep the full objective active in the replacement task if the owner asks to
resume it. Do not declare completion because local tests/builds pass. If blocked
by missing authority, explain the exact minimal change and why it is necessary.

## 12. Readiness and remaining acceptance

Last owner-facing estimate: **about 55% ready for actual MCD desktop+iOS operation
(50–60% range)**. It is engineering judgment, not a measured score. The new local
receiver/panel does not justify calling real auth, devices, Core dashboard or
release qualified. Do not reuse the broader CosmasOS 60–65%/4–6-week estimate as
Scribe's estimate, and do not invent an updated hours estimate from test counts.

Still open:

- Existing MCD user login/session continuity; outside-MCD invite/grant lifecycle;
  creator mapping on both native clients; secure token custody and revocation.
- Real capture/STT/Spanish→English/review/Core SOAP/creator-dashboard end-to-end.
- Google Meet and Zoom local-capture qualification plus pre-start fallback.
- Physical iPhone, interruptions/offline/resume and iOS 17+ compatibility evidence.
- Targeted fidelity under accents, code-switching, noise, overlap and omissions.
  Focus on negation, dose/units, uncertainty, attribution and preserved meaning.
  Reuse Core SOAP evaluation; do not add a second clinical reasoning engine.
- Reconciled migration/deployment base, private credential/service integration,
  exact signed distribution artifacts, operations/retention/recovery and explicit
  founder acceptance. Nothing currently enables MCD PHI use.

## 13. Useful commands and test fixtures

Python environment: this checkout's `.venv`, Python 3.12. PostgreSQL 16 tools:
`/opt/homebrew/opt/postgresql@16/bin/`.

Node 24 binary:
`/Users/jw/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.
Pinned npm 11.5.2 was installed via Corepack for this packet; locked repository
dependencies are now present in `node_modules`. No dependency versions changed.
The system Node/npm are older: do not accidentally use Node 22/npm 10.
Temporary Corepack/npm caches: `/private/tmp/scribe-review-surface.0xben8/`.
The retained `/private/tmp/cosmaneura-scribe-node24-bin` shim selects Node 24.

Routine commands from this checkout:

```sh
.venv/bin/ruff check <changed-python-files>
.venv/bin/pyright
.venv/bin/python scripts/generate_openapi.py
.venv/bin/python scripts/check_adr_numbers.py
git diff --check
```

Use pinned Node/npm for review-UI test/typecheck/lint/build scripts. Generate the
capture TypeScript schema with existing `openapi-typescript` after OpenAPI changes.
Do not hand-edit generated contracts. Do not rerun the full suite simply because
you resumed; the evidence above is available. Run appropriate checks after changes.

For a genuinely new database rehearsal, create a **new owned mktemp directory**,
UTF-8 database name ending `_test`, private Unix socket and no TCP listener.
The existing suite performs migrations/destructive fixture teardown; never point
it at an existing/shared database. Stop only the verified owned PID and retain logs.

Reused fixtures:

- `tests/test_captured_source_runtime.py`: `trial`, captured admission/source.
- `tests/test_captured_transcription_worker.py`: `capture`, actual capture HTTP
  protocol and encrypted generated WAV with offline Speech/blob/key fixtures.
- `tests/test_captured_processing.py`: `flow`, automatic processing and encrypted
  translation job fixtures.
- `tests/test_creator_review_routes.py`: current paired review receiver feature.
- `apps/review-ui/src/creator-review.test.ts`: current frontend contract/render/
  transport checks, not native/browser interaction acceptance.

## 14. First reply and reporting expectations

Briefly acknowledge the preserved scope and current state. Then take the next
safe implementation action; do not reopen all product decisions or produce
another broad architecture study. Do not contact another task for clarification.
If the source differs from this checkpoint, reconcile it by local inspection and
preserve others' changes. Report concrete provider capability, verification scope,
remaining acceptance and exact missing input. Never equate green tests, DNS,
development signing or a W13 welcome screen with an operational MCD launch.
