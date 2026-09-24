# Flight plan: dormant derived-writer transaction boundary

## Outcome and boundary

- Outcome: return translation-attempt and creator-review publications only after commit, with one
  exact-command reconciliation attempt for any raw database failure.
- Exact base: `5ae9117ea49e7ec01fa399ac777d5939242b3905`; synthetic memory and disposable PostgreSQL only.
- In scope: transaction ownership, one database-only retry, replay convergence, bounded unknown
  outcome, exception-chain sanitization, and current-state error preservation.
- Out of scope: routes/OpenAPI, authentication implementation, `service_auth.py`, grants, roles,
  settings, migrations, workers, clients, translation-provider or other network calls, deployment,
  and activation.

## Implementation and verification

1. Open the provider transaction inside each public internal wrapper and retain the publication
   until its context exits successfully.
2. Retry only `DBAPIError`, exactly once, in a fresh transaction with the identical tenant,
   session, and frozen command object. Never rerun external work or regenerate any command field.
3. Resolve a retry only with a non-empty committed publication. Map a second database failure or
   empty reconciliation result to chain-free `derived_writer_commit_outcome_unknown`.
4. Pass existing bounded writer codes through without retry, rebuilding the exception after its
   handler so no raw database cause/context survives. A bounded retry result describes current
   state after ambiguity; it does not establish the original commit outcome.
5. Prove memory/PostgreSQL success and replay for both writers, rollback recovery, lost commit
   acknowledgement without duplicate evidence/audit/projection, real deferred expiry mapping for
   both public wrapper paths, cancellation behavior, safe errors, and continued dormancy.

## Future auth and activation sequence

1. A Core caller authenticates with the existing Clerk path, freshly authorizes the actual
   provider for practice/session/creator, and denies view-as.
2. Core sends the already durable command to Scribe over the existing Entra workload path. Scribe
   uses verified tenant context and compares the stable actor with the immutable creator; Entra
   client identity is never treated as clinician identity.
3. The future endpoint injects the provider directly and calls this wrapper as the sole transaction
   owner; it does not nest the wrapper under a request-scoped repository transaction.
4. The endpoint requires `Idempotency-Key` bound to the durable command and claims/replays it in the
   same owned transaction, avoiding a split pre/post transaction. No third auth path is introduced.
5. Add metadata-only retry/unknown-outcome telemetry using allowed tenant, session, and command IDs;
   never emit transcript content, SQL, driver details, or bound values.
6. Only after correction-safe trigger/receiver work, least-privilege grants, and approved synthetic
   end-to-end evidence may a separate packet consider activation. ADR 0029/0030 adapter,
   model-profile, retention-policy, and concurrency gates also remain in force.

## Recovery

Stop before adding any caller. The functions are dormant and the packet changes no database or
runtime configuration. If a future caller receives unknown outcome, retain the command, stop
external side effects, and reconcile by durable identity; do not synthesize a replacement command.
