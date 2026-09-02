# Flight plan: dormant working-transcript projector/writer

## Outcome and boundary

- Outcome: an internal repository operation canonically projects the current persisted source and
  all persisted translation/review evidence into revision `0013` storage.
- Exact base: `ba070866ccf311cfc06535afdf892047623cbc96`; synthetic memory and disposable PostgreSQL
  validation only.
- In scope: internal types, consent-to-session locking, bounded evidence loading, deterministic
  projection/fingerprint, sealed writes, exact replay, concurrency, expiry, rollback, and purge.
- Out of scope: migrations, grants/roles, routes/OpenAPI, runtime settings, workers, adapters,
  clients, translation/review write APIs, handoff, deployment, apply, and activation.

## Implementation and verification

1. Lock consent, then the configured session; reject revoked, terminal, expired, purged, or
   source-less state.
2. Bound and load the current source's complete evidence set. Derive canonical content, blockers,
   state, and fingerprint with existing v1 functions.
3. On exact current-version replay, run the final database gate and return without a write.
4. Otherwise allocate the next version and write session pointer/status, evidence memberships,
   segments, blockers, and header in that order. Force deferred constraints and run the final gate.
5. Prove memory/PostgreSQL parity for publish, replay, rollback, expiry, and purge; prove complete
   pre-existing evidence, fingerprint inputs, concurrent convergence, evidence bounds, and PHI-safe
   errors. Keep runtime-grant tests explicitly negative.

## Activation dependency and recovery

Stop by leaving the internal method uncalled; the additive schema and immutable history remain.
The later least-privilege activation packet must grant a dedicated caller and simultaneously allow
source correction to clear only the current working version. It must then test translation/review
insertion plus replacement projection atomically, correction, expiry, purge, and terminal races.
