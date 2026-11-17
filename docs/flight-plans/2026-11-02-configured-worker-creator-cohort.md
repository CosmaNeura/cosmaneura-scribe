# Configured worker creator-edit cohort boundary

Tier 2. Source-only correction on main
`091ef7135329b5b891bbc973420eb009c54f3506`; no database or app is changed.
The original bootstrap is the merged PR522 source. Its existing configured
worker grants permit both workers to read `creator_transcript_edits`, but its
restrictive cohort policy lists omit that table.

Add the table to the shared policy list. Both existing worker roles retain
their grants and mode/status restrictions; each receives its own restrictive
tenant predicate on creator edits. The existing `tenant_isolation` policy is
untouched. No runtime grant or runtime-wide SQL cohort fence is added.

The source-only emitted-SQL check executes the real selected grant functions
without importing the application, connecting a database, loading conftest or
reading credentials. It proves the old source lacks the two required policy
pairs, the new source emits them, all prior grant SQL and mode/status fences are
preserved, and disabled configured permissions emit nothing. This is not proof
of actual effective PostgreSQL rights or worker readiness.

The previous production schema06 execution failed with possible partial SQL
commits. It supplies no accepted schema0024/three-role/rights result, and it
explicitly held configured worker grants with no configured tenant. Neither
replaying bootstrap nor adopting an equal migration head is authorized.

Before any operational reconciliation, independently accept a fresh actual
catalog receipt and classify exact present/missing schema and role state.
Pin this new source separately from main091/PR522 and the running dark image22,
whose bootstrap remains off. A future exact manual reconciliation may apply
these corrected restrictive policies only after source review and a new owner
decision; a future library merge/build/rollout is a separate coherence step.

The operational repair must retain the actual owner, exact three Entra role
identities and existing Core user/data access; reject unsafe ownership,
memberships, PUBLIC/default ACLs, unknown objects and structural drift. Repair
only independently qualified missing revisions/roles and explicit selected
worker rights. Check the original schema/role fingerprint before writes and
stop on partial/unknown state rather than infer successful adoption.

The initial selected cohort is only
`c2aaa4ae-404c-4e95-8330-4d2e12976aec`. Any future accepted final schema-rights
wrapper must bind the actual closed SQL/postflight result and independent
adjusted-rights review before setting
`actualSQLResultAndRightsIndependentlyAccepted=true` with that exact tenant.
The structural-only body7258 and a source planner cannot supply that wrapper.

Recovery keeps additive schema/evidence dormant and stops on uncertain writes;
it does not remove data, disable RLS or automatically retry a consumed operation.
No source publication, database permission, migration, hosting or runtime
activation is authorized by this source correction.
