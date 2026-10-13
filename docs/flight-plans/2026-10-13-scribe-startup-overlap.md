# Scribe recording startup work reduction

Tier 2: the receiver reuses a short-lived server credential for one scoped native
preparation read. Current account, workload, Core authority and consent checks
remain fresh. See the matching Core flight plan for receiver-first compatibility.

The receiver's existing admission-to-first-window handoff is also available to
the native preparation read between those calls. Use `prepared_native_read` only
when Core advertises version 1. Otherwise run the ordinary read, then retain the
existing first-window credential. Successful reads carry a consumed-read marker;
additional reads negotiate normally. Never extend the original issue time,
retain a user/workload token or access decision, expose the context to the
device, retry an uncertain prepared request, or widen its visit/account scope.
Bounded cache size and context ages remain unchanged.

The iOS renderer separately opens its scoped encrypted database while recorder
authorization runs. It joins both operations before returning or cleaning up.
Recording custody reads still happen only after authorization succeeds. The
exclusive capture lock is held until all handles settle. Failed authorization
closes a late store; no audio source starts and saved legacy custody is retained.

Release order: review the exact final commits; merge and deploy the additive Core
capability first using the existing staging promotion controls; then deploy the
receiver from merged source. Mobile store overlap requires a new reviewed beta
build. Existing TestFlight cohorts are retained. This candidate is based on
protected main `5a03e8421265b04c572e931b0f01bdebc7742980`, preserving newer recording
scope, upload expiry and speech diagnostics. Compare immutable deployed digests
before promotion. No new environment setting, dependency or migration is needed.

Recovery: restore the prior receiver digest for backend behavior and the prior
mobile build for renderer behavior. New receivers handle old Core responses via
the ordinary-read path. Restore receiver before Core if reverting both. Preserve
all recordings, key custody, reservation count and saved notes.

Acceptance: the existing virtual iPhone lab must preserve true input confirmation,
failure/cancellation behavior, retained creation keys and source cessation. Real
synthetic PostgreSQL receiver tests must retain identity/session/selection fences.
Then repeat fresh fictional recording-to-transcript-to-saved-note tests and
consent-to-first-input phone timing. Three staging preparation rounds were
6.08–7.08 seconds; they exclude phone hardware and source start. The candidate's
overlap removes 2 seconds in an explicitly delayed storage fixture, not a measured
phone saving. No five-second physical-device or release-ready claim is made.

Evidence: owner workspace
`output/scribe-provider-ux-20261007/autonomous-startup-rounds-20261013`.
The owner authorized local independent reviews on October 13. Review evidence
must identify the exact final commit and be recorded before merging.
