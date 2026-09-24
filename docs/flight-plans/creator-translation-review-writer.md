# Flight plan: dormant creator translation-review writer

## Outcome and boundary

- Outcome: persist one Core-reauthorized creator decision and canonically replace its English
  working projection in one fenced transaction.
- Exact base: `79431d731245d291c7a311bc6fce2bd35a9929b4`; synthetic memory and disposable PostgreSQL only.
- In scope: protected command/receipt/errors, exact Core review identity/time/actor, creator and
  lineage checks, replay/conflict, review insertion, audit, same-transaction projection, rollback,
  concurrency, expiry, purge, and security tests.
- Out of scope: routes/OpenAPI, migrations, grants/roles/settings, authorization endpoints,
  provider/worker/client calls, deployment, migration apply, and activation.

## Implementation and verification

1. Require an existing current `review_required` projection and a Core-reserved review identity;
   accept authority fields only from a future verified, freshly reauthorized Core wrapper, which
   must durably reuse the entire command across ambiguous retries.
2. Lock consent before session, check creator before evidence lookup, and validate current source,
   exact latest successful unreviewed translation, Core review chronology, retention, and purge.
3. Converge exact replay without new rows, reject conflicting tenant-wide identity reuse, and map
   same-session competing decisions and cross-session UUID races to bounded errors.
4. Insert review and metadata-only audit, invoke the canonical projector in the same transaction,
   enforce accepted/rejected postconditions, and roll back the complete operation on failure.
5. Prove memory/PostgreSQL parity, partial/final multi-Spanish review, rejection-to-retry, replay
   after later state, creator mismatch, stale/failed evidence, concurrency, commit-time expiry,
   purge, PHI-safe errors, and continued absence of routes, grants, or migrations.

## Promotion and recovery

Stop by leaving the method uncalled; no deployed role can reach the derived tables. Recovery rolls
back the caller transaction or stops a future caller while retaining the dormant additive schema.
Before activation, land a transaction-owning bounded-error wrapper with verified tenant and actor,
practice/session authorization, correction-safe trigger/receiver changes, least-privilege grants,
and the accepted synthetic end-to-end review evidence. No provider, capture, or translation-worker
principal receives review authority.
