# MIGRATION_PLAYBOOK.md — Scribe schema and data ladder (v0.2.1)

This playbook applies only when a change alters Scribe schema or stored data.
Auth, consent, billing, transcript, or PHI code with no schema/data change may
still be Tier 2, but it does not invent a migration rung or rehearsal.

Scribe uses Alembic from the repository root; revisions live in
`alembic/versions/` and the tracked apply command is
`uv run alembic upgrade head`. This is not permission to run it against a live
environment. CI exercises disposable PostgreSQL, but there is no reviewed,
automated PHI-safe rehearsal job or runbook today. Until one exists and passes,
schema/data promotion to a PHI-bearing environment is blocked. The synthetic
capture-preview environment is not migration rehearsal evidence.

A rung is one independently deployable, observable, backward-compatible
transition. Each schema/data PR declares exactly one rung and may be held
indefinitely. Cross-repo rungs use versioned contracts and deploy receivers
before activating senders.

## The ladder

### 1. Expand

Add a nullable column, new table/index, new format, or other structure beside
the old one. Existing code ignores it and no user-visible behavior changes.

**Recovery:** stop the rollout and leave the additive structure dormant. Do
not drop it as rollback. Removal occurs only in a later, separately approved
destructive cleanup after evidence shows nothing reads or writes it.

### 2. Dual-write

Write old and new representations while reads remain on the old path. Track
per-record migration state where needed. Recovery stops the new write while
preserving compatible data.

### 3. Backfill / just-in-time migration

Backfill in bounded, resumable, idempotent batches with progress and mismatch
metrics. Where user presence or credentials are required, migrate only after a
successful old-path verification. Recovery pauses the worker; it does not
blindly reverse already verified records.

Choose and load-test the batch bound. Record the exact value and evidence in
the PR; there is no universal placeholder limit.

### 4. Shadow-verify

Run the new read/decision path without enforcing it, compare results, and
observe a predeclared zero-or-accepted mismatch threshold for a predeclared
period. This rung is mandatory for identity/auth data transitions.

### 5. Cut reads

Move reads to the new representation in explicit cohorts while retaining the
old compatible path. Use a feature flag only when the cut changes reversible
user-visible behavior. Recovery restores old reads.

### 6. Contract

After the flight plan's stability window and proof recovery was not needed,
stop compatibility writes in one PR. Removal of old code or schema is a
separate destructive PR with explicit founder approval. Contract cleanup is
irreversible and never bundled into an earlier rung.

## PHI-safe rehearsal

Rehearsal is required before a schema/data rung is promoted to a PHI-bearing
environment. A PR with no schema/data change marks it N/A.

Before any rehearsal, add a reviewed Scribe runbook containing exact commands,
identities, resource names, scrubber, verifier, and cleanup mechanism. Prove
non-destructive commands in a disposable non-production exercise and validate
deployment/destructive steps with a safe plan or dry run. Placeholders are not
authorization.

The rehearsal sequence fails closed:

1. Create a restore target in an already-enforced isolated network with public
   access denied at creation, unique least-privilege access, no application
   identities, and automatic TTL cleanup.
2. Independently verify isolation before restored data is accessible; abort
   and clean up if the check fails.
3. Restore through reviewed PITR automation. The copy remains production PHI
   until scrub verification succeeds.
4. Run the approved in-place scrubber immediately; emit counts/hashes only.
5. Verify every identified PHI-bearing field. Only a signed pass receipt may
   open access to migration and test identities.
6. Run the exact pending rung and representative tests; capture timings, row
   counts, invariants, and recovery results, then revoke access.
7. Execute pre-authorized TTL cleanup and verify deletion. On failure, alert
   the founder and keep the target isolated as production data.

Record the source recovery point (not data), target identifier, isolation
result, scrubber/verifier versions and receipt, migration SHA, test result,
duration versus RTO, cleanup result, and founder authorization. No PHI,
connection strings, secrets, or raw query output enters CI, PRs, artifacts, or
agent context.

## Hard rules

- One rung per schema/data PR; no cutover migration.
- Every rung has measured invariants, health signals, and recovery before merge.
- Backfills are bounded, resumable, idempotent, and observable.
- No `DROP`, rename, narrowing/type conversion, or destructive rewrite before
  separately approved contract cleanup.
- An expand rollback leaves structures dormant.
- Failed or unverifiable rehearsal blocks PHI-bearing promotion.
