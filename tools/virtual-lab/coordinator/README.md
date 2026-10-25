# Resumable synthetic UI coordinator

The coordinator drives product UI through an owned Appium target and controls
isolated Zoom browser participants. Normal hosted browser authentication uses
the displayed email/password → another method → email-code flow, with Clerk's
reserved synthetic test addresses. It uses no Clerk testing helpers or injected
tokens. Core membership is checked separately: a successful login is not access.

```sh
export SCRIBE_LAB_ROOT=/absolute/owned/lab
bash tools/virtual-lab/lab.sh auth-normal "$SCRIBE_LAB_ROOT/new-auth-run"
bash tools/virtual-lab/lab.sh coordinator-test
bash tools/virtual-lab/lab.sh doctor scenario.json native.json /absolute/new-run
bash tools/virtual-lab/lab.sh run scenario.json native.json /absolute/new-run
bash tools/virtual-lab/lab.sh resume scenario.json native.json /absolute/new-run
bash tools/virtual-lab/lab.sh matrix matrix.json /absolute/new-matrix
bash tools/virtual-lab/lab.sh matrix-resume matrix.json /absolute/new-matrix
```

`scenario.json` contains schema 1, a unique `runId`, `syntheticOnly:true`,
`mode:fixed|adaptive`, `executionKind:live`, target ID, exact source SHA,
`build:{bundleId,number,sha256}`, fixture SHA and at least two distinct persona
IDs/profile directories. Adaptive input additionally requires a ground-truth
SHA frozen before playback. This freezes generated utterances for comparison;
it does not claim that an adaptive conversation generator has run.

The native file extends the guarded native-lab configuration with `targetId`,
`journey`, `sourceReaders` and optional `sources`. Every journey phase has
actual observed WebDriver `actions` and nonempty `assertions`. Assertions use
an exact locator, `kind:text|attribute|visible`, optional attribute and expected
value. A locator's existence is insufficient to prove consent, recording or a
selected audio route. Build receipt, native target marker and live selected
input must agree. Unresolved `REPLACE_` configurations fail doctor.

Phases are sign-in, workspace, create visit, preparation, consent, Record,
source playback, Finish, review, save, reopen and dashboard. The native product
has separate Mac and iOS accessibility trees; inspect the actual rebuilt target
before binding locators. Configuring a generic button sequence is not acceptance.
The adapter observes consent/session IDs from normal native admission responses.
`sourceReaders` bind the visible Recording status and elapsed timer; both must
agree with fresh native recorder metadata. A checked checkbox alone cannot
manufacture consent. Finish checks the same recorder immediately before clicking
and retains its first physical-stop observation. Save checks the current source
session before editing; save/reopen require the normal Core note/version tuple.

`dashboard` config pins a private normal hosted session store and expected Clerk
identity. It verifies the exact saved appointment, note, transcript and ordered
content hash through the normal page, then reloads it. Broad patient lists are
blocked. The matrix validates both account configurations before starting either,
runs their native journeys sequentially, then checks bilateral access denial
using actual 403/404 responses. UI/network failures are not isolation evidence.
The dashboard currently has no saved audio player, so native audible playback
remains a separate required gate.

`sources` provides the portable fixture registry configuration, pinned fixture
case/file for each participant, an environment key for a fresh Zoom URL, actual
join UI steps and the observed sending-audio control. A combined `visit.wav`
cannot play alongside role tracks. The current live microphone-owning iframe is
rediscovered before playback. Every source start checks fresh consent/Recording,
fixture bytes and a requested live synthetic stream. All contexts start silent.
Source timestamps measure the generated WebAudio graph, not captured/native audio.

The target lease prevents competing native drivers. The journal writes the
pending action atomically before clicking. Resume checks that action's result
in the actual UI; it never blindly repeats Create, Record, Finish or Save.
An ambiguous source-process loss requires capture review, not a rewind. A
changed scenario/build/tool implementation or damaged event hash chain blocks
resume. `implementationReceipt()` hashes the exact maintained runtime modules;
the journal, matrix and target lease bind that digest. Restore the reviewed
original tooling for same-run recovery when those files change, then start a
new run for changed tooling. Test files, docs and modification times do not
affect the digest.

Failures save private screenshots plus metadata-only receipts. Cleanup closes
only owned participant browser processes and the newly created Appium session,
with native no-reset/no-terminate capabilities. An uncertain recorder stays
alive. Standalone recovery accepts only the exact run/tool/output identity and
fresh read-only native observations. `adapter.recoveryInspect({scenario, state,
observations, output, signal})` receives the canonical output directory; derive
participant ownership from `resolve(output, 'participants')`. Never trust a
historical process or tab ID as authority to command it. `recoveryCleanup` closes
only freshly acquired control handles. Actual active captures retain quarantine.
Once Record has been attempted, ordinary engine cleanup follows the same rule:
`ownedResourcesSettled` does not imply the capture stopped. A fresh
`nativeCaptureProof` must match the admitted session, current visit, stopped
native phase and empty pending-work count. A deliberate PAUSED run remains
resumable with its lease retained; an existing failure keeps its original cause.
A completed live journey also needs its recorded matching Finish observation.

A complete same-run acquiring guard can be recovered only after every owner in
its append-only claim chain is proven dead on this host. Exclusive file creation
admits one successor; an atomic move releases only that successor's own guard.
Live, unbound, partial and foreign guards remain blocked. No automatic takeover,
system audio defaults or host security changes are part of recovery.

Appium session creation has a 180-second transport deadline; cleanup/resume
allow 240 seconds per recovery operation for startup plus inspection. These are
automation waiting limits, not product performance budgets. After dispatch,
parent cancellation prevents further UI work but preserves the tracked creation
reply for cleanup. Private `appium-session-attempts` receipts bind a generated
`scribe:creationAttempt` capability to the exact run, tool, output, target,
journal and owner process. Recovery can close a freshly discovered matching
orphan only under the same-run lease/guard, after its owner is dead and while
the journal remains unchanged. Empty inventory, missing capability echoes,
unrelated sessions or later product actions preserve quarantine. Old saved
session IDs alone never authorize a command. Frozen earlier runtimes remain
necessary for their original hash-bound runs.

Fixed provisional engineering budgets, declared before performance runs:
cold launch 10 s, warm launch 3 s, workspace 10 s, preparation 15 s and Record
readiness 3 s. These target short interactive feedback while allowing bounded
initial network work. The historical 4185.9 ms Record sample is not a current
baseline; the 3 s target demands improvement but must be compared with a valid
current baseline. These are engineering goals, not user-agreed SLAs. Keep
native acknowledgment, first usable audio, UI state and operator/tool waits
separate; a command duration cannot satisfy a native latency gate.

`UI_JOURNEY_PASS` proves only the executed UI assertions. Full readiness also
requires normal rebuilt-app two-account access/isolation, independent native
target under physical-host lock, each audio path, saved audible words, actual
speech/note output, recovery, synchronization, editing and staging dashboard
gates. Mock engine tests always return `MOCK_JOURNEY_PASS`; they can never
produce a live acceptance result. Unconfigured or unexecuted lanes stay
BLOCKED or NOT RUN.
