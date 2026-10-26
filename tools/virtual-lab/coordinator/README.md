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

iOS observer access uses XCUITest's fresh `mobile: getContexts` metadata to
select exactly one page with the verified app bundle ID and local Capacitor
root URL. Hosted sign-in may retain a separate SafariViewService page. The
adapter does not select that page, cache a process ID, or choose by title.
After switching it checks the current root URL and Capacitor bridge before
reading or changing observers, including during cleanup. Missing metadata,
multiple matching app pages, changed page identity or failed restoration keep
the operation blocked. Native controls and the entire context transaction
remain serialized. This uses the detailed bundle metadata provided by the
lab's pinned XCUITest driver; older drivers without it are unsupported.

A fresh iOS run has a separate `initial_ui_readiness` setup phase after session
connection/restoration and before sign-in intent or input. XCUITest's first
`mobile: getContexts` call can initialize its remote inspector even with
`waitForWebviewMs:0`. Setup allows at most 30 seconds, retries only the exact
native-only response, and requires the same bundle/root selection, post-switch
bridge attestation and return to native context. It installs no observer and
calls no product method. Private `ios-webview-startup.*.json` receipts retain
actual Node wall/monotonic brackets, read durations/counts and sanitized outcome;
the successful journal event binds the receipt's canonical JSON hash.

Setup is attempted once in a fresh run, never during resume or pending-action
reconciliation. Later observer, input/capture and cleanup reads still discover
and attest afresh under their unchanged 1500ms discovery limit and enclosing
proof deadlines. Startup evidence does not grant capture readiness or get
re-stamped as a current observation. The 30-second automation waiting ceiling
does not change the 10-second cold-launch engineering goal: any cold-start
measurement must retain session connection and inspector setup time, including
failed setup. Setup receipts explicitly leave performance qualification
`NOT_ESTABLISHED`; they do not establish native timestamp precision or an SLA.
Timeout/cancellation retains the failed attempt, awaits owned cleanup and
preserves quarantine if context or resource settlement cannot be proven.

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

For a pending prepare with only one virtual microphone source, recovery accepts
an absent or empty participant directory after checking a fresh process inventory
for unaccounted marked children and rechecking the directory. Its native helper
writes ownership before launch and does not fork. This covers a permission wait
that failed before source initialization; it does not claim that recording ran.
Any marked process keeps recovery unresolved. Completed preparation, attempted
Record, browser sources, partial owner files and uncertain launch identities
retain the existing stricter checks. Changed tooling still requires a new run;
this does not retrofit old frozen journals or replay permission/Record actions.

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

iOS phase artifacts and settled cleanup also retain the passive timing history
before its observer is removed. These private, hash-bound `timing-*.json` files
contain only projected timing metadata and explicitly unqualified transport
estimates. Missing/older timing responses remain `NO_SAMPLES` or `UNAVAILABLE`;
diagnostic collection never changes a product assertion or delays uncertain
capture cleanup. A native journal must still be exported separately from the
verified owned process/container and joined to this history before reporting
native event intervals. Desktop timing and source synchronization are not
qualified by these iOS artifacts.

`UI_JOURNEY_PASS` proves only the executed UI assertions. Full readiness also
requires normal rebuilt-app two-account access/isolation, independent native
target under physical-host lock, each audio path, saved audible words, actual
speech/note output, recovery, synchronization, editing and staging dashboard
gates. Mock engine tests always return `MOCK_JOURNEY_PASS`; they can never
produce a live acceptance result. Unconfigured or unexecuted lanes stay
BLOCKED or NOT RUN.
# Zoom profile and authorization runner

`lab.sh zoom-doctor CONFIG OUTPUT`, `zoom-run CONFIG OUTPUT`, and
`zoom-resume CONFIG OUTPUT` use a separate bot journal. They do not invoke the
native journey, start a meeting, join a bot, emit audio, or qualify capture.
The first slice observes normal Settings, offers a bounded normal OAuth user
checkpoint, and can authorize one future Schedule meeting through its actual
appointment picker. `AUTHORIZATION_OBSERVED` means the UI and exact response
agree; recording, transcription, note quality and playback remain `NOT_RUN`.
The inspected bot note viewer has no manual Save or saved-audio control, so
those capabilities are reported `NOT_AVAILABLE`, never inferred from native
Scribe. The dedicated bot-note projector binds a doctor, appointment, note and
AI transcript; it cannot accept a native session receipt.

