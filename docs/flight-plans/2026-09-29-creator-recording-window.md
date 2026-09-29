# Combine creator verification with recording preparation

Owner: MCD operational beta owner. Tier 2: capture preparation under the
authorized startup-performance work. This is a receiver-first change; it does
not weaken consent or cache an authorization result.

Core currently reads the configured creator review before issuing/renewing a
lease or reserving chunks. These metadata mutations already recheck consent
atomically, but removing the review alone would omit the original creator check.
Add three narrow `/v1/captured-sessions` routes that combine the same live
creator/consent/retention check with the existing mutation transaction. They reuse
the configured creator runtime, verified workload tenant, creator header, consent
policy, request/response models, limits, audit writes, and idempotency namespaces.
They do not issue a microphone/source capability or change the native journal.

The legacy route functions delegate to the same shared operation functions with
no creator override. New routes supply the authenticated platform's asserted
creator and configured repository. Inside the transaction, acquire the existing
idempotency claim, consent and session locks in their original order, then run
`lock_live_capture` and compare the creator before either mutation or receipt
replay. Foreign tenant/creator, invalid consent, expired/purged source retention,
and disabled runtime remain rejected. Existing receipts remain readable with the
same key after a lost reply or switching between old and new routes.

Qualification uses fresh disposable local PostgreSQL, real route and repository
code, and synthetic identity/key fixtures. Test old/new concurrent calls with the
same key, fresh connection replay, wrong creator and consent revocation for both
new writes and replays, unchanged payload conflicts, required headers and normal
workload authentication. Re-run applicable legacy capture and admission tests.
Generate OpenAPI from the app; do not hand edit its generated document.

Deploy and verify this merged Scribe API before activating the separate Core
sender change. Core must use these routes only for configured issue/renew/reserve
operations; it must preserve before/after current Core admission, original
idempotency keys and receipt validation. Keep legacy and all other operations on
their current paths. An unavailable route must not trigger an automatic retry or
fallback of an uncertain mutation. No configuration, cohort, dependency, schema,
native app, worker or source-start changes are required.

The immutable staging image is the release control for the existing synthetic
cohort, owned by the beta owner until its next replacement. Reconcile exact
deployed source/image/configuration and retain unrelated work before rollout.
Recovery: restore the previous Core sender first; the additive Scribe routes can
remain. Preserve all databases, keys, journals and receipts. Production remains
outside this authorization. Removing a network request is not proof that the
physical four-second startup target has been reached.
