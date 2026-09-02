# Flight plan: dormant iOS native PCM boundary

## Outcome and boundaries

- Problem and measurable outcome: define and test the smallest injectable iOS
  foreground-microphone boundary that can produce the capture client's existing
  PCM16 WAV chunks without selecting or activating it at runtime.
- In scope: a TypeScript bridge contract, `CaptureSource` adapter, metadata-only
  fake, fixed error mapping, bounded packet validation, buffer cleanup, and
  synthetic fixture tests. Each start has an isolated generation and native
  session handle returned before asynchronous readiness; normal stop drains one
  final partial packet, while abort and terminal paths discard it.
- Explicit non-goals: Swift or `AVAudioEngine`, `capture-source-factory.ts`,
  runtime selection, background recording, auth/Core/API/schema/migrations,
  provider credentials, signing, distribution, deployment, or beta activation.
- Affected users, services, environments, and data classes: no users or live
  environment; test-only synthetic audio. A future implementation would handle
  PHI-bearing audio and therefore requires a separate reviewed activation.

## Risk and dependencies

- Tier and reason: Tier 2 because this is a future PHI-bearing microphone and
  native security boundary, even though this packet is dormant.
- Irreversible or high-blast-radius decisions: none in this packet. The contract
  fixes PCM16 little-endian, mono, 16 kHz, foreground-only input and bounded
  fixed-code failures; changing it later requires coordinated native/client work.
- Dependency-ordered PR stack: this packet stacks on the dormant Apple metadata
  packet at `37bbfd0b4346b89d445f294d26418f82a876bc47`. It can remain unmerged with no
  runtime effect. A later Swift receiver must land and be independently reviewed
  before any separately gated factory selection.
- Cross-repo contract/version and receiver-before-sender order: N/A; the bridge
  and receiver adapter are local and no native sender exists yet.

## Current deployed state

- Live SHA/digest/configuration/schema evidence by affected environment: N/A;
  there is no iOS native microphone implementation or selected native source.
- Default-branch difference and deployed-only behavior: none known in this scope.
- Reconciliation decision: retain the existing synthetic source; this packet
  adds no import from the runtime factory.
- Previous known-good artifact and data-recovery boundary: the existing
  capture-disabled client remains the behavioral baseline; no data is written.

## Feature flag / release control (user-visible reversible behavior only)

- N/A. No user-visible behavior is introduced and the runtime factory is
  intentionally unchanged. Activation requires a separate explicit control,
  cohort, owner, expiry, and founder decision.

## Schema/data sequence (schema/data work only)

- N/A. There is no schema, migration, persistence, backfill, or cleanup.

## Rollout and promotion

- Ordered environments/cohorts and hold points: unit tests with synthetic audio;
  then a separately reviewed Swift implementation; then unsigned simulator and
  physical-device evidence; only then a separately authorized non-PHI cohort.
- Health signals and measurable abort thresholds: zero sequence gaps, oversized
  packets, concurrent deliveries, background packets, unsanitized failures, or
  uncleared test buffers. A native stop rejection blocks restart and requires a
  successful retry on the retained session handle; the flow remains paused and
  cannot upload or complete before that retry succeeds. Any occurrence blocks
  the next rung.
- Canary journey: N/A until a real native bridge and explicit runtime gate exist.
- Founder-only production/PHI promotion: blocked; this repository has no
  production Scribe promotion workflow and this packet authorizes no activation.

## Security and recovery

- Open security acceptances: none. Native audio must not be logged; only bounded
  codes cross the bridge. Transferred buffers must have exclusive, full-span
  `ArrayBuffer` ownership; rejected views are cleared across their entire
  backing buffer. Native and JavaScript buffers must be cleared after
  acknowledgment, stop, abort, interruption, and failure.
- Recovery: before activation, revert this dormant packet or leave it unimported.
  There is no image, infrastructure, schema, or data recovery action.
- Observation window before irreversible cleanup: N/A.

## Completion

- Evidence required: focused and full capture tests, lint, typecheck, secret/PHI
  scans, exact diff inspection, Capacitor sync check, and unsigned simulator
  build where the local Xcode toolchain permits it.
- Follow-up owner: product engineering must implement the Swift bridge, native
  lifecycle tests, physical-device capture evidence, and an explicit runtime
  gate in separate Tier 2 packets.
- Documentation to update on activation: Apple release readiness, beta runbook,
  capture architecture, threat model, and the exact reviewed activation record.
