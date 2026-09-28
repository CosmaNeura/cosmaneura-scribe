# Batch capture reservation database work

Tier 2: metadata persistence on the existing consent-gated capture path.

The iPhone42 physical check reached first audio after 10.315 seconds on the
first Resume and 3.798 seconds on an immediate repeat. The first reservation
request took 4.313 seconds. PostgreSQL currently dispatches inserts, canonical
reads and batch-item inserts separately for every chunk. A new 90-chunk batch
performs 274 reservation-related database dispatches; a full overlap still
performs 184. These counts are a local regression baseline, not staging traces.

Use the installed SQLAlchemy/asyncpg batching support for inserts, and reload
canonical records with one tenant/session-scoped query. Preserve the same
transaction, capture locks, consent and key requirements, generation/expiry
checks (including the final database-time lease fence), position continuity,
budgets, immutable identifiers/AAD, request ordering, RLS and idempotency. No
schema, data migration, dependency, authority cache or API contract change.

Validate against fresh local PostgreSQL: bounded database dispatches for one
and 90 chunks; overlapping/replayed mixed-channel reservations with reversed
request order; a conflict partway through a batch rolls back every position;
existing concurrency, RLS, immutability, API, lease and native continuation
checks. Run local lint/type checks and implementer review under the owner's
September 25 policy. Record the exact tested/reviewed SHA in the PR.

Release only merged source in the existing API/worker image pathway, retaining
current deployment identities/configuration and all recordings, keys and
journals. Receiver revision20 and iPhone42 do not need changes for this fix.
Reconcile current deployed images before any rollout. Roll back by restoring
the previous immutable API/worker image; never undo recorded reservations.

Database dispatch reduction is not proof of a particular phone latency. A
later short physical check must establish first-start improvement. Existing
three-hour and local two-voice results retain their original acceptance limits.
