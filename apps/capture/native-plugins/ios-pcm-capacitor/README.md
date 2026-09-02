# Dormant iOS PCM Capacitor transport

This package is a thin, iOS-only Capacitor transport over the reviewed
`CosmaneuraIOSPCMBridgeCore` package. It is deliberately absent from the capture app's dependencies,
`CapApp-SPM`, native registration, and runtime factory. Nothing can select or execute it in an app.

## Contract

The plugin name is `IOSPCM`; its one event is `iosNativePcmEvent`. Callers must install and await the
event listener before `start`, retain the returned opaque `sessionToken`, and call methods only for
that token:

- `getAppState()` returns `foreground` or `background`. The TypeScript owner must reject a
  background start before calling `start`; a later foreground race during AVFoundation startup is
  intentionally reported by the reviewed core as `ios_capture_start_failed`.
- `start(configuration)` validates exact mono 16 kHz signed little-endian PCM plus bounded positive
  chunk values and returns the token before permission or audio readiness waits.
- `ready({ sessionToken })` settles startup. `heartbeat({ sessionToken })` advances the explicit
  liveness contract.
- `stop({ sessionToken, mode })` preserves core stop coalescing and retry semantics. `drain` may
  return one final partial packet; `discard` returns none. A successful explicit stop remains
  idempotent after an automatic terminal close. A rejected close retains the same token for retry.
- `acknowledge({ sessionToken, sequenceNumber })` retires the one pending regular packet and returns
  `accepted`, `replayed`, or `stale`. Event receipt is not acknowledgement.
- `replayPendingPacket(...)` re-emits the same pending core owner and returns `replayed`,
  `already_acknowledged`, `stale`, or `transport_failed`. Replay does not acknowledge or retire it.

Packet events contain `{ kind: "packet", packet: { sessionToken, sequenceNumber, pcmBase64 } }`.
Lifecycle events contain the token and an exact fixed interruption or terminal code. Method failures
use only the fixed codes declared in `src/definitions.ts`; no native exception detail is returned or
logged. Tokens, sequence numbers, PCM dimensions, and encoded payloads are bounded before use.

`decodeIosPcmBase64` creates a full-span `Uint8Array<ArrayBuffer>`. The consumer must process and
clear that entire buffer, then acknowledge a regular packet in a `finally` path. A drain-final packet
is cleared but not acknowledged because native closure is already complete.

## Custody and residual risk

Native packet owners remain opaque behind the bridge core. The transport creates one mutable `Data`
scratch buffer for Base64 conversion and clears it before returning. It does not clear a regular
core-owned packet until acknowledgement; replay therefore encodes the same pending owner. It clears
the transferred drain-final native owner immediately after encoding.

Swift `String`, JavaScript strings, Capacitor serialization, and WebKit message copies are immutable
or framework-owned and cannot be reliably overwritten. Base64 also expands PHI-bearing audio. Those
copies are an accepted implementation residual for this dormant packet, not authorization to
activate it. No code logs payloads, tokens, device labels, or native error descriptions.

## Later gates

Before any selection or beta activation, a separate reviewed rung must add app dependency and
registration, implement the higher-level listener/ack adapter, and prove listener-before-start,
background precheck, terminal auto-close, close retry, replay recovery, and cleanup on a physical
device. It must also validate microphone permission plist text, audio-session behavior, WebKit memory
residence, background/route transitions, signing, archive contents, and a non-PHI TestFlight canary.

## Verification

- `swift test` exercises bounds, exact code mapping, ack versus replay, stop-mode preservation,
  lifecycle events, and mutable Base64 scratch clearing.
- `swift test --sanitize=thread` covers the transport; the same command in `../ios-pcm-capture`
  covers the reviewed bridge-core concurrency suite.
- An iOS 15 simulator build of the `CosmaneuraIOSPCMCapacitor` product checks strict Swift 6 and the
  pinned Capacitor 8.5.0 boundary.
- `npm test --workspace @cosmaneura-scribe/capacitor-ios-pcm` verifies canonical bounded Base64,
  exclusive ArrayBuffer ownership, and clearing. Type checking and formatting run separately.
