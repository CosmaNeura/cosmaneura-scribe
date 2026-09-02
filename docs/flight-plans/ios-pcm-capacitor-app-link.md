# Flight plan: link the dormant iOS PCM adapter without activating it

## Outcome and boundaries

- Problem and measurable outcome: make the reviewed iOS PCM Capacitor package available to the
  existing iOS app and adapt its event/ack transport to the existing chunk-upload capture source.
- In scope: local npm and App-SPM dependency wiring, Capacitor plugin discovery, a listener-first
  TypeScript bridge, bounded Base64 decode/cleanup, acknowledgement, heartbeat/replay recovery, and
  an explicit false-by-default native-iOS factory gate.
- Explicit non-goals: default-on selection, real PHI, external-transcript semantics, plist or
  entitlement changes, signing, archive, TestFlight, deployment, cohort activation, or changes to
  web/Android behavior.
- Affected users, services, environments, and data classes: no users or deployed environments. The
  dormant path can carry synthetic PHI-shaped PCM in local tests and is therefore Tier 2.

## Risk and dependencies

- Tier and reason: Tier 2 because an explicitly selected future path crosses microphone PCM through
  Swift, Base64, WebKit, and JavaScript memory.
- Irreversible or high-blast-radius decisions: none. Revert the app-link commit or keep the gate
  false.
- Dependency-ordered PR stack: reviewed bridge core `77ca6bac85ec8d0b8e712d2372fc4ecea2105bfa`,
  reviewed Capacitor wrapper `06e6706becf894b75932348e4c5472afd34202ea`, then this app-link.
- Cross-repo contract/version and receiver-before-sender order: N/A; this preserves the existing
  encrypted chunk-upload flow and adds no sender or server contract.

## Current deployed state

- Live SHA/digest/configuration/schema evidence by affected environment: N/A; no deploy is authorized.
- Default-branch difference and deployed-only behavior: the app has no linked iOS PCM plugin.
- Reconciliation decision: add dormant local wiring only.
- Previous known-good artifact and data-recovery boundary: parent commit
  `06e6706becf894b75932348e4c5472afd34202ea`; revert this packet.

## Feature flag / release control (user-visible reversible behavior only)

- Control name: `VITE_CAPTURE_IOS_NATIVE_PCM_ENABLED`, false unless its exact value is `true`.
- Owner and initial cohort: founder-owned, empty cohort. Native iOS eligibility is also mandatory.
- Expiry/removal condition: the next reviewed physical-device validation and beta-activation decision
  must either replace this gate with an approved cohort control or remove the dormant path.

## Schema/data sequence (schema/data work only)

N/A. No schema, migration, persistence contract, or data operation changes.

## Rollout and promotion

- Ordered environments/cohorts and hold points: local deterministic tests and simulator compilation
  only. Hold before signing, archive, device PHI, TestFlight, or deployment.
- Health signals and measurable abort thresholds: any unbounded error, missed cleanup, duplicate
  packet, stale-token delivery, listener/start inversion, failed stop retry, or web/Android selection
  is an abort.
- Canary journey: later non-PHI physical-device packet only.
- Founder-only manual production/PHI promotion record: blocked; no production workflow is authorized.

## Security and recovery

- Open security acceptances: immutable Swift `String`, JavaScript string, Capacitor serialization,
  and WebKit message copies of Base64 audio cannot be zeroized. They block PHI activation pending
  explicit acceptance and device memory evidence.
- Recovery move: leave the flag absent/false or revert this commit. No data repair is required.
- Observation window before irreversible cleanup: N/A; no irreversible cleanup exists.

## Completion

- Evidence required: listener-before-start, foreground rejection, one-packet backpressure and ack in
  cleanup, replay recovery, stop retry/discard including a drain-in-flight discard upgrade,
  stale-event rejection, bounded Base64, default-off selection with no adapter or Capacitor runtime
  code in the bundle, no sensitive logging, TypeScript build/test/lint/typecheck, Swift tests/TSan
  where supported, and iOS 15 simulator compilation.
- Follow-up cleanup PRs and owners: physical-device audio/permission/lifecycle evidence, WebKit memory
  assessment, signing/archive review, non-PHI TestFlight canary, and explicit cohort activation.
- Documentation: this plan and the wrapper README are the packet record.
