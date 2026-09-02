# Flight plan: dormant iOS PCM core

## Outcome and boundary

- Add a standalone, testable Swift core for 16-kHz mono PCM16 little-endian
  production, strict packet bounds, lifecycle shutdown, and buffer cleanup.
- Keep it unlinked and unselected: no Capacitor dependency or bridge, capture
  factory, app Xcode/generated file, permission plist, entitlement, auth,
  schema, infrastructure, signing, distribution, deployment, or activation.
- Tier 2: this is a future PHI-bearing microphone boundary even though no user
  or environment can reach it in this packet.
- This packet stacks on dormant TypeScript boundary PR #67 at
  `982ab9209d0d819a92b1dfb3d1898706685621d1`; neither packet is activated.

## Safety model

- A session handle owns the driver immediately while readiness remains
  cancellable. All state is actor-serialized and callbacks are generation-bound.
- Memory is bounded to one emitted packet awaiting acknowledgement plus one
  accumulator. Any overflow, invalid PCM, sink failure, lifecycle event, or
  watchdog expiry fails closed and requests discard.
- Drain freezes input, waits accepted full packets, and returns at most one
  partial. Discard clears partial state. Freeze/release failure retains the
  handle, blocks restart, and requires retry.
- Only fixed codes cross the core boundary. Audio content and native exception
  detail must never be logged.
- Application-owned mutable buffers are explicitly cleared. Apple/framework
  buffers and future JSON/Base64 transport copies are not proven zeroized and
  remain an activation blocker.

## Evidence and recovery

- Required evidence: Swift unit tests for golden resampling, cancellation,
  sequencing, backpressure, bounds, drain/discard, retryable stop, stale
  callbacks, lifecycle/watchdog stops, and owned-buffer clearing; repo policy
  scans; exact diff; unsigned simulator compile if the toolchain supports it.
- Recovery before activation: revert this standalone package or leave it
  unlinked. It writes no data and changes no runtime, schema, or environment.
- Next rung: separately reviewed live AVAudioSession/AVAudioEngine driver and
  Capacitor bridge, followed by explicit gated selection, physical-device
  evidence, signing, and founder-authorized non-PHI beta activation.
