# Flight plan: dormant iOS interruption-gap recovery substrate

## Outcome and boundary

- Add encrypted local `CaptureRecoveryStateV1` evidence for ordered capture segments, stable
  preallocated gap IDs, first-terminal-wins interruption reasons, monotonic revisions, explicit
  `continue_with_known_gap` acknowledgement, and permanent `review_required` note readiness.
- A source interruption enters `interruption_closing`; only a successful close in the same live
  process may advance to `ack_required`. A recovered close remains unverified and fail-closed.
- Acknowledgement advances only to `authority_required`. This packet has no transition back to
  recording and adds no UI, network call, auth path, lease renewal, reservation, or server contract.
- Clean no-gap capture retains its existing consent, encrypted chunk, upload, completion, and
  transcript flow. Any gap blocks upload completion and therefore automatic note readiness.

## Persistence, security, and recovery

- Recovery data is metadata-only: session/segment/gap UUIDs, fixed reason codes, timestamps,
  sequence boundaries, lease generation/deadline, fixed acknowledgement decision/key, and readiness.
  Runtime validators reject unknown top-level and nested fields.
- The record uses the existing non-extractable local AES-GCM key and authenticated store envelope.
  Its opaque per-session storage key prevents cross-session recovery overwrite/delete, and its
  optimistic `recordRevision` is bound into AAD; stale divergent writes fail and exact replay is
  idempotent. Completed-capture cleanup removes only that session's recovery state with flow/key state.
- A relaunch from recording creates exactly one `process_recovery_unknown` gap. Repeated relaunches
  cannot reinterpret a new source object's no-op stop as custody proof. Native reconciliation is
  deferred and the local state remains blocked.
- A clean stopped recovery can converge an older active `recording` phase to upload only when its
  terminal sequence equals the contiguous durable encrypted/registered queue high-water.
- No patient, appointment, practitioner, claim, token, URL, transcript, note, or audio fields are
  accepted in recovery state. No identifiers or native error details are logged.

## Validation and rollback

- Required evidence: reducer validation/tamper/overlap/idempotency tests; encrypted-store
  ciphertext/session/CAS/cleanup tests; controller interruption, stop-race, relaunch, authority,
  completion-block, and clean-stop crash-window tests; full npm test, lint, typecheck, build, preview
  bundle check, exact diff, and prohibited-scope scan.
- Rollback is a revert before activation. The schema is local and dormant; there is no server or
  production data migration and no release flag changes.

## A2b blockers

- Resume requires a reviewed Core BFF contract for authenticated creator/practice ownership,
  immutable gap acknowledgement, server `review_required` enforcement, fresh capture authority,
  lease renewal, and sequence reservation beginning at the durable high-water.
- Native custody reconciliation, background/route/interruption device evidence, UI acknowledgement,
  Clerk/PKCE integration, physical-device testing, signing, TestFlight, and activation remain separate.
- The pre-existing singleton active/preparation record lacks transactional clear identity; the origin
  lock remains its concurrency control. Hardening that general flow-store boundary is a separate packet.
