# Synthetic Zoom participants

This promotes the October 24 round harness into portable tooling. The audio stays
outside Git; `rounds.registry.json` pins the original three manifests. Set the
fixture root to a directory containing those case folders. Each audio read first
validates the registry pin, manifest, consent, waveform hash, PCM16 mono 16 kHz
format, frame count, signal, clipping and initial silence. `createParticipant`
accepts only fixtures returned by the in-process registry validator.

```sh
node --test tools/virtual-lab/zoom/participant.test.mjs
node --test tools/virtual-lab/zoom/resource-owner.test.mjs
node tools/virtual-lab/zoom/self-test.mjs "$SCRIBE_LAB_ROOT/zoom/rounds-20261024" \
  "$SCRIBE_LAB_ROOT/runtime/node_modules/playwright/index.mjs" \
  "$SCRIBE_LAB_ROOT/zoom-self-test.json"
```

The browser self-test opens only its own loopback server and generated stream.
It proves initial silence, popup injection, nonzero stream audio, bounded pause,
retained-offset resume and fixture changes without replacing the microphone
stream. Its product observer is explicitly mocked. It does **not** qualify a
Zoom join, consent, native recording, transcription or saved playback.

## Coordinator API

Import `openFixtureRegistry` from `fixture.mjs` and `createParticipant` from
`participant-session.mjs`. Open the registry with `{root, registryPath,
registrySha256}` from the reviewed run manifest, then `load({caseId, file})`.
Do not calculate a new trusted pin from an unreviewed manifest to evade a mismatch.
Adaptive speech must first be archived with ground truth and a separately pinned
consent/fixture manifest; keep those runs separate from fixed comparisons.

Create one participant per logical identity using `{fixture, playwrightPath,
executionKind: 'live', observeProduct, audioConnectedControl, headless, signal,
resourceOwner: {runId, ownedRoot}}`. Use the native admission run UUID and an exact
private run-output subdirectory for `ownedRoot`. Every
participant owns a separate browser/context. The credentials for clinician app
contexts belong to the coordinator and never go into this patient participant.
`navigate(url)` accepts HTTPS Zoom domains; `pages()` and `frames()` discover live
documents. `select({pageId,frameId})` claims one current document. `snapshot()`,
`click({role,name})` and `fill({label,value})` use actual product controls. IDs are
ephemeral; rediscover them after a process restart or navigation.

Live participants launch through Playwright's owned browser server. Before any
join, their private marker records the actual child PID, executable and temporary
profile plus a unique browser argument. `close()` returns the marker and a fresh
process-absence observation after closing that owned server. Recovery may use
`inspectParticipantResources({ownedRoot, runId, signal})` to inspect fresh matching
processes and profile descendants; it never kills or reconnects to an old PID.
Missing launch identity, changed markers, unknown files and live matches remain
unresolved. This proves scoped browser-resource settlement only, not native
capture or account acceptance. Preserve marker files with the private run evidence.

`status()` returns the selected frame, current fixture hash, cloned track IDs and
live/enabled state, source offset, actual RMS, audio context clock, output clock
correlation and measured first-signal observation. The coordinator must inspect
the microphone-owning Zoom iframe before every start. `audioConnectedControl`
must identify the actually observed connected/unmuted control in that frame.
The participant checks its visibility before every live playback. This checks
the participant's local sending state; only captured/saved audio proves delivery.

`schedule({fixtureSha256,startAtEpochMs,restart:true})` starts an untouched source
once. Use a common monotonic epoch (`performance.timeOrigin + performance.now()`)
with a 50 ms–10 s lead, calibrated via `clockSample()` round trips. `pause()`
silences the source first. After the app actually resumes, `resume({startAtEpochMs})`
continues at the exact paused offset; natural completion cannot rewind.
Scheduling timestamps alone are **not** synchronization proof: compare the
first-signal/audio-clock receipts with fixture onset offsets, and independently
validate captured audio when testing multiple guest delivery.

`observeProduct` runs before each start/resume/load and must freshly read the
clinician product UI and native-backed recording state. It returns:

```js
{
  scope: 'product-ui', targetId, sessionId, observedAtEpochMs,
  consent: {sessionId, state: 'granted'},
  capture: {sessionId, state: 'recording', nativeState: 'recording', elapsedSeconds}
}
```

