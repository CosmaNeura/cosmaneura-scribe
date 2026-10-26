# Prospective native action measurements

`native-performance.mjs` is an opt-in lab adapter for one normal iOS Record or
Resume action. It is not installed automatically by the coordinator, changes no
product code, and grants no capture, consent, source, UI or recovery authority.
Use it only in a separately reviewed run with the existing target lease, native
and account guards, source custody checks, and unchanged normal action. The
current built client needs the existing native timing journal and reply fields.

The declared Record/Resume budget is four seconds, taken from
`NATIVE_PERFORMANCE_BUDGETS_NS`. These are prospectively reviewed engineering
budgets, not user-agreed SLAs. Cold launch, warm launch, workspace and preparation
values in that constant are **not measured by this adapter**. A previous run or
a clock-only calibration cannot become a prospective action measurement.

## Integration contract

The calling reviewed operator creates the existing owned kernel clock collector,
pins its helper and current native process, and closes the collector in `finally`.
It supplies `exportJournal` as a closure over `exportOwnedIOSNativeJournal` with
the same frozen config/scenario, exact current PID/start/executable, admission
run UUID and `clock.launchReceipt`. No process is launched by the journal reader.

```js
const { result, receipt, retention } = await collectNativePerformanceAction({
  ui, phase: 'record', clock, signal, evidencePath,
  exportJournal: options => exportOwnedIOSNativeJournal({
    config: ui.config, scenario: ui.scenario, expectedProcess,
    clockIdentity: clock.launchReceipt, runId: ui.binding.runId, ...options,
  }),
  invoke: () => ui.perform('record', ui.scenario, signal),
});
```

The callback executes exactly the already-authorized normal action. The wrapper
does not retry it. For Resume, preserve the existing normal Resume steps and
assertions, then return `ui.observe('record', signal)` so the current native
Recording proof is present. This does not authorize a new standalone Resume or
replace the source group's pause/resume safety contract. Exactly one configured
click and one successful Recording assertion batch must be observed. The exact
configured locator must first resolve through the unchanged Appium `find`
method. Other input, duplicate input, unresolved targets, method/plan changes or
late replies make timing unqualified. Original method promises are returned
unchanged; methods are restored only while still owned by this observer.

The wrapper reads the existing passive admission observer and fixed journal;
it adds no native product request, permission request, recording command or
audio. Each whole-bundle journal export has its own 30-second deadline, outside
the measured click interval and outside the separate two-second source custody
proof. Export/diagnostic work may consume resources; concurrent load must still
be recorded in a performance run. The normal action retains its existing caller
deadline. The wrapper does not subtract driver, artifact or tool delays.

`evidencePath` must be a new `performance-record-<UUID>.json` or
`performance-resume-<UUID>.json` directly inside the current private canonical
`ui.output`. At most 1 MiB is published using the existing exclusive, fsynced
file/directory writer. Existing evidence is never overwritten. A rejected
normal action is rethrown unchanged after evidence retention is attempted,
including when collection or retention also fails. A successful normal action
with incomplete measurements returns an explicitly unqualified receipt. A
retention failure throws without replay or releasing any native guard. The
caller remains responsible for normal cleanup/recovery and child cleanup.

## Attribution and bounds

The journal reader verifies the owned marker, complete installed bundle, native
PID/start/executable/UID, hardware hash, boot session and Node parent identity
before and after reading only the current simulator's fixed
`Library/Caches/scribe-capture-startup-v1.json`. The regular file must be owned,
private, canonical and at most 32 KiB. Nonblocking/no-follow open plus stable
inode/size/mtime checks reject FIFOs, symlinks and concurrent replacement. A
missing baseline is explicit; a missing post-action journal never qualifies.
This is local process/file evidence, not a cryptographic product attestation.
Darwin process inspection puts the executable path in the final `ps` column:
otherwise `comm` is truncated even with `-ww`. UID and start time remain exact.

The normal recorder reply must change from ready (Record) or paused (Resume) to
Recording with the same run/workspace/appointment/session/recorder/auth revision,
a newer native revision, exactly one new capture attempt, positive captured
frames and input/converted buffers, and unmuted input. The required previous
native sample and that exact Recording reply must remain in the passive ring.
The prior normal admission's consent ID, request IDs and auth revision are
retained and bound to that same session; an admission change refuses timing.
The new native attempt's `startRequested` and required readiness endpoints must
remain in the journal, ordered, inside the new clock window, with zero observed
queue/admission drops. The complete mapped `startRequested` interval must be at
or after the observed click invocation; a start before that click or overlapping
it within clock uncertainty refuses attribution. A new attempt after the
baseline alone is insufficient. Changed process/build/boot, skipped attempts, discarded
replies, missing anchors or missing endpoints refuse qualification.

The native ring is 128 events/32 KiB. Its drop counter counts admission-budget
and pending-queue rejections; it does **not** count ring eviction or file-write
failures. The receipt states this limitation and retains both observer counters.
Required endpoint retention supports the measured intervals; whole-journal
completeness remains UNKNOWN. No dropped or evicted event is reconstructed.

The start boundary is the Node monotonic timestamp immediately around the raw
Appium adapter click invocation. It includes WebDriver/WDA transport and is not
a physical-touch timestamp or a browser paint timestamp. Native Dispatch uptime
is mapped using the collector's fresh common-kernel before/after samples and
outward interval bounds. The primary budget ends at `readyAccepted`, supported
by actual input and converted buffers. Command round trip and completion of
normal visible UI assertions are reported separately.

`firstPacketPersistenceStarted` and `firstPacketPersistenceCompleted` are
reported only if present in the retained window; they have no invented
four-second budget. Missing packet evidence stays NOT_OBSERVED and requires a
later prospectively bracketed collection if that gate is needed. Callback or
packet persistence does not establish acoustic arrival or saved-audio content.

Evidence includes the original metadata journal bytes/hash, projected normal
history, action/plan hashes, projected Recording proof, clock launch receipt,
raw clock samples and selected sample nonces. Actual UI values are omitted;
assertion-match booleans and the existing phase artifact hash link the normal
UI evidence. Independent analysis reprojects the selected raw clock samples
with `projectKernelClockSample`/`boundKernelClockWindow`, then calls
`analyzeNativePerformanceEvidence`. Its result is only
SUPPLIED_EVIDENCE_CONSISTENCY_ONLY. JSON or cloned exports cannot impersonate the
same-process live export/action brands. Browser precision stays UNKNOWN,
acoustic arrival stays NOT_MEASURED and full workflow acceptance stays
NOT_ESTABLISHED in every result.

## Validation and recovery

Run the new unit/HTTP/lifecycle tests with Node 24 and
`--experimental-test-module-mocks`. The lifecycle test process mocks only the
Darwin export brand to exercise failure cleanup; it never produces qualified
timing. HTTP fixtures listen only on an ephemeral local loopback port. No test
contacts a real Appium session, simulator, staging service, microphone or helper.

Rollback is to omit this opt-in wrapper in the next reviewed runtime. Keep all
existing failed receipts, native journals, leases and product data. This change
contains no client installation, current-run reinterpretation or fault injection.
Live action measurement and Darwin journal-export factory execution remain
NOT_RUN until separately exercised on a guarded owned target.
