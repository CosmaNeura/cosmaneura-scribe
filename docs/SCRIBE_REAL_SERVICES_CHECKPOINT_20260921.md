# Scribe real-service qualification — 2026-09-21

Status: meaningful implementation and real-service/build evidence; **not a beta
release or closure of the five owner goals**. All repository edits remain on
`codex/beta-preintegration-20260904`, based on `1e48c124f355f486d8106c7f7441fd13895c3c97`.
No push, PR, migration of an existing/shared database or shared Core/Auth/IAM/Zoom/
staging edit occurred. Newer integration checkouts were read-only. Later migration
tests used a new disposable local cluster. Following explicit owner approval,
the existing private Speech job passed both disabled-state and enabled synthetic
acceptance. The enabled trial temporarily changed only its environment settings
and added one account-scoped Speech User assignment; both were reversed and the
original resource/output state verified. No clinical runtime was activated.

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

### Next local integration packet — scope extension requested, not approved

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