The private JSON configuration requires `schema:1`, `syntheticOnly:true`,
`executionKind:"live"`, UUID `runId`, `account` A/B, actual `doctorRef`,
`identitySHA256` (SHA256 of the normal Clerk user ID), actual `hostId`,
`action` profile/connect/authorize, staging `apiOrigin`, absolute
`playwrightPath`, and a private normal `storageState` file with its exact
`storageStateSHA256`. No testing token, API token, cookie override or password
is accepted. Supply explicit `uiTimeoutMs` ≤30000, `oauthTimeoutMs` ≤120000,
and `collectorTimeoutMs` ≤240000. `collector` pins an absolute `executable`
and `script` with `executableSHA256` and `scriptSHA256`.

The read-only collector accepts a bounded stdin request with `version:1`,
`runId`, fresh `requestNonce`, account, hostId and doctorRef. It must return the
`live-staging-zoom-bot-observation` schema validated in zoom-bot-evidence.mjs,
including actual profile identity, exact host-owner counts, integration counts,
deployment identity and its collection bracket. A host already bound to another
doctor is refused. The collector's scoped source query and deployment check
must be pinned inside its script. Its ≤120s observation-age allowance and ±5s
wall-clock skew allowance are engineering bounds, not measured clock precision.
Immediate normal Clerk and inactive view-as checks precede the UI mutation.
The same nonce-bound host/synthetic-scope observation is revalidated immediately
before authorization. Its expiry is passed to the UI and checked after the
dialog wait and at the exact POST; expiration blocks the request without a
collector requery or another authorization attempt. A Settings/ViewAs request
or main-frame navigation invalidates the browser mutation permit immediately;
the POST also checks the captured response/navigation generations and the
unchanged 15-second identity freshness limit.

For action authorize, also supply exact `authorization` keys: `meetingId`
(numeric Zoom ID), `meetingRecordRef` (zmtg), `appointmentRef`, and explicitly
preauthorized `allowedAppointmentRefs` / `allowedPatientRefs`. The collector
must return complete bounded inventories for this exact synthetic doctor;
every returned hash must belong to these sets. Unknown rows block the broad
doctor-scoped picker requests. Native capture bindings, another linked meeting,
missing note schemas, a foreign appointment and an already-started meeting all
block new authorization. No mocked or filtered network response is supplied.

Each mutation intent is fsynced before its normal UI click. Resume verifies
configuration, tooling and every observation hash, inspects fresh owned browser
process absence, and reconciles Settings/Schedule plus the collector. It never
replays an uncertain Connect or authorization intent. A bounded OAuth timeout
closes the owned browser and reports `OAUTH_INCOMPLETE_BROWSER_CLOSED` (or
`OAUTH_INCOMPLETE_CLEANUP_UNCONFIRMED` if its closure cannot be proved). This is
not browser-session resumption: `zoom-resume` only checks whether a separately
completed normal OAuth connection now exists. An unconnected account needs a
separate explicit normal OAuth action through its normal Settings UI, or a new
authorized run after ownership settlement; the existing pending intent is never
replayed. Unresolved authorization needs explicit normal UI inspection. Changing tooling/configuration requires a new run after
owned-resource settlement. The per-host mutex is shared across output paths;
dead-owner recovery is allowed only for the exact same run. Missing process
identity or uncertain collector transport retains the guard. Never delete it
blindly or act on an old PID.

Use A and B sequentially. Keep an existing unrelated Zoom connection intact.
If only one test Zoom host is available, finish and independently verify its
actual bot stop before normal disconnection and the other account's connection.
Disconnect is not a stop command. Browser cleanup closes only owned control
resources and does not imply a bot or native recorder stopped. Mock tests are
explicitly classified; the CLI accepts live configurations only.
