# Dormant iOS PCM capture core

This standalone Swift package owns the bounded state machine for a future iOS
microphone bridge. It is not linked from Capacitor, the app Xcode project, or
the capture-source factory, so adding the package does not select or activate
native capture.

The core accepts transferred floating-point channel buffers, downmixes by
deterministic channel averaging, applies the same `area-weighted-v1` streaming
rule as the web capture client, and emits 16-kHz mono PCM16 little-endian bytes.
It allows at most one emitted packet awaiting acknowledgement plus one fixed
accumulator. Overflow and lifecycle loss terminate capture with fixed codes and
discard buffered audio.

`start` returns a session handle synchronously. Permission and audio readiness
are separately awaitable and cancellable. A successful drain freezes input,
waits for accepted full packets, and transfers at most one final partial packet.
A successful discard returns no packet. Failed freeze/release keeps ownership
and blocks another session until the same handle successfully retries stop.
Discard permanently supersedes drain, including during an in-flight close.
Readiness races cancellation locally, while driver `freezeInput` must also
invalidate a non-cooperative or late native start. Once release succeeds, stop
resolves; processing failures are reported through the fixed termination sink.

Frame admission is synchronous. A driver may own only one accepted receipt and
must await `waitUntilConsumed()` before offering another buffer. A concurrent
offer is cleared, rejected, and terminates the session as bounded overflow.

## Zeroization boundary

The core explicitly clears every mutable input, resampler output, accumulator,
full emitted packet, discarded partial, and retained final packet it owns. The
caller owns and must clear a successfully returned drain packet. Swift/OS
allocator copies, `AVAudioPCMBuffer` and other Apple/framework-managed storage,
and future Capacitor JSON/Base64 copies cannot be proven zeroized. That is an
open activation risk, not a property this dormant package claims to solve.

## Deliberate deferrals

The live `AVAudioEngine`/`AVAudioSession` driver exists only as the dormant,
unlinked target described below. There is no Capacitor plugin, app dependency,
permission plist entry, background entitlement, runtime selection, signing,
TestFlight, deployment, or activation. The driver still requires independent
review and physical-device lifecycle evidence before any integration.

Run deterministic tests with:

```sh
swift test --package-path apps/capture/native-plugins/ios-pcm-capture
```

## Dormant AVFoundation driver

`CosmaneuraIOSAVFoundationDriver` is a separate, unlinked target containing a
live foreground iOS adapter. It configures `playAndRecord`/`voiceChat` with the
speaker and Bluetooth hands-free routes, copies bounded Float32 tap buffers
into core-owned frames, and delegates downmixing, resampling, packetization,
and watchdog shutdown to `CosmaneuraIOSPCMCore`.

The driver suppresses category-change notifications created by its own setup,
but fails startup on genuine lifecycle/media loss and maps active interruption,
route, media-services, background, permission-revocation, and engine failures
to fixed core events. One accepted frame may await consumption; the next tap
fails closed instead of queueing audio.

This target is not linked into an app and adds no permission description,
background mode, entitlement, Capacitor plugin, runtime selection, or
distribution configuration. Simulator tests cannot validate microphone
routing, Voice Chat signal processing, interruptions, Bluetooth behavior,
permission UI, or audio session restoration. Those require separately
authorized physical-device tests.

## Dormant bridge core

`CosmaneuraIOSPCMBridgeCore` composes the core and driver behind a future
Capacitor-friendly opaque session-token registry. It is also an unlinked Swift
package product: no app target or capture factory imports it.

The bridge owns one mutable byte packet awaiting explicit acknowledgement.
Replay republishes that same packet without another audio copy, and a delivery
lease prevents acknowledgement or retirement from clearing it while the event
publisher is reading. Failed close keeps the token retryable; a successful
automatic terminal close leaves one metadata-only tombstone so the TypeScript
layer's following stop is idempotent. Start and lifecycle codes mirror the
dormant TypeScript contract. Registry and stop failures stay bounded and are
for a future wrapper to reject without native detail. The bridge performs no
logging.

This layer deliberately transports mutable bytes rather than creating an
immutable Base64 string. The future Capacitor wrapper will own that conversion
and its cleanup; WebKit/JavaScript copies and Apple-managed audio buffers remain
activation risks until physical-device and wrapper evidence exists.
