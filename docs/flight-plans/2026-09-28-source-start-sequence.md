# Combine native source preparation and authorization

Owner: MCD operational beta owner. Tier 2: native capture authorization
orchestration within the approved recording-readiness work. Receiver-first,
backward-compatible addition; no current native client changes in this PR.

The physical build40 trace spent 5.605 seconds preparing and authorizing the
source, after lease/reservation preparation. Both native requests independently
exchanged and resolved Core context. The new native-only `source-start-ready`
route performs the same two decisions with one request-local negotiation:
four Core requests instead of six. This is a request-count reduction, not a
measured physical speedup. Existing `source-start` remains unchanged.

The native caller supplies its original prepare key/nonce and distinct authorize
key/nonce, plus one source intent. Validate the entire request before Core I/O.
The body is the existing prepare envelope plus `authorize_idempotency_key` and
`authorize_request_nonce`; the response contains the existing complete envelopes
under `preparation` and `authorization`. The original header key remains the
prepare key. No new Core protocol or response field is required.
Both decisions use the identical source intent, including owner proof, lease,
position and deadline. Validate the prepared receipt before authorization and
provide a cancellation point between them. Every Core request retains fresh
registry checks before and after I/O. Core independently rechecks its existing
creator, consent, lease and source conditions for each decision. Tokens,
interaction and turn remain local to one request; no cross-request cache,
automatic retry, new grant or longer lifetime is introduced.

Native integration must persist original stop custody before dispatch, validate
both returned receipts, and preserve the existing physical-stop/confirm-stop
recovery on failures, cancellation and ambiguous responses. This source PR does
not claim that a network disconnect automatically cancels server work; the
native owner must recover original stop custody even if authorization completed.
It does
not activate that client. No microphone, recording, key, schema, configuration,
dependency or production deployment changes are included.

Validate the actual transport and receiver with synthetic Core responses and
the frozen identity verifier/local PostgreSQL. Cover exact request count and
keys, each access-check boundary, malformed or expired prepare receipts,
cancellation, lost responses, concurrent isolation and continued rejection from
the generic renderer route. Record exact tested commit and implementer review.

The existing immutable receiver-image release is the rollout control, owned by
the beta owner for the staging cohort until candidate replacement. Reconcile
deployed state before rollout; retain unrelated Core/Session Prep/CosmaBot work.
Existing clients need no update for this receiver addition. Restore the prior
approved image to remove the new route; a later client must be rolled back with
it if it requires this route. Preserve all retained recordings and stop proofs.
