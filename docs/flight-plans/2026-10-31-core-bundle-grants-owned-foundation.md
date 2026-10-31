# Core bundle grants retain the owned foundation — Tier 2

Selecting the grants or routing rung previously required
`create_resource_group=false` and
`prepare_production_database_migration_identity=false`. The actual production
foundation already manages the resource group, migration identity and its
registry AcrPull assignment. Satisfying those validators would withdraw their
resource counts and propose deleting owned resources.

The closed existing-production grant/routing contract now requires both
ownership selectors to stay true. The foundation resource group stays managed;
the migration identity and registry grant remain selected. The identity selector
still refuses a migration job, administrator, database/server topology and
runtime activation. Default grant, routing and capture flags remain false.
No role definition, principal, grant scope, network rule, key custody or runtime
permission is widened by this source correction. The explicit broad translation
Blob-writer removal remains required before preparing the scoped grants.

## Execution and recovery

Source selection does not authorize an apply. First reconcile the already-created
migration identity and AcrPull into the reviewed Scribe state. Preserve actual
protected inputs, `enable_production_arm_audio_key_bootstrap=true`, the retained
migration registry scope, and any already-selected logical database. Bind the
fresh merged source, owner decision, identities, state and saved full plan.
Reject any foundation, migration-identity, registry-scope or key-custody change;
no Terraform targeting or ignored drift may manufacture an IAM-only plan.
The selected IAM rung permits only its reviewed nine new role/custom-role objects
and deletion of the owned broad Blob writer. A later routing rung adds only the
separately reviewed network changes. Neither rung runs an app or migration.

Before apply, leave the flags false. After scoped grants are applied, retain the
owned foundation selectors. Recovery may withdraw new scoped rights only under
an exact owner plan; it keeps the broad writer removed and never deletes the
foundation, migration identity, database, key or retained data. Flags do not
roll back infrastructure or permissions. Production canary/activation remains
separate.

## Validation

The exact locked-provider, backend-disabled plan suite covers ownership
preservation, either ownership-withdrawal rejection, ARM key custody, retained
registry spelling, least privilege and the existing network/activation refusals.
All 16 plan-only cases pass. An exploratory provider-mocked owned-state baseline
also produced a selected IAM plan with 29 managed no-ops, nine grant/custom-role
creates, no updates and exactly one deletion: the owned broad Blob writer. The
resource group, migration identity, AcrPull assignment and ARM key have identical
before/after values. That whole exploratory suite failed later on an earlier
negative-case validator and mock cleanup of a `prevent_destroy` key; its partial
proof and failure remain retained. Production lifecycle controls were not changed.
Final plan-only checks do not create state or cloud resources. Neither local
provider-mocked result qualifies live Azure access or production readiness.
