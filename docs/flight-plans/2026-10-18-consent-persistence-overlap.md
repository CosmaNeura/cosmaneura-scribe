# Join metadata teardown and consent persistence

Tier 2: this changes scheduling at the consent state-machine boundary. Owner:
John Clemente. The existing consent-preparation release control and its
November 1 expiry remain unchanged; explicit legacy Start follows the same
joined barrier. No additional capability or cohort is introduced.

The current setup closes advisory microphone/window metadata before persisting
the encrypted, encounter-scoped consent intent. These operations do not need
each other's result. Run them concurrently and join both before Core admission,
recorder acquisition or any recording continuation. The existing journal
compare-and-swap, attestation, fresh human authorization, current source,
permission, server checks, ticket expiry and native one-use fences remain.

Capture the current metadata owner and generation before the join. Navigation
and disposal join that same pending work before releasing the encounter. After
both operations succeed, recheck the current generation, encounter/client scope
and recording-action cancellation. An old completion cannot clear another
owner's controls or replay a withdrawn/backgrounded Record action.

Both rejections must settle the other operation before surfacing failure; if
both fail, preserve the original metadata-close error classification. If
the encrypted intent succeeds while metadata close fails, retain that original
key as recoverable local work and dispatch no admission. Reopening it uses the
existing read/recovery path, a new unchecked consent confirmation and a separate
manual Record; it does not infer consent or replay source choices. A failed
metadata owner remains available for explicit teardown retry.

Validation uses the actual workspace flow with synthetic parties and no audio
implementation: both completion orders, both failures, in-flight disposal,
withdrawal, foreground loss, host abort, and recovery of the newly possible
saved-intent/failed-close state. Existing consent, recorder ownership, journal
and preparation-control tests remain required, followed by capture types/lint
and independent review after the final substantive push. Local checks are not
hosted CI or physical performance evidence.

Build from the current reviewed merged source, preserving PR347's optional
timing propagation. No schema, OpenAPI, native helper, permission, encryption,
storage format or API contract changes are required. Recovery is to restore the
previous qualified renderer; existing local intents keep their original keys
and recovery semantics. No measured latency saving is claimed. Physical
immediate-consent/Record timing remains a separate acceptance step.
