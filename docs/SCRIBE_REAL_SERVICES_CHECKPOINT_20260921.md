# Scribe real-service qualification — 2026-09-21

Status: meaningful implementation and real-service/build evidence; **not a beta
release or closure of the five owner goals**. All repository edits remain on
`codex/beta-preintegration-20260904`, based on `1e48c124f355f486d8106c7f7441fd13895c3c97`.
No push, PR, schema migration, shared Core/Auth/IAM/Zoom/staging edit or Azure
infrastructure mutation occurred. Newer integration checkouts were read-only.

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
| Real STT/model/translation | Concrete Azure GPT-4.1 translator now implements the existing adapter interface. Final real run returned seven HTTP 200/reference agreements and one HTTP 400 rejection. Azure phrase-language evidence now survives into an opt-in normalized-source bridge. | Private Speech job execution; admitted provider/model profiles; durable normalized receiver/translation/review integration in the current standalone and OS paths. No runtime route or worker registers the new bridge/translator yet. |
| Physical iPhone | Arm64 device builds, Release-configuration archives and an installable development IPA succeeded; the exported app's signature, entitlements and paired-device profile membership verify. | Paired iPhone 12 remains unavailable; earlier developer-image services were unavailable. No install or physical recording was completed. Phone also needs an approved reachable HTTPS backend, not the Mac's localhost. |
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

## Private Speech execution is still gated

Read-only ARM inspection found the owned `cosmaneura-scribe-dev-speech` resource
with public network access disabled. The current API revision is `--0000004`
using image tag `804c4bacd692bc157ab101ff5055d999e00a37cc`. Only the existing API
smoke job was found; no Speech acceptance/transcription job was deployed.

Follow [Private Speech acceptance](SPEECH_PRIVATE_ACCEPTANCE.md): reconcile the
deployed/source state, use an approved merged candidate and private infrastructure
runner, review the bounded dormant-job plan, prove disabled behavior, then grant
account-scoped Speech User for the fixed synthetic acceptance execution. No public
access, arbitrary in-container execution, command override or shared IAM edit is
an alternative. The owner's earlier no-infrastructure restriction has not been
treated as silently lifted by the broad goals request. Actual deployment requires
an explicit scoped decision.

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

This is still the W13 authentication qualification snapshot, whose real
STT/model/capture service wiring is disabled. Translation service evidence is a
separate artifact, not proof of connection to this app. No installation, physical
recording, successful login, TestFlight upload or new Apple account configuration
was performed in this continuation. Promote the exact verified package for its
scoped trial; do not rebuild and call it the same artifact.

## Local verification and next acceptance sequence

Final Python regression: **647 passed, 183 skipped**. Skips require the disposable
PostgreSQL test configuration, which was not provided; no new database acceptance
is claimed. Ruff and strict Pyright pass. The initial run exposed an ADR-number
collision (fixed by using 0039) and system Node 22; the final run selected the
existing required Node runtime through `CAPTURE_PROTOCOL_NODE`. No dependency or
global runtime upgrade was made. No API or storage schema changed.

Next sequence:

1. Owner completes the selected test-account sign-in and connects/unlocks the
   paired iPhone over USB. Preserve existing apps/drafts; check installed app
   identity before installing the distinct candidate. Qualify real token custody.
2. Approve the bounded private Speech deployment/execution path separately from
   shared platform stabilization. Keep clinical transcription disabled until its
   existing acceptance run passes.
3. Wire the admitted Speech source and real translator through durable receiver,
   current consent/creator checks and review in a reconciled Scribe integration
   slice; reuse the same capability from standalone and CosmasOS.
4. Run the physical consented invented audio → bilingual source → reviewed English
   → Core SOAP loop, then interruptions, restart, revocation and retry recovery.
5. Resolve reproducibility differences and distribution inputs; build/verify the
   exact desktop+iOS artifact set with installer/update/rollback evidence. No
   cohort admission, PHI use, release upload or production activation is implied.
