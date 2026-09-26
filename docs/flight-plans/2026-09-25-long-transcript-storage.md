# Expand persisted long-visit transcript capacity

Tier 2, expand-only transcript storage. Owner requested three-hour visits and
authorized implementation, local checks and merge. Core PR507 and Scribe PR133 are
compatible receiver increments; neither is deployed by this source change.

Separate the existing 100,000-character per-segment bound from 500,000 aggregate
source characters and 500,000 aggregate translation-history characters. Keep
10,000 segments, existing timings, immutable hashes, canonical receipts,
translation review, creator/tenant/consent and retention checks. Translation
history remains bounded; idempotent retries reuse their original record.
The working aggregate database bound is 1,000,000 characters: at most the sum
of English source and translated content from their separately bounded inputs.

Generated Alembic revision `611c583b362a` follows `227fcc9bf18d`. Its transaction
replaces two checks with expanded, validated bounds under 5s lock/30s statement
timeouts. It changes no existing row, per-segment check, trigger, key, privilege,
RLS policy or retention. Failure rolls back the entire DDL transaction.

Rollout requires a separate staging decision: deploy Core PR507 and Scribe PR133
readers/install compatible native clients, rehearse/apply the expansion, then
activate the larger writers. Do not deploy a writer ahead of readers/schema.
Recovery after larger content is retained keeps the expanded schema and readers;
disable new larger writes rather than strand records or shrink constraints.
The downgrade deliberately refuses destructive contraction.

Validate exact aggregate and individual-segment boundaries, real PostgreSQL
source/working acceptance and full reopen, idempotent retries, new revisions,
translation-history loading, immutable/deferred aggregate checks and tenant
isolation. Use synthetic accelerated text; no real-time three-hour soak, live
Speech call, deployment or existing terminal-job retry is part of this change.
