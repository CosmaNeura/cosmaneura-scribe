# Consolidate current encounter reads during native preparation

Owner: MCD operational beta owner. Tier 2: implementation of existing creator
and encounter authorization checks, within the approved startup performance work.
Target: halve the last measured 8.273-second native startup; actual device timing
remains a separate acceptance gate with Device Hub/mirroring closed.

The receiver currently reads the appointment/link twice inside each fresh
authorization snapshot: `_workspace` validates them, then `selected` repeats
`_encounter`. It also issues separate principal/workspace queries. The deployed
async receiver already uses a new REPEATABLE READ, read-only transaction for each
check. Join the same current principal, workspace, appointment and confirmed link
predicates once within that transaction. Keep the existing identity verifier,
reviewed account lookup, tenant/creator restrictions, source check and before/after
Core authorization boundaries. Retain the row-locking path for synchronous hosts.

There is no cross-request authorization cache, skipped fresh check, new endpoint,
schema, dependency, credential, consent change or source capability. Require the
read-only isolation options before selecting the joined path. Invalid or revoked
rows must deny access before Core or hide an already-issued reply without retry.
Saved recordings, journals, keys and original mutation intents are unchanged.

Validate against the existing socket-only synthetic PostgreSQL/verifier fixture:
compare legacy/current valid selections and query counts, deny each changed row
relationship, verify fresh committed revocation at all Core boundaries, retain
source-start key/nonce correspondence, and confirm actual read-only isolation.
Keep the original receiver and transport suites. Use metadata-only query counts;
never retain SQL binds, tokens, labels, audio or note text in evidence.

Release is a later coherent receiver package for the existing synthetic staging
cohort, owned by the beta owner until candidate replacement. No phone update is
required for this server-side change. This commit does not deploy or activate it.
Recover by restoring the retained immutable receiver image; database/application
data and client keys stay intact. A query-count reduction alone does not prove the
physical four-second goal; measure the exact deployed candidate afterward.
