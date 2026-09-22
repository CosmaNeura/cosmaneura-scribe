# Native macOS meeting audio source

Source preparation for the standalone desktop workflow. This package has no
external dependency and uses ScreenCaptureKit plus AVFoundation on macOS 14.2+.
It now builds a dedicated helper, but is not mounted in Electron, release-signed,
installed or enabled. It does not replace
the existing desktop authority, recording indicator or source lease.

`MacMeetingAudio` defaults to disabled. Its trusted main-process owner must:

1. Present and retain the explicit user-selected Chrome/Zoom window, process and
   capture extent. Obtain microphone/screen permission through a deliberate native
   action; this package only checks existing permission and never prompts.
2. Reuse the existing controller's fresh creator/consent/session/source authority,
   one-time capability and single-recording lease. Confirm the persistent native
   indicator before calling `start`. Keep raw audio outside the renderer.
3. Supply a sink ready for authorized input before start, including partial input
   during OS startup. Derive `maximumDurationSeconds` from the approved Core capture
   window; the native 24-hour numeric ceiling grants no authority. The timer starts
   before either source. This one-window producer never renews or restarts itself.
4. On any failure, retain encrypted accepted work, stop/reconcile the session and
   keep the controller's failure indicator/lease until shutdown is confirmed.
   Bound native operations using the existing 15-second lifecycle deadline. A
   timeout is not proof of an OS stop. Retry the same handle; use the reviewed
   emergency termination path if shutdown cannot be confirmed.

Before capture, the source re-resolves the selected window against its current
PID and exact `com.google.Chrome` or `us.zoom.xos` bundle identity. It never picks
the first window, uses a title as authority or accepts a caller-supplied URL.
Only the `.audio` stream output is registered. No screen frame is delivered or
written. ScreenCaptureKit still requires its system screen-capture permission.

**Window selection does not prove tab-specific audio isolation.** In particular,
Chrome audio may include other tabs/windows. The eventual native selection UI
must disclose the actual capture extent, and physical qualification must verify
it before activation. Do not label this implementation as meeting-only or
tab-isolated based on its window filter. App/window selection and one active
meeting still require the existing controller's deliberate start/consent flow.

The producer emits microphone and system audio separately, with their original
rates/channels, common host-clock timestamps and source sample positions. It
copies bounded float PCM from AVFoundation/CoreMedia buffers and retains
interleaved order. `AlignedMeetingPCM` now accepts those frames and emits mixed
16 kHz mono PCM16 packets. The main-process adapter reuses WAV/encryption/upload;
durable host integration remains open. Raw frames never enter renderer IPC.

The trusted host constructs the mixer with the Core-derived output-frame bound,
then passes it as `MacMeetingAudio.start`'s sink. Its PCM sink must be ready for
authorized input. `DesktopPCMSink.started` reports the first interval covered by
both sources; keep the UI in starting state until that boundary is accepted.
Adjacent host anchors determine each source's actual sampling interval, with
exact source-position continuity checked before mixing. Stereo channels and then
the two sources are averaged. A missing source/sample, clock jump or format
change fails; no silence or alternate source is invented.

On a deliberate normal stop, await `source.stop(mode: .drain)` and only then call
`mixer.finish()`. Finish returns the actual covered end and unmatched tail lengths.
Preserve/expose incomplete coverage in the host outcome. Startup pre-roll is also
explicit. The final pending frame uses the last observed clock slope. For an
interruption, failed source or abort, use the default discard stop and
`mixer.discard()`; retain already encrypted work for the existing recovery flow.
An OS stop timeout is not permission to finish or release the source handle.

PCM packets have sequential frame offsets and at most 4,096 samples. Their
synchronous consumer must copy/encrypt within the callback and must not wait for
network I/O. Packets clear after consumption/rejection. Each input track retains
at most four resolved frames plus one pending frame. `host-aligned-area-v1` has
its own exact-rational clock goldens; it does not change the existing nominal-rate
resampler or assert identical bytes when measured clock anchors differ.

Both sources enter one serial native delivery queue, limited to four admitted
frames of at most 8,192 samples per channel and two channels. Overflow, repeated
source timestamps, invalid samples or sink rejection closes input and reports one
fixed failure code. The sink consumes/copies during `receive`; application-owned
samples are cleared afterward, on rejection and during drain. Framework-owned
buffers are outside this zeroization claim. No audio, errors containing OS data,
window titles, URLs, filesystem path or credential is logged.

Device/engine changes, a stream failure, workstation lock, sleep or capture-window
expiry terminate input. Ordinary application focus loss does not stop desktop
telehealth capture. Stop closes delivery admission, stops the microphone, waits for a
pending ScreenCaptureKit start, stops that stream and drains queued input. A
failed stop retains its native handles. Concurrent cleanup shares its attempt;
an older failed waiter cannot overwrite a newer retry. The owner must retain this
actor until shutdown is confirmed; dropping it is not a termination proof.

Twenty-six local Swift checks cover bounded native delivery, rejection/clearing,
normal/failing stop drain, actual in-memory AVFoundation conversion,
disabled/pre-stopped source refusal, aligned mixed PCM, clock drift, gaps,
waveform timing, output limits, final partial periods and bounded private-pipe
command/packet handling. Two golden cases also
pass the independent `scripts/check-desktop-mixer-golden.py` rational reference.
They use explicit invented consent and generated samples. The
complete source compiles with Swift 6 and warnings as errors for macOS 14.2.
No enabled OS source, permission prompt, physical microphone or meeting was used.
Operating-system asynchronous start/stop failure injection and physical lifecycle behavior
remain unqualified, along with physical long-session clock drift, source silence
behavior, echo, encrypted recovery, main-process hosting, Windows and release
packaging. A TypeScript main-process adapter now joins the driver contract's PCM
packets into the existing WAV/encrypted capture flow (ADR 0056), tested with
explicit native/BFF/storage fixtures. The actual Swift-to-main transport now uses
a dedicated helper and the Node `NativeProcessPCMDriver`; the durable provider
host remains unbound. No installed UI consumes this source yet. See ADR 0057 for
inherited-pipe bounds, startup/packet acknowledgement, failed-stop retry and
parent-loss exit behavior.

See [ADR 0054](../../../../docs/adr/0054-native-macos-meeting-audio-source.md) and
[ADR 0055](../../../../docs/adr/0055-host-clock-aligned-desktop-pcm.md).
