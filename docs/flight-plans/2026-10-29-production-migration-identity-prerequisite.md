# Production migration identity prerequisite

## Outcome and scope

Prepare the existing `database_migrations` identity and its Scribe-registry
`AcrPull` grant before Core can bind that identity as its production PostgreSQL
Entra administrator. The existing `production_database_enabled` gate also
creates the database, so it cannot safely serve as this prerequisite rung.

This Tier 2 source change adds one false-default, production-only preparation
control and extends the exact existing-host binding validation to it. Only the
two existing identity/registry-role counts change. Names, fields, scopes and
the later database/job contract remain unchanged. Preparation rejects all
database, workload, processing, network and capture activation controls.

No database, PostgreSQL administrator, job, app, network, runtime, cohort,
capture permission, schema or data is created by the new control. Registry
Pull does not publish an image or start a workload. Production apply remains
a separate founder decision; hashes, populated bindings and plans are evidence,
not authorization.

## Deployed reconciliation and sequence

The October 29 read-only baseline has 26 foundation resources, with the
migration identity absent. Core PostgreSQL retains password authentication
and has Entra authentication disabled. The already prepared wrapping-key and
Reader plan is a separate, unapplied security decision. Preserve that packet,
current hosting/server/password/firewalls, and all other Core work.

1. Independently review this final source and its focused mock-provider tests.
2. Prepare a real, refreshed plan from the actual foundation state without
   targets, state editing or credential-manager reads. While the separate key
   rung remains unapplied, the honest preparatory plan includes its two
   existing key/Reader creates plus this rung's two identity/Pull creates,
   with all 26 foundation resources unchanged. This is not combined apply
   authority and does not satisfy the isolated identity apply gate.
3. If the separately reviewed key rung is approved and applied, regenerate
   this rung's plan against then-current merged source and full actual state.
   Require exactly the migration identity and registry Pull creates, with
   all 28 existing resources unchanged and no update/delete/replacement.
   Any state or source drift invalidates a retained plan.
4. A separate founder decision may apply that isolated saved plan. Do not
   invoke a migration or grant database permissions in this step.
5. Read the actual migration identity IDs after creation. Only then can the
   canonical Core-owner plan enable Entra while preserving password auth and
   bind that exact identity as administrator. Do not guess binding IDs.
6. Database/job provisioning, bootstrap, runtime authorization and production
   traffic remain later, independently reviewed and approved rungs.

Source reconciliation retains the deployed foundation and adds dormant
prerequisite preparation. The source gate is not infrastructure rollback.
Before apply, recovery is to discard the candidate plan or revert this source.
After apply, leave the idle identity/Pull grant in place while withholding
Core administrator binding and job deployment. Removing identity/permissions
requires its own reviewed full-state plan after confirming no consumers.

## Acceptance and hold conditions

- False-default preparation produces no migration identity or Pull grant.
- Enabled preparation preserves the exact existing identity name, foundation
  resource group and registry-only scope; all workload/database/network
  resources and capture permissions remain absent.
- Nonproduction, missing/incorrect host binding and mixed activation fail.
- Existing dark-reuse and wrapping-key tests continue to pass.
- Actual plan evidence records source/tree/provider lock hashes, state
  lineage/serial/full-resource hash, and full action partition. Raw state,
  plan JSON, binary and provider logs remain protected; emit only metadata.
- Abort on unknown/missing plan fields, drift, any other action, changed
  identity/role scope, extra permissions, state mutation, credentials or
  misleading acceptance. A four-create preparation is not a two-create PASS.

Independent review after the final substantive push is required. Agents do
not deploy production or dispatch production workflows. No schema migration,
user-visible rollout flag, patient data or PHI is involved in this source rung.
