# Flight plan: dormant iOS AVFoundation driver

## Outcome and boundary

- Add a live, injected `AVAudioSession`/`AVAudioEngine` implementation for the
  reviewed iOS PCM core, including permission and lifecycle adapters.
- Keep the target unlinked and unselected. Do not add a Capacitor bridge,
  package dependency from the app, Xcode/generated files, capture-factory
  selection, permission plist entry, entitlement/background mode, signing,
  TestFlight, deployment, or activation.
- Tier 2 because a future activation would create a PHI-bearing microphone
  boundary. This packet stacks on `17e1fd5d80905e551da3290cfd71354503a2c107`.

## Safety model

- The core still owns the session synchronously. Driver control calls are actor
  serialized; generation-tagged callbacks make stale taps and notifications
  inert, and failed freeze/deactivate retains ownership for retry.
- Startup ignores only configuration-caused route changes before the engine is
  armed. Other startup lifecycle/media loss fails closed. Active lifecycle loss
  closes frame admission and maps to one fixed core event.
- The tap copies at most 32 non-interleaved Float32 channels and 32,768 frames.
  Only one transferred frame may await the core receipt; overrun discards and
  terminates instead of queueing audio.
- The core performs deterministic downmixing, resampling, and PCM encoding.
  Driver/application buffers are cleared on rejection or by the receiving core.
  Apple-managed `AVAudioPCMBuffer`, allocator copies, and future bridge copies
  cannot be proven zeroized and remain an activation risk.

## Evidence and recovery

- Deterministic facade tests cover permission mapping/cancellation, startup
  event arming, configuration, cancellation, backpressure, event mapping,
  stale callbacks, and retryable/idempotent cleanup. Compile both targets for
  iOS 15 simulator with strict Swift 6 concurrency and run package tests with
  Thread Sanitizer.
- Recovery is to revert or leave this target unlinked. It changes no runtime,
  schema, environment, signing, or deployed state.
- Physical-device microphone, route, Bluetooth, lock/background, interruption,
  media-services reset, thermal/load, and permission-transition evidence is
  mandatory before any bridge, selection, TestFlight, or PHI-bearing use.
