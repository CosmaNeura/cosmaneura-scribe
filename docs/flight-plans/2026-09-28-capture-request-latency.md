# Reduce capture-operation round trips

Owner: MCD operational beta owner. Tier 2: authentication orchestration changes.
Scope: receiver capture operations on the already selected encounter. The
verified staging/native release remains unchanged until a later image rollout.

## Outcome

Native microphone start sequentially issues a recording lease, reserves chunks,
prepares a source and authorizes its one-use start. Each operation currently
exchanges a fresh user context token, resolves its interaction, resolves the
already known capture binding, then executes the operation. The redundant binding
lookup adds four Core round trips across those four requests.

Reuse the known binding identifier only for `capture-operations`, reducing each
request from four Core calls to three. The token and interaction still belong to
one fresh request. No authority, response or credential is cached across requests.
Initial opening, admission and note orchestration keep their existing resolution.
This is a request-count reduction; physical Record-to-signal timing is unmeasured.

## Core contract and preserved checks

Deployed Core source `b4cf6da91e0e82f174f97790652f5d795db598d8`:

- `perform_capture_operation` calls `execute_capture_operation` with the exact
  native binding/workspace and authenticated workload/interaction.
- Every operation calls `authorize_admitted_capture` before downstream work.
  That calls `CaptureCaller.authorize` and `authorize_capture_binding`.
- The binding check locks and refreshes current identity, membership, provider
  link, practice, doctor, appointment and patient. It rejects revocation,
  workspace mismatch and any difference from the stored binding scope/digest.
- Core reauthorizes around downstream operations and publication. Existing
  consent, lease/reservation and source prepare/authorize/stop contracts remain.

The receiver still validates the fresh mount's surface, tier, actor, tenant,
turn and interaction; checks current registry scope before/after every Core I/O;
checks the operation envelope's binding/workspace/nonce/version/timestamp; and
rechecks access before returning to the native client. A Core denial ends the
request without fallback, automatic retry, binding replacement or a new intent.
Unknown bindings still fail through Core's authoritative operation check.

## Validation and release

Run transport tests for all startup operations, fresh negotiation on each call,
revocation/selection change at every remaining boundary, Core binding denial,
malformed replies, cancellation, concurrent request isolation and explicit
same-key retry after an uncertain write. Run the existing frozen native identity
and PostgreSQL receiver tests, plus lint/types and implementer review at the exact
tested commit. Keep normal change budgets and PR/merge evidence.

The later receiver image rollout is the release control, owned by the beta owner
and limited to the approved staging cohort; it expires on acceptance or candidate
replacement. Native packages, Core, schema, environment and stored formats need
no changes. Reconcile deployed images/configuration before that rollout. Restore
the previous approved receiver image to recover the extra-lookup behavior. Do not
reset recordings, keys or journals. No deployment is part of this source change.

## September 30 benchmark calibration — tools only, Tier 0

The desktop readiness runner now distinguishes operation models from injected
dependency delays. Its previous `dependency-sensitivity` behavior delayed even
modern local source-authority consumption and empty-owner retirement. Those
receipts remain valid sensitivity measurements, but are not modern Mac network
latency measurements. No milliseconds are subtracted from historical results.

The new default `modern-clean` exercises the real desktop backend's owner set:
combined source preparation retains a one-use decision at the simulated native
boundary; successful Pause retires and removes its owner; the subsequent Resume
retirement issues no request. Separate interrupted and known-404 legacy models
retain their required remote work. The recorder, flow, encrypted temporary store
and cloned IPC are unchanged. No product, native package, endpoint, credential,
authority lifetime or stored recording changes are part of this calibration.

Run the invocation and model regressions in
`apps/desktop-companion/test-tools/desktop-readiness-README.md`. Repeated moderate
and slow profiles record source hashes before/after, classify simulated remote,
local and no-op boundaries, and assert native readiness/ownership ordering.
These results exclude live services, physical audio, native execution and screen
paint; four-second product acceptance still needs those separate measurements.
Recovery is to select `--model dependency-sensitivity` for historical comparisons
or revert the tools-only change; no recording state or deployment is involved.
