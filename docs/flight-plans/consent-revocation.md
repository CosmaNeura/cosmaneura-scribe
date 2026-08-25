# Flight plan: atomic consent revocation

## Outcome and boundaries

- Problem and measurable outcome: Scribe records consent but has no callable
  revocation transition. Add a tenant-hidden, idempotent endpoint that preserves
  the first revocation timestamp, closes every active capture lease, writes one
  metadata-only audit event, and prevents new session, capture, transcript,
  direct delivery, and transcription-worker requests from starting effectful
  work. A reconciler may claim an existing delivery receipt only to terminalize
  it without network egress.
- In scope: API contract, repository implementations, PostgreSQL lock ordering,
  runtime database privilege, generated client contract, and acceptance tests.
- Explicit non-goals: deployment, UI wiring, schema changes, cancelling an
  already-claimed STT or delivery call, or retracting an already-issued storage
  upload URL.
- Affected surfaces: the Scribe API and worker; consent and metadata-only audit
  state. Test data is synthetic and contains no PHI.

## Risk and dependencies

- Tier: Tier 2 because consent is a patient-processing security boundary.
- Irreversible decision: `revoked_at` is monotonic. This slice deliberately has
  no restore/unrevoke operation.
- This is one independently deployable safety slice and can remain unmerged or
  undeployed without activating partially wired behavior.
- Cross-repo ordering: N/A; the endpoint is additive and no caller is activated.

## Current deployed state

- The deployed dev revision is known to trail `main`; this PR authorizes no
  deployment and does not claim the live SHA is reconciled.
- Current behavior records consent but exposes no revocation transition.
- Reconciliation decision: before any environment promotion, record its exact
  SHA/configuration and choose retain, assimilate, or replace deliberately.
- Previous known-good artifact: unchanged because this PR does not build or
  promote a release artifact.

## Conditional controls

- Feature flag: N/A. Consent enforcement is a safety invariant, not reversible
  user-visible behavior.
- Schema/data sequence and PHI-safe rehearsal: N/A. The existing nullable
  `revoked_at`, lease, and audit structures are used without a migration or
  backfill. PostgreSQL acceptance tests use synthetic data.

## Rollout and promotion

1. Merge only after the full PostgreSQL suite, static checks, generated-contract
   parity, and independent review pass on the final commit.
2. Keep production/PHI promotion blocked until deployed-state reconciliation
   and a separate founder-authorized release decision.
3. In a dark non-PHI environment, create synthetic consent and a lease; revoke
   once and replay it; verify one timestamp, one audit event, closed leases, and
   consent-specific refusal of every downstream API/worker path.
- Abort on post-revocation external egress or a new transcription job, a changed
  replay timestamp, duplicate audit, open active lease, cross-tenant disclosure,
  or deadlock.

## Security and recovery

- A committed transcription/delivery claim is the in-flight boundary. Work
  already claimed may finish. Later transcription work and external delivery
  egress are refused; a reconciler may claim an existing receipt only to mark it
  terminal without egress. Immediate cancellation requires a separate
  provider-aware design.
- An issued storage authorization remains usable until its short expiry. API
  registration and new authorization stop immediately; capability invalidation
  is separate work.
- Recovery for faulty endpoint behavior is to revert the callable route and
  implementation through review. Never clear `revoked_at` or reopen leases.
- Observe revocation latency, consent-specific refusals, deadlock/lock-wait
  signals, audit cardinality, and orphan-upload cleanup before wider use.

## Completion

- The final commit has exact-commit independent review and green CI.
- Production promotion remains a separate founder-only decision with a recorded
  live-state reconciliation and synthetic canary result.
- Follow-ups: design immediate cancellation for in-flight external work and a
  bounded response to still-valid upload capabilities.
