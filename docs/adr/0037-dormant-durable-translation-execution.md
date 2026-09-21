# ADR 0037: Define a fail-closed durable translation execution lifecycle

**Status:** Accepted for dormant synthetic pre-integration

## Context

A completed translation command can be replayed safely through the existing idempotent database
writer, but retaining it only in process is insufficient. A crash after the provider returns and
before durable storage could cause a worker to call the provider again without knowing whether the
first call completed. The current provider-neutral adapter does not offer a provider-enforced
idempotency key, so exactly-once provider execution cannot honestly be claimed.

No production job-store schema, managed identity, provider SDK, or deployment may be introduced on
the pre-integration branch while the shared platform is stabilizing.

**Scoped amendment, 2026-09-21:** the owner subsequently approved a Scribe-only
encrypted job store and dormant additive migration, rehearsed only in a new
disposable local database. That approval supersedes the no-store/schema portion
above, not the cloud/shared-platform/runtime-activation boundaries. The concrete
design and recovery are recorded in ADR 0040 and the real-services flight plan.

## Decision

Define a dormant durable-store and worker contract with four monotonic states:

1. `reserved`: tenant, session, immutable translation identity, source lineage, and protected
   Spanish source are durably reserved before execution;
2. `provider_call_started`: an atomic claim records a unique call token and store-owned timestamp
   before protected text leaves the service;
3. `provider_result_stored`: the exact `CompletedTranslationJobV1` is durably retained before any
   database write; and
4. `attempt_committed`: the existing transaction-owning writer has accepted or replayed that exact
   completed command.

Only the worker that atomically moves `reserved` to `provider_call_started` may invoke the adapter.
Every record returned by the store is rechecked against the requested tenant, session, and
translation identity before a provider call. The returned provider result must match the claimed
scope and exact completed-job fingerprint.

The worker also pins the initially read reservation fingerprint and reservation
timestamp for the duration of each execution. Every later store response must
retain the same protected source content, source lineage and reservation time,
including a reload after losing a competing claim and the final commit marker.
A changed claim is rejected before any provider call; a changed result record is
rejected before the attempt writer. Errors contain only a fixed conflict code,
never the content or its fingerprint. This detects inconsistent store responses;
it does not authenticate the first read or replace encrypted storage and current
consent/source authorization at atomic call admission.

After `provider_result_stored`, any retry calls only the idempotent database writer and uses the
same completed command. A lost acknowledgement while marking the job committed also replays only
the writer. If execution is observed in `provider_call_started` without a stored result, the worker
does not call the provider again; it returns `provider_call_not_replayed` for explicit operational
resolution.

## Security and operational boundary

- A production store must encrypt reservation and result content at rest, authenticate it against
  tampering, enforce tenant scope, own lifecycle timestamps, apply the approved retention policy,
  and emit metadata-only audit/telemetry.
- Store operations must be atomic and exact reservation replay must never replace source lineage or
  protected content.
- The call token is internal execution fencing, not an authentication credential and not an API
  idempotency key.
- The current fail-closed ambiguity state can sacrifice automatic progress after a process crash;
  it prevents an unprovable automatic duplicate provider call. Provider-side idempotency may be
  evaluated later under a separate privacy and integration decision.
- The original contract packet added no store implementation, migration, table, queue,
  provider SDK/call, route, setting, secret, Auth/IAM change, environment action,
  deployment, or live processing.

## Consequences and next gates

Synthetic tests now prove initial execution, database failure recovery, lost commit-marker
recovery, ambiguous provider-result storage failure, already-committed replay, cross-tenant store
defense, and handoff to the existing derived writer. Activation still requires an approved
encrypted durable-store design and migration, constrained worker identity, bounded operational
handling for ambiguous provider outcomes, provider/model approval, and exact-artifact evidence.
