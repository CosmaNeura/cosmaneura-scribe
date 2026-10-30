# Fresh recording-window source-start handoff

Tier 2: this receiver-only change transfers an existing opaque preparation
credential between adjacent native recording steps. It changes no consent,
source-capability lifetime, authentication policy, durable schema or client API.

## Problem and outcome

When recording-window preparation cannot consume an earlier setup credential,
the receiver negotiates a fresh Core context and completes the window. It then
discards that context. The immediately following source-start request must repeat
Core negotiation. A reused recording-window context already has a one-use
source-start handoff; the fresh branch should have the same behavior.

After the fresh window's owning transport closes successfully, check the current
account and cancellation again, then offer the original context to the existing
`retain_source_window` validator. Core must have advertised the exact source-start
capability, and the returned window must match all existing lease, binding and
reservation checks. Keep the context's original issue time and destructive claim.
Never retain an access decision, source-start permit or microphone sample.

## Validation and promotion

The focused wire suites must pass. Both a first fresh window and a fresh window
after setup expiration must reach source authorization with exactly one Core
request; both regressions must fail on the previous source. Failed transport close
must leave no handoff. Existing source tests retain every current-account fence,
original TTL, one-use behavior and ambiguous-response refusal.

Promote the reviewed receiver image to staging through the existing owner-approved
receiver rollout. Preserve other deployed Core and receiver changes. No client
rebuild, database change, environment setting or production activation is needed.
Use a synthetic, consented native capture to verify Record-to-first-PCM timing
after deployment. Source checks and actual first PCM remain the acceptance gate;
passing source tests is not evidence that the five-second gate has passed.

## Reversion and limits

Revert this source change and redeploy the preceding reviewed receiver image if
the new handoff causes a start regression. Existing recordings and durable source
stop proofs are unchanged. A context miss or expired/unsupported capability still
selects fresh negotiation before any mutation; a dispatched failure never retries
or falls back. This change cannot improve legacy receiver paths, expired source
handoffs, native audio activation or network transit time.
