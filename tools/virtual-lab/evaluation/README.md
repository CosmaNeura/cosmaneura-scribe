# Synthetic speech and Core-note evaluation

One invented visit tests correction, negation, complete Plan/follow-up, speaker roles and early/middle/late continuity. JiWER and finite propositions run without a model account. Clinical correctness is never declared; the optional promptfoo semantic judge needs calibration against clinician-reviewed synthetic examples.

Use isolated Python3.13/JiWER4 and Node24/tsx4.23.12/promptfoo0.125.0:
```sh
"$SCRIBE_LAB_PYTHON" tools/virtual-lab/evaluation/evaluate.py self-check
"$SCRIBE_LAB_PYTHON" tools/virtual-lab/evaluation/evaluate.py fixtures --output /absolute/new/audio-directory
"$SCRIBE_LAB_PYTHON" tools/virtual-lab/evaluation/evaluate.py grade --manifest /absolute/audio-directory/manifest.json < synthetic-service-evidence.json
```
Fixtures write consent before macOS `say` synthesis, without microphone or playback. The manifest freezes PCM16 mono16kHz bytes; different OS voices may differ. Actual captures still need the app/server consent gate and their separate actual consent ID.

Imported evidence requires `case_id`, `synthetic_only:true`, `evidence_kind:"imported_service_results"`, actual `consent_record_id`, `fixture_consent_record_id`, manifest `truth_sha256/audio_sha256/silence_audio_sha256`, raw source `transcript:[{speaker_role,content}]`, complete actual `draft` receipt, and `silence_transcript:[]` from separate real silence recognition. Treat input as sensitive; never log or attach it. Reports contain metadata only. Import validates receipt consistency, not authenticated provenance.

`makeSuite()` needs absolute broker/manifest/Python paths and SOAP `schemaRef`; `judgeProvider` is optional. Set `PROMPTFOO_DISABLE_TELEMETRY=1`, owned `PROMPTFOO_CONFIG_DIR`, caching off and `writeLatestResults:false`; ordinary promptfoo output/database may retain text. Run Node with absolute `--import /isolated/runtime/node_modules/tsx/dist/loader.mjs`.

The concrete desktop host imports UI assets. Build it through existing Vite SSR:
```sh
node tools/virtual-lab/evaluation/build-desktop-broker.mjs /absolute/new/broker-build
```
CoreClient calls actual `capture-notes` templates/read/prepare, product parsers validate source/ordered-note hashes, preparation is idempotent, and native revision changes fail closed. Raw source speech is compared with truth; edited speech cannot hide ASR loss. No direct model, endpoint, token or forged actor is accepted.

**One live prerequisite:** an authorized native session bound to the completed synthetic capture. The built `desktop-broker.mjs` adapts actual preload ports through `createDesktopProviderApplicationHost().host.connect().workspace.openEncounter()`; its mount supplies the scoped `request`. Export its `executionKind/openSyntheticSession` from the selected module. Selection needs `caseId,syntheticOnly,consentVerified,consentRecordId,sessionId,appointmentRef,audioSha256`; independent `readSilenceResult()` returns `syntheticOnly,audioSha256,transcript`. Existing receiver runtime needs managed identity, registry and mounted configuration; no token-only or fake-live shortcut exists.

Cleanup closes only this connection. The adapter does not create records, record, save edits, delete data or sign out. Persistence uses the separate lane. Native startup and physical capture timing remain outside this evaluator.
