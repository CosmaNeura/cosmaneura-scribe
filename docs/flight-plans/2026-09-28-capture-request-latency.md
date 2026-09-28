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
