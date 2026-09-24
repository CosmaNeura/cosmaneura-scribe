# Flight plan: dormant bilingual source database expansion

## Outcome and boundaries

- Outcome: revision `0009` represents the accepted normalized-source receiver contract while every existing row and runtime route behaves as before.
- In scope: immutable session/profile configuration, versioned states, source/segment/receipt-key tables, forced tenant RLS, session fencing, retention markers, terminal evidence, migration cycling, and real-PostgreSQL tests.
- Out of scope: repository/API code, OpenAPI, grants/bootstrap, Core DB, clients, providers, translation/review/working tables, backfill, migration apply, deploy, or activation.
- Data boundary: Scribe PostgreSQL only. Tests contain synthetic text and opaque identifiers.
- Tier 2: transcript storage, PHI boundary, state-machine, and schema work.
- Source of truth: receiver contract/ADR 0028 at `356bbd839deacdcecb372035f7652d3f3436d0a7`; code parent is `fe136e696958e1828b1ce31321c59d7cf1dbb15a`.
- Order: architecture -> expand -> persistence -> API receiver -> dark verification -> disabled Core sender -> provider/Desktop senders. Native iOS/web stays on chunk upload.
- Hold safety: no current schema, repository, route, client, or role can select the new path.

No environment is changed by this packet. Deployed-dev drift must be reconciled before clinical runtime change; the synthetic beta database and migration apply require separate approval. `0008` remains the legacy baseline; `0009` is held additively; destructive cycling is disposable-only; persistence/API stay separate; beta recovery stops rollout while retaining the expand. The migration uses five-second lock and sixty-second statement timeouts. Checks are added `NOT VALID` then validated; abort on timeout, multiple heads, legacy behavior change, unexpected grants, or non-null configuration on an old row.

## Security, rollout, and recovery

- Every new table has composite tenant/session foreign keys plus forced RLS. New helper functions revoke `PUBLIC` execute; no application principal receives a new grant.
- Plaintext, raw keys, and unkeyed fingerprints cascade from the content root only after the purge marker. Terminal/deletion metadata remains; the current pointer clears.
- Persistence must prove consent-then-session lock order, DB-clock anchors, atomic receipt/version allocation, replay behavior, both purge races, and no post-purge reconstruction. This rung does not claim that runtime behavior.
- Operational rollback never drops the schema. Downgrade is only for a disposable `_test` database and refuses after any new configuration, state, content, marker, or event was used.
- No feature flag applies because there is no user-visible behavior. Future API admission remains false-default, founder-controlled, one synthetic practice, and separately authorized.

## Completion evidence

- One Alembic head and disposable migration cycle; PostgreSQL tests cover the legacy matrix, representative configured transitions, immutable configuration/profile/source, bounds, terminal evidence, purge, RLS, and no grants; Ruff, Pyright, diff and budget checks pass.
- Independent exact-SHA review before PR. No merge, migration apply, deploy, or activation.
