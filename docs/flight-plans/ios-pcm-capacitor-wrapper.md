# Flight plan: dormant iOS PCM Capacitor wrapper

## Outcome and boundaries

- Add a standalone, thin Capacitor 8.5.0 wrapper over bridge-core commit
  `77ca6bac85ec8d0b8e712d2372fc4ecea2105bfa` with a bounded TypeScript/native method, event, and
  fixed-error contract.
- Preserve the core's opaque generation token, single pending packet, explicit acknowledgement,
  replay-without-acknowledgement, discard dominance, retryable close, automatic terminal close, and
  stale-generation isolation.
- Tier 2 because Base64 and JavaScript transport will carry PHI-bearing audio when activated.
- Explicitly excluded: capture-app dependencies or imports, App-SPM/plugin registration, factory
  selection, plist/entitlement changes, signing, TestFlight, deployment, and existing-flow changes.

## Risk and dependencies

- This packet depends locally on the exact reviewed core parent and pins Swift/JavaScript Capacitor
  compatibility to 8.5.0. It can remain indefinitely unlinked.
- Regular event delivery is not an acknowledgement. Native retains exactly one pending core owner;
  replay serializes that owner again, and only explicit `acknowledge` permits retirement/production.
- Stop mode is passed through unchanged. Core-owned coalescing, discard upgrades, automatic-close
  tombstones, and failed-close token retention remain below this wrapper without duplicate state.
- Inbound token, sequence, PCM configuration, and Base64 sizes are bounded. All failures exposed by
  this layer are exact fixed codes without native detail.

## Current deployed state

- No deployed or selectable behavior changes. The production Capacitor package graph and application
  source remain untouched.
- Recovery is a revert of this standalone package and flight plan; there is no data migration or
  deployed state to recover.
- Schema/data sequence and release feature flag are N/A because the wrapper is dormant and introduces
  no storage or user-visible behavior.

## Security and recovery

- The wrapper reads a core packet only inside `withUnsafeBytes`, Base64-encodes one mutable `Data`
  scratch copy, and clears that scratch. A regular core owner remains for replay until explicit ack;
  a drain-final core owner is cleared after conversion. Decoded JavaScript bytes must be full-span and
  explicitly cleared by their eventual owner.
- Immutable Swift Base64 strings, Capacitor serialization objects, JavaScript strings, and WebKit
  internal copies cannot be reliably zeroized. Their lifetime and memory behavior remain an explicit
  activation blocker requiring device evidence and security acceptance.
- No PHI, tokens, device details, or native exception descriptions may be logged.

## Completion and later promotion

- Required evidence: deterministic Swift and TypeScript tests; Thread Sanitizer over transport and
  transitive core tests; strict Swift 6 iOS 15 simulator compilation; formatting; exact diff and
  prohibited-wiring scans; independent review of the committed candidate.
- Later, separately reviewed work must wire the package, build the higher-level TypeScript adapter,
  add permission metadata, and validate physical-device listener ordering, permission states,
  foreground transitions, interruption/route/background behavior, terminal close, retry/replay,
  memory cleanup, signing, archives, and a non-PHI beta canary before selection.
