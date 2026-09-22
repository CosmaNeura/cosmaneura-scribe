# Native macOS meeting audio source

Source preparation for the standalone desktop workflow. This package has no
external dependency and uses ScreenCaptureKit plus AVFoundation on macOS 14.2+.
It is not mounted in Electron, signed, installed or enabled. It does not replace
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
rates/channels and a common host-clock timestamp. It copies bounded float PCM from
AVFoundation/CoreMedia buffers and retains interleaved order. This increment does
not align clocks over a long recording, mix/downsample audio, encode WAV, encrypt
or upload it. Those main-process connections to the existing Scribe/Core flow are
the next work; sending raw frames to the provider renderer is not an alternative.

Both sources enter one serial native delivery queue, limited to four admitted
frames of at most 8,192 samples per channel and two channels. Overflow, repeated
source timestamps, invalid samples or sink rejection closes input and reports one
fixed failure code. The sink consumes/copies during `receive`; application-owned
samples are cleared afterward, on rejection and during drain. Framework-owned
buffers are outside this zeroization claim. No audio, errors containing OS data,
window titles, URLs, filesystem path or credential is logged.

Device/engine changes, a stream failure, workstation lock, sleep or capture-window
expiry terminate input. Ordinary application focus loss does not stop desktop
telehealth capture. Stop freezes delivery, stops the microphone, waits for a
pending ScreenCaptureKit start, stops that stream and drains queued input. A
failed stop retains its native handles. Concurrent cleanup shares its attempt;
an older failed waiter cannot overwrite a newer retry. The owner must retain this
actor until shutdown is confirmed; dropping it is not a termination proof.

Ten local Swift checks cover bounded native delivery, rejection/clearing,
timestamps, actual in-memory AVFoundation conversion and disabled/pre-stopped
source refusal. They use explicit invented consent and generated samples. The
complete source compiles with Swift 6 and warnings as errors for macOS 14.2.
No enabled OS source, permission prompt, physical microphone or meeting was used.
Native asynchronous start/stop failure injection and physical lifecycle behavior
remain unqualified, along with mixing, clock drift, echo, silence/gap handling,
encrypted recovery, main-process hosting, Windows and release packaging.

See [ADR 0054](../../../../docs/adr/0054-native-macos-meeting-audio-source.md).
