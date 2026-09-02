# Flight plan: dormant derived-writer database authority

## Outcome and boundary

- Outcome: define a false-default, least-privilege database split for source correction, creator review, translation attempts, and same-transaction working projections.
- Exact base: PR #87 commit `18d9c161ceab3d8aeb8f5b8fbd7499b0c3afe373`.
- In scope: translation-principal settings, fail-closed validation, revoke-first grants, disabled convergence, exact ACL/role tests, and docs.
- Out of scope: live identity/infrastructure/environment, routes/OpenAPI, Core/client callers, provider calls, migration/apply, deployment, enrollment, and activation.

## Principal split

| Capability | API runtime | Translation role | Transcription/reconciler |
|---|---:|---:|---:|
| Correct source working pointer | Yes | No | No change |
| Insert translation attempt | No | Yes | No |
| Insert creator review | Yes | No | No |
| Insert canonical working projection | Yes | Yes | No |
| Update/delete immutable evidence | No | No | No |
| Cross-tenant access | No | No | No |

Both writers receive only required source/evidence/session reads. Neither receives routine execution, sequence usage, schema creation, database temporary access, or unrelated product access.

## Implementation sequence

1. Add a false-default gate and complete/distinct translation-principal pair.
2. Reject replication, role membership, or ownership that could bypass ACL convergence.
3. Preserve the disabled runtime baseline; when enabled, add review/projector/correction authority but never translation-attempt insertion.
4. Revoke all translation capability on every bootstrap. In the same transaction, replace its UUID-derived restrictive policy for contract `1.0` external rows in translation/review/ready states, retaining unrelated/retired policies; grant the attempt/projector set only when enabled.
5. Prove idempotent grants, then disable and rerun with identity metadata retained to prove baseline/zero-authority recovery.

## Verification and abort conditions

- Inspect direct ACLs and effective privileges; seed stale rights and prove revoke-first removal.
- Exercise both writers under exact roles and forced RLS, including triggers with routine `EXECUTE` revoked.
- Prove translation cannot see/update legacy sessions or move a ready row to handoff.
- Prove opposite writes and cross-tenant writes fail, wrong-tenant reads are empty, and immutable/future-object rights remain absent.
- Prove transcription/reconciler snapshots unchanged; run all tests, Ruff, Pyright, budget, CI, and exact-SHA review. Abort on extra authority or scope.

## Recovery and next gate

Keep callers disabled. Set the gate false while retaining translation identity metadata, rerun bootstrap, and verify runtime baseline plus zero translation capability. For rotation/decommission, revoke and verify the old role first, then drop its policy and role. Any failure blocks activation until reconciliation succeeds.

No live grant or identity change is authorized. The next gate requires separate approval for identity/infrastructure, a pinned `pg_catalog, public` worker search path, environment configuration, bootstrap execution, Core authorization/caller work, and synthetic acceptance.
