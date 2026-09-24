# ADR 0031: Own and reconcile derived-writer transactions

**Status:** Accepted for dormant synthetic implementation

## Context

The translation-attempt and creator-review writers atomically replace the canonical working
transcript, but their repository methods run inside a caller-owned transaction. PostgreSQL can
reject a deferred retention or state fence when that outer transaction exits. A caller that
returns the repository receipt before exit can report work that ultimately rolled back. A raw
`DBAPIError` can also expose SQL or bound values, and a connection failure during commit can leave
the caller unable to tell whether the database committed the write.

The immutable writer commands already contain the identities, lineage, content or decision, and
timestamps required for exact replay. That makes one database-only reconciliation attempt safe;
rerunning translation or rebuilding either command does not.

## Decision

Add two internal transaction-owning functions, one for each derived writer. Each opens a fresh
`RepositoryProvider.transaction`, invokes only the matching repository operation, and releases a
publication only after the transaction context exits successfully. It does not catch cancellation
and does not retry bounded domain failures; it rebuilds bounded failures by code only to remove
exception chaining. `CancelledError` and other `BaseException` paths propagate immediately and are
never auto-retried. Because cancellation during provider exit can still leave commit outcome
ambiguous, later resumption must use the same durably retained command.

On the first SQLAlchemy `DBAPIError`, the wrapper opens exactly one fresh transaction and submits
the same tenant, session, and immutable command object. It does not mint an ID or timestamp, change
lineage or content, or call any translation, network, Core, or other external service. If the
first commit succeeded, repository replay returns the existing publication; if it rolled back,
the retry records the command. A retry publication is the only positive resolution of the
ambiguous write. A retry returning `None`, or a second `DBAPIError`, raises the bounded
`derived_writer_commit_outcome_unknown` error.

The boundary intentionally treats every `DBAPIError` conservatively. Non-DBAPI SQLAlchemy
exceptions and non-database exceptions are not masked. Existing bounded writer errors are
reconstructed from their enum code after leaving the exception handler, so raw database
cause/context is not retained. A bounded error on the first attempt is definitive current-state
rejection and is not retried. Per the adopted reconciliation contract, a bounded error on the
second attempt is also returned as the current-state result without another retry; after an
ambiguous first failure, it does not prove whether that first commit occurred. Callers must
reconcile durable state and must not repeat translation or regenerate command fields.

## Authorization boundary

This packet adds no authentication or authorization path. The future path remains two-stage:

1. Clerk/Core authenticates the actual provider, freshly reauthorizes practice, session, and
   immutable creator access, and denies view-as or impersonated review authority.
2. Core calls Scribe using the existing Entra workload identity. Scribe derives tenant from
   verified context and compares Core's stable actor identifier with the immutable session creator.

The Entra client ID identifies the calling workload, not the clinician. This is reuse of the
existing Clerk/Core and Entra boundaries, not a third login or auth path.

## Consequences

- A future caller must durably retain the complete immutable command before its first write and
  reuse it verbatim for reconciliation. In-memory reconstruction is insufficient after restart.
- A future mutating endpoint must still require `Idempotency-Key` and deliberately bind it to the
  durable command identity; a translation or review UUID does not replace the API contract. The
  future endpoint must claim/replay that key atomically inside this owned transaction (or formally
  redesign the contract), not in a separate pre/post transaction that recreates ambiguity.
- These functions are the top transaction boundary. A future caller must complete authentication
  and reauthorization first, inject the provider directly, and invoke a wrapper with no other
  repository transaction open. Nesting them under the current request-scoped repository dependency
  could split related writes or retain locks across the reconciliation transaction.
- `derived_writer_commit_outcome_unknown` is intentionally non-diagnostic. Operators use
  identifiers and metadata-only audit evidence, never transcript text, SQL, driver details, or
  bound values. Before activation, add metadata-only retry and unknown-outcome telemetry using only
  allowed tenant/session/command identifiers so the failure mode is operationally visible.
- This module remains unreachable. It adds no route, OpenAPI change, service-auth change, grant,
  migration, role, setting, worker, client, provider invocation, deployment, or activation.
- Activation still depends on correction-safe trigger/receiver changes, least-privilege grants,
  the Core reauthorization caller, approved translation adapter/model-profile and retention-policy
  decisions, upstream concurrency evidence, approved non-PHI end-to-end evidence, and every prior
  storage/writer gate in ADRs 0029 and 0030. This packet supersedes none of those gates.
