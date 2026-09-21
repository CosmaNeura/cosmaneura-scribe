# Scribe real-service qualification — 2026-09-21

Status: meaningful implementation and real-service/build evidence; **not a beta
release or closure of the five owner goals**. All repository edits remain on
`codex/beta-preintegration-20260904`, based on `1e48c124f355f486d8106c7f7441fd13895c3c97`.
No push, PR, migration of an existing/shared database, shared Core/Auth/IAM/Zoom/
staging edit or Azure resource-configuration mutation occurred. Newer integration
checkouts were read-only. Later migration tests used a new disposable local
cluster. Following explicit owner approval, one existing disabled Speech job was
started without overrides; its fail-closed result is recorded below.

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
| Real STT/model/translation | Concrete Azure GPT-4.1 translator now implements the existing adapter interface. Final real run returned seven HTTP 200/reference agreements and one HTTP 400 rejection. Azure phrase-language evidence now survives into an opt-in normalized-source bridge. The existing private Speech job passed its live disabled-state check. | Enabled private Speech inference; admitted provider/model profiles; durable normalized receiver/translation/review integration in the current standalone and OS paths. No runtime route or worker registers the new bridge/translator yet. |
| Physical iPhone | Verified development package installed and launched on the physical iPhone 12 after owner passcode entry. Exact bundle was absent before installation, installed version/build is `1.0/1`, and its process was observed running. Signature and artifact hashes reverified. | Rendered UI, successful Tester login, token custody, recording/interruption/recovery and end-to-end services remain unqualified. Phone also needs an approved reachable HTTPS backend, not the Mac's localhost. |
| Source fidelity | Fixed tests cover negation, dose, self-correction, uncertainty, pregnancy, allergy, attribution and quoted instruction text. Golden references were defined before service calls. | Quoted-instruction input is rejected; safe blocked/review UX must be exercised. Full consented synthetic audio/translation/Core-note loop and human review remain. Do not change references or bypass provider filtering merely to get a pass. |
| Signed/reproducible artifacts | Canonical-path clean builds now match compiled payloads and UUIDs; signatures, public entitlements and all 332 source inputs verify. The exact exported development IPA, source and symbols are retained outside temporary storage. | Signing/ZIP bytes still vary; cross-machine/hermetic reproducibility is unproven. No Apple Distribution identity, TestFlight acceptance, desktop notarization, cross-client installer/update acceptance or production artifact set was established. |

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
  reason for HTTP 400 is not established.
- Evidence: `/private/tmp/scribe-real-services-20260921.ySJT7W/translation-live-final.json`.
- Evidence SHA-256: `913af2c2be54fe7857f515fc3ec70857528ac7ec230ea6765a855705b0bc2355`.

`azure_speech_source.py` preserves actual `en-US`/`es-US` phrase evidence and exact
text/timestamps. Missing/unsupported locales stay unknown, language confidence is
unset, and speaker roles are not inferred from language or channel. The manually
selected mixed mode supplies Azure with two candidates rather than the invalid
single locale `en-US+es-US`. Unknown source language remains a note-readiness
blocker. The legacy raw transcript writer does not persist these locale fields;
the versioned receiver must be wired before calling bilingual capture complete.

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

Enablement remains a technical execution prerequisite, not renewed owner consent:
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

Proposed execution-method exception, **not yet approved or performed**: use this
Mac only for an authenticated, saved, refresh-enabled management-plane plan
targeting the existing Speech job and its account-scoped Speech User assignment.
The job continues to execute audio processing only inside the existing private
environment. This changes the runbook's private-operator-location requirement,
not the Speech network boundary; obtain explicit owner direction before use.

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

Next sequence:

1. The distinct W13 app is now installed and launched on the physical iPhone.
   Complete selected test-account sign-in and qualify real token custody, restart
   and logout. Preserve all existing apps/drafts and enter credentials only in
   native/hosted UI; never send a passcode or password to the agent.
2. Execute the already-approved bounded private Speech enablement through a
   qualified private saved-plan path, retaining all unrelated deployed state.
   Its disabled-state live test has passed. Keep clinical transcription disabled
   until the enabled synthetic acceptance run passes.
3. Wire the admitted Speech source and real translator through durable receiver,
   current consent/creator checks and review in a reconciled Scribe integration
   slice; reuse the same capability from standalone and CosmasOS.
4. Run the physical consented invented audio → bilingual source → reviewed English
   → Core SOAP loop, then interruptions, restart, revocation and retry recovery.
5. Resolve reproducibility differences and distribution inputs; build/verify the
   exact desktop+iOS artifact set with installer/update/rollback evidence. No
   cohort admission, PHI use, release upload or production activation is implied.
