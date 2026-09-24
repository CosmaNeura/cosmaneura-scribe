# ADR 0030: Add a dormant creator translation-review writer

**Status:** Accepted for dormant synthetic implementation

## Context

The derived-evidence and working-transcript expansions can retain immutable creator review
evidence, but no repository operation safely writes it. A review insert alone is invalid: the
session, consent, creator, source, attempt, retention, and current projection must agree, and the
new review must be included in a replacement working transcript before commit.

ADR 0026 defines the review UUID, reviewer actor, and offset-aware review time as Core-issued
evidence. This writer preserves that contract. It does not substitute a client timestamp or a
database receipt time: a future trusted Core wrapper constructs all three fields after fresh
reauthorization, and persistence rejects a review time before the selected translation attempt.

## Decision

Add one protected internal operation that records an `accepted` or `rejected` decision and
publishes the canonical replacement working transcript in the same caller-owned transaction. The
command pins the current source version, exact Spanish source segment, exact latest successful
translation, Core-reserved review UUID, verified normalized creator actor, and Core review time.
The command is not a transport model and must never be populated directly from request JSON.

Persistence takes the consent advisory lock before the configured-session row lock, revalidates
consent and live retention, and checks the supplied actor against the locked immutable session
creator before reading review identity or evidence. That equality is evidence binding, not
authentication: a future transaction-owning Core wrapper must derive tenant and actor from verified
request context, freshly reauthorize practice/session access, and ensure capture, provider,
translation-worker, and other principals cannot invoke the review operation.

An exact tenant-wide review-ID replay is resolved before the new-write status gate. Exact means the
same session, current source, segment, translation, decision, actor, and review time. It inserts no
row, audit, or projection version and returns the immutable old receipt with the current working
projection. Any other reuse is an identity conflict. A new review requires `review_required`, the
exact latest successful unreviewed translation, and no accepted review for that source. One
terminal review exists per translation.

After inserting one immutable review and metadata-only audit, the writer invokes the existing
canonical projector in the same transaction and requires `REPLACED`. Accepted decisions must end
in `review_required` or `transcript_ready`; rejected decisions must end in `translation_pending`.
The PostgreSQL savepoint maps tenant-wide UUID races and competing terminal decisions to bounded
errors. The projector forces the relevant deferred constraints and rearms the exact-state session
commit fence for post-return expiry/state protection. Any insert, audit, projection, postcondition,
or commit failure rolls back the review and projection.

## Consequences

- Accepted translations can become the English working transcript; rejection returns that source
  to translation retry. With multiple Spanish segments, one rejection blocks further review until
  the rejected segment has a higher-version successful retry.
- The receipt preserves Core's immutable review time while reporting the current projection, so a
  late replay may report a later session state.
- The future Core wrapper must durably reserve and reuse the entire command (UUID, decision,
  lineage, actor, and review time) across retries. Regenerating any field after an ambiguous commit
  correctly becomes an identity conflict.
- The review UUID is persistence identity, not a waiver of the API mutation contract. Any future
  endpoint must also require `Idempotency-Key` or deliberately bind that header to the durable Core
  command. This packet creates no endpoint.
- The operation remains unreachable: this packet adds no route, OpenAPI contract, grant, role,
  worker, provider call, client, migration, deployment, or activation.
- A future transaction-owning wrapper must sanitize deferred commit errors. Activation also waits
  for least-privilege grants, correction-safe trigger/receiver changes, and approved non-PHI
  end-to-end evidence.
