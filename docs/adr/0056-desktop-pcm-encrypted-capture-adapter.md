# ADR 0056 — Connect desktop PCM to the existing encrypted recorder

Date: 2026-09-22

Status: local main-process source integration; native transport/host uninstalled

## Provider outcome and decision

Desktop mixed PCM must reach the existing reservation, WAV, encryption, recovery
and configured review flow without exposing audio to the renderer. Add
`DesktopPcmCaptureSource`, consumed by `CaptureFlowController` in the trusted
Node/Electron main process. Its fixed `mixed` channel retains version-3 recovery
semantics. No second encryption, upload, transcription or note engine is added.

Extract the existing iOS source lifecycle into `NativePcmCaptureSource` and a
platform-neutral bridge. `IosNativeMicrophoneCaptureSource` keeps the same public
constructor, with a small adapter preserving foreground checks, native error
mapping, discard behavior and the existing Capacitor bridge. Native Swift,
authentication/token and storage implementations are unchanged. The original
source-reuse manifest remains historical evidence, not the refactored file hash.

The shared lifecycle still owns synchronous native-handle acquisition, startup
cancellation, one-packet acknowledgement, failed-stop handle retention, discard
upgrades and final partial WAV delivery. Desktop alone opts into accepted full
packet delivery during normal stop. An optional activation handshake holds
desktop delivery until the source is ready; synchronous activation failure cannot
report successful startup. iOS does not enable either desktop option.

`DesktopPCMDriver` is a trusted Swift-to-main transport contract, not a renderer
API or native transport implementation. Its owner must hold the existing
controller's fresh capability, consent, selection, lease and native indicator.
It must return ownership before startup waits, support discard during pending
drain and retain the same handle after failed stop. The current renderer IPC and
`capture-authority.ts` are unchanged.

The adapter validates sequential frame offsets and complete owned buffers of at
most 4,096 PCM frames. It joins packets with the existing chunker and
capability-derived limits, then uses the existing canonical WAV encoder. It
awaits encrypted persistence before acknowledging native input. PCM/WAV buffers
clear after consumption or failure. Construction refuses a browser/renderer;
there is no audio-returning renderer method.

The host must supply a durable coverage writer. Common-start metadata is
validated/retained before native activation. Completion must match that start,
received frame count and exact 16 kHz duration; unmatched tails stay explicit.
The final partial chunk requires confirmed normal stop and coverage retention.
Failed stop retains the driver; retry discards uncertain partial audio. This
increment introduces no deployed storage profile.

## Risk, flight plan and verification

Tier 2: native ownership/shutdown and encrypted capture. Continue ADRs 0054/0055's
local invented-data flight plan. Keep the adapter unmounted until native
transport, main-process storage and host authority are composed. Recovery leaves
the source unselected. No installed app, service, environment, schema, Core/OS
checkout or permission setting is changed.

Evidence root:
`/Users/jw/Desktop/Cosmas/scribe-desktop-encrypted-capture-20260922.uS0Pdu/`.

Eleven checks pass in `desktop-tests-current.log`: common-start retention,
joining/full/partial drain, backpressure, malformed input, stop retry, successful
discard after failed drain, cancelled startup, synchronous activation failure,
renderer refusal and inconsistent coverage. All 47 unchanged iOS source/Capacitor
checks pass in `ios-regression-current.log`. Both affected workspaces typecheck
and affected source lint passes.

The desktop integration check runs the real flow controller, AES-GCM envelope,
encrypted store/queue implementations and HTTP upload/registration/completion
transport in Node. An invented-consent local BFF supplies the protocol; IndexedDB
is an isolated in-memory fixture. A generated RSA key wraps the session DEK. The
check unwraps/decrypts the retained envelope and confirms every WAV sample,
reopens mixed-channel state without starting another source, uploads once and
reaches configured processing with the expected final sequence. This is not live
Core authorization, native hardware or operating-system durability.

The first loopback attempt was denied by the tool sandbox. The focused fixture
then passed with loopback access, followed by the current complete desktop test
file. The initial failure log is retained. The test server closed in cleanup.
No live service, physical source, permission prompt, Keychain access or completed
phone/Speech/translation trial was used.

## Next integration boundary

Bind the actual `ScribeDesktopAudio` transport to this driver, then compose the
main-process provider recorder and creator-scoped durable stores. Connect
metadata/commands to the provider UI, keeping raw audio, keys and upload
credentials outside the renderer. The host must show startup until common start
is accepted and expose incomplete coverage in the outcome; the shared flow's
internal recording state alone is not native-start proof.

Native timeout/emergency termination, permission/selection UI, indicator,
physical Meet/Zoom, offline/interruption behavior, actual store custody and full
authenticated Core acceptance remain open. There is no installed desktop
consumer. Standalone identity, both app packages and signed distribution remain
unfinished beta gates.
