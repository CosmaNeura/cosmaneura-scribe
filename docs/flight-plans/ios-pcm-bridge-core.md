# Flight plan: dormant iOS PCM bridge core

## Outcome and boundary

- Add a standalone Swift bridge-core target between the reviewed PCM
  core/AVFoundation driver and a future Capacitor plugin. It owns an opaque
  session token synchronously, while readiness, heartbeat, stop, packet
  acknowledgement, and replay remain separate operations.
- Keep the target unlinked and unselected. Do not add Capacitor, an app/package
  dependency, generated Xcode files, factory selection, permission plist or
  entitlement changes, signing, TestFlight, deployment, or activation.
- Tier 2 because a future wrapper will transport PHI-bearing microphone bytes.
  This packet stacks on AVFoundation driver commit
  `47fe028619a0dee859fa1635dcaaf07554472071` and has no runtime effect.

## Safety model

- One bridge instance owns at most one active generation. Tokens combine a
  monotonic generation with a bounded opaque random fragment, so callbacks and
  acknowledgements from a retired generation cannot target its replacement.
  The registry lock remains held through core handle creation and record
  installation; an immediately scheduled startup callback takes that same lock
  and therefore cannot observe a claimed-but-unbound session.
- The bridge copies a core packet into one bounded mutable byte owner. At most
  one packet may await acknowledgement; replay republishes the same owner and
  never creates another audio copy. Delivery leases prevent acknowledgement or
  retirement from clearing or advancing the packet while a publisher reads it.
- Acknowledgement is explicit and idempotent. Cancellation wins as stale, not
  as a successful replay. Drain transfers at most one final partial packet;
  discard clears it. Every bridge-owned byte buffer clears on acknowledgement,
  cancellation, discard, transport failure, explicit cleanup, or deinit.
- Discard dominates concurrent drain. Concurrent callers share a close attempt,
  and a successful discard upgrade wins if the original drain close fails. A
  failed freeze or release retains the same token and blocks replacement until
  stop succeeds. Automatic terminal close and an explicit TypeScript stop
  converge; one metadata-only completed token makes the latter idempotent after
  automatic retirement.
- TypeScript-facing start and lifecycle values use its exact fixed codes.
  Registry and stop failures also use bounded wrapper-internal codes; a future
  Capacitor layer must reject them without native detail. No text, audio,
  encoded bytes, device detail, token, or native error is logged.
- The TypeScript boundary prechecks application foreground state. A later
  foreground transition during AVFoundation startup remains the reviewed
  core/driver behavior and resolves readiness as `ios_capture_start_failed`;
  `ios_capture_not_foreground` is reserved for the wrapper precheck in this
  standalone packet.

## Evidence, recovery, and next rung

- Required evidence: regular and Thread Sanitizer Swift package tests covering
  startup cancellation and immediate terminal binding, stale generations,
  close retry and drain-to-discard upgrade, terminal-close races,
  drain/discard, concurrent ack/retire, replay/ack leases, bounds, fixed codes,
  and zeroization; strict Swift 6 iOS 15 simulator compilation; exact diff and
  prohibited-wiring scans.
- Recovery is to revert or leave this standalone product unlinked. It changes
  no app, schema, environment, signing state, or deployed artifact.
- A later separately reviewed packet may add the thin Capacitor plugin and its
  Base64/JavaScript conversion. That wrapper must clear its temporary native
  bytes after encoding and must treat immutable String/JavaScript/WebKit copies
  as an unresolved activation risk. Runtime factory selection, physical-device
  validation, signing, TestFlight, and non-PHI beta activation remain later
  explicit decisions.
