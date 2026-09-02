# Flight plan: fail closed when the iOS application becomes inactive

## Outcome and boundaries

- Add the earliest application lifecycle signal needed by the foreground-only iOS PCM contract:
  `UIApplication.willResignActiveNotification` becomes the existing fixed
  `ios_capture_backgrounded` interruption at the public bridge boundary.
- Reuse the driver's first-terminal-wins gate so overlapping resign-active, background, and audio
  interruption notifications produce one terminal callback, close frame admission once, and retain
  the existing idempotent and retryable cleanup behavior.
- This Tier 2 packet stacks directly on reviewed app-link commit
  `7801d703c6ef10cf747da47ef7e9a700234ff84c` because the dormant path may eventually carry
  PHI-bearing microphone audio.
- Explicit non-goals: gap or resume state, queue/key custody, auth or BFF integration, language or
  transcript metadata, a device harness, plist or entitlement changes, signing, archive,
  TestFlight, deployment, cohort enrollment, or activation.

## Safety and release control

- `VITE_CAPTURE_IOS_NATIVE_PCM_ENABLED` remains false unless its exact value is `true`; this packet
  does not change factory selection or any web or Android path.
- The resign-active observer emits the already reviewed `.backgrounded` core event and
  `ios_capture_backgrounded` bridge code, so no public method, payload, event, or error contract
  changes.
- The generation-bound callback gate admits the first lifecycle terminal event and rejects later
  overlapping events. Release continues to await the admitted terminal delivery; failed native
  cleanup retains the same session for explicit stop retry.
- Recovery is to revert this packet or leave the existing native flag absent/false. There is no
  schema, data, environment, or deployment recovery action.

## Evidence and hold points

- Deterministic Swift tests prove the live source maps the resign-active observer to backgrounded,
  a background event during startup fails closed, and overlapping lifecycle/interruption events
  produce one delivery while release remains idempotent.
- TypeScript coverage proves overlapping fixed lifecycle signals request one discard and a failed
  discard remains retryable on the same source ownership boundary.
- Run the Swift package normally and with Thread Sanitizer, compile the driver and linked app for an
  unsigned iOS 15 simulator target, and run the relevant and full capture checks.
- Hold before physical-device use, signing, archive, TestFlight, deployment, or activation. A real
  iPhone must still prove Home, lock, system overlays, calls/alarms, route changes, permission
  transitions, notification ordering, prompt timing, and repeated lifecycle/cleanup behavior.
