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

## Zeroization boundary

The core explicitly clears every mutable input, resampler output, accumulator,
full emitted packet, discarded partial, and retained final packet it owns. The
caller owns and must clear a successfully returned drain packet. Swift/OS
allocator copies, `AVAudioPCMBuffer` and other Apple/framework-managed storage,
and future Capacitor JSON/Base64 copies cannot be proven zeroized. That is an
open activation risk, not a property this dormant package claims to solve.

## Deliberate deferrals

There is no `AVAudioEngine`/`AVAudioSession` driver, Capacitor plugin, permission
plist entry, background entitlement, runtime selection, signing, TestFlight,
deployment, or activation in this packet. A live driver must implement the
injected cancellation/freeze/release and acknowledgement contracts, undergo
physical-device lifecycle testing, and receive a separate Tier-2 review.

Run deterministic tests with:

```sh
swift test --package-path apps/capture/native-plugins/ios-pcm-capture
```
