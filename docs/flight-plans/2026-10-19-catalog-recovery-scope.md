# Catalog recovery scope handoff

Tier 2: this additive response field initializes an existing account-scoped
encrypted preference owner. No authorization, storage format, schema, token,
consent, source permission or deadline policy changes.

The receiver already completes the current authenticated Core encounter-list
request and receives its recovery scope. It currently drops that scope from the
catalog response. On a fresh desktop connection, hidden-visit preferences then
issue an empty patient search solely to obtain the same account/scope; the
returned patients are unused. The observed October 19 startup has a 9.239 s
catalog request followed by a 1.919 s preference operation. These are baseline
observations, not measured savings from this change.

The receiver carries the UUID-validated scope with its existing account response.
Both native backends validate the current catalog revision, account, environment,
encounters and optional scope before publishing account/maps. The shared setup
owner accepts only the same account and scope for its lifetime. A missing scope
keeps the older receiver's patient-search fallback; a malformed present scope or
changed account/scope refuses without fallback. The fallback's response must
match the catalog account. Hidden-visit records are still read from their original
encrypted namespace and filtered before the encounter list renders.

Tests cover the original hidden namespace, no unused patient request, the legacy
fallback, malformed scope, changed account/scope, stale native revision and
cancellation. Existing consent/preparation and draft recovery tests remain in the
focused checks. The existing PG receiver test additionally asserts the forwarded
scope equals its actual authorized selection. Author source checks do not start
PostgreSQL; that assertion remains an actual disposable qualification gate.

Deploy the receiver before new renderer/desktop-host consumers. Existing native
Swift transport and recording components are unchanged; they already return the
bounded authenticated JSON response without enumerating catalog fields. Retain
the qualified installed app and receiver artifacts for recovery. If the new
catalog cannot be validated, keep the loading failure visible; do not render
unfiltered encounters or submit capture. Reverting these source changes restores
the prior scope-fetch path without modifying persisted preferences or audio.

Independent review after the final substantive push remains required. Hosted CI,
new native builds, deployment, physical startup savings and a below-five-second
recording result are not established by source checks.