Observations older than two seconds, unrelated sessions, missing native state or
legacy `recordingObserved` flags fail. The coordinator is responsible for
observation provenance; inventing this object is not UI evidence. A fixture
`load(next)` requires an observed `saved`, `finished` or `idle` capture state and
stopped source. It keeps the same active microphone track, resets to offset zero
and silence, and clears session binding for the next visit. A newly created
document starts with the original launch fixture, silent; never assume a prior
frame's loaded fixture survives navigation.

Call `close()` during scoped cleanup. It stops sources and generated tracks in
all owned frames and closes only that participant's browser. The coordinator
must separately confirm Scribe stopped and saved before its own cleanup. No host
audio route, driver, microphone, installed Scribe or unrelated browser is changed.

## Explicit bot proof branch

The default participant proof is `{kind:'native'}` and retains the native checks
above. A future bot coordinator may explicitly pass
`captureProof:{kind:'zoom-bot',expected}`. `expected` pins the run UUID, collector
implementation SHA256, local run start, and the exact account/doctor/patient,
host, meeting, appointment and occurrence metadata listed in
`BotCaptureProofGate` in `bot-capture-proof.mjs`. A bot receipt never supplies a
fake native session or native recording state.

This increment is a typed contract and participant admission gate. It does not
provide a live provider collector, normal host UI locators, bot orchestration,
continuous state monitoring, or full journey acceptance. Contract tests use
synthetic DTOs; passing them is not live consent or recording evidence.

For this branch, `observeProduct({kind:'zoom-bot',requestNonce})` must execute a
fresh scoped read through the pinned collector and return the exact metadata
DTO accepted by the gate. The participant itself brackets that request with its
local clock. The whole request plus its remaining age must fit two seconds,
including a second check immediately before the browser schedules audio. A
slow Azure setup or delayed response cannot be made fresh by restamping it.
This is an engineering admission bound, not a measured capture latency or SLA.

Required observations are a normal host-consent action/artifact, provider
permission allowance followed by current `in_call_recording`, exactly one
actual recording with `started_at` and no `completed_at`, and matching Core
correspondence before and after the provider read. The collector must hash-check
the real UI artifacts, derive the recording from the exact bot's recording
list, verify the Recording's bot ID, and return no tokens, URLs or content.
Provider transition times remain separate from local receive times: an old
transition can still describe an ongoing recording when the GET is fresh.
Invalid/future timestamps and impossible permission/start/consumption/completion
chronology are refused with a provisional five-second cross-system clock-skew
margin. That margin is an engineering refusal rule, not measured clock precision;
the provider event list is never sorted to repair inconsistent observations.

Core writes the three recording-scoped owner keys before `recording.done`, but
after a best-effort disclosure send and in separate writes. Missing/partial
keys keep playback closed. The current official Start Recording response is a
Bot; Core's use of its top-level ID as a recording ID is a separate integration
prerequisite that must be verified/fixed. The proof never borrows a bot ID to
work around a missing recording mapping.

After admission, changed identity/history or an unsafe observation permanently
blocks source restart in that gate. A later fresh stop can still be proved.
`validate(observation,'stopped',{request,now})` additionally requires the same
previous recording, terminal bot status, completed recording, ended Core
meeting and exact completed release-intent rows. Missing Redis state is not
stop proof. A stopped gate cannot record again; bot fixture reload requires a
new participant. Source pause/resume controls are not evidence that the product
supports resuming a stopped bot recording.

Before a live bot run, implement and review the actual collector and normal host
UI adapter, validate the exact recording mapping, and perform a silent transport
rehearsal. A continuous monitor must close only owned sources on stale/unsafe
state. Before switching a shared host from A to B, independently confirm the
same bot stopped, settle owned resources, then use normal Disconnect and recheck
host ownership. The [Recall bot status](https://docs.recall.ai/docs/bot-status-change-events)
and [recording control](https://docs.recall.ai/docs/recording-control) contracts
distinguish joining, permission, active recording and stop. Exact API reads are
a bounded lab diagnostic; production lifecycle UX needs signed status events.
