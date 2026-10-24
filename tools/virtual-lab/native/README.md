# Native virtual recording lane

This runner installs nothing, changes no system audio defaults, requests no microphone access,
and never targets an existing installed host Scribe. Orchestration supplies owned targets/Appium.
Build in that target: `xcrun swiftc audio.swift -o /OWNED_ROOT/bin/audio`.
Run `python3 lab.py doctor CONFIG --output RECEIPT`, then `probe`, then `run`; failures exit 2.
`doctor` opens no app or stream. `probe` plays a hash-bound synthetic WAV into BlackHole and
taps it for three seconds, reporting counts/rate/RMS. Give it nonzero audio in those seconds.

Replace template placeholders after native accessibility inspection on a synthetic account;
templates have `syntheticOnly: false`. Record/Finish/Save require configured actual state waits.
Reopen requires a text assertion; its `relaunch` step runs only after saved state. Cleanup retains
an app that may be recording. Credentials use type-step `env` keys and never appear in output.

Target marker: `purpose: scribe-synthetic-virtual-lab`, matching `role`/`hostname`. Mac guests need
`interactiveSessionUnlocked: true` and confirmed unlocked native state; unknown fails. Apps reside
under `TARGET_ROOT/apps` with matching bundle ID/build. iOS needs a simulator `.app` with
`DTPlatformName: iphonesimulator` and an owned `udid` in target/marker. It can run on the host,
without touching physical phones or host Mac Scribe. Use isolated Appium on loopback port 4729.

`consentReceipt`: normal consent `source: normal-consent-path`, valid `recordId`, matching
`scenarioId`, `verified: true`, `syntheticOnly: true`. `audio.scribeRouteReceipt` binds `observedIn:
scribe-native-preparation`, `inputKind: virtual`, selected `uid`, `bundleId`/`build`, `verified: true`.
iOS also needs `simulatorRouteReceipt`: `observedIn: simulator-sound-input`, matching `uid`/`udid`,
`verified: true`. Collect from actual preparation/input selection, never manufacture these receipts.

Prepare native UI permissions and Scribe/probe microphone authorization on the owned target.
BlackHole is optional until installed. Keep artifacts synthetic and metadata-only. Route probes prove
this helper's AVAudioEngine, not Scribe capture. Journey results prove configured UI assertions;
native PCM/chunk continuity, saved-audio playback and Core integration need correlated evidence.
Keep production-built Mac identity separate from simulator/development tests; SCStream meeting
audio is separate from BlackHole. Locked Mac UI limit: https://developer.apple.com/forums/thread/840965.
`wda_smoke.py SIMULATOR_MARKER --output RECEIPT` tests only Settings on the owned simulator.
