# Existing Core logical Scribe database — Tier 2

The three-container bundle needs an isolated `cosmaneura_scribe` database on
the existing `cosmaneura-prod-postgres` server. Previously the database resource
was reachable only by selecting a dedicated PostgreSQL foundation or the
obsolete standalone app/job reuse topology. This leaf adds a false-default
`prepare_production_core_bundle_database` selector that reaches only the
existing `azurerm_postgresql_flexible_server_database.scribe[0]` address.

The selector fixes the existing server resource ID and FQDN, requires the exact
production foundation and isolated database name, and retains the already-owned
resource group with `create_resource_group=true`. The one-database saved-plan
guard requires that group to remain no-op; this setting does not authorize a new
group create. Withdrawing its ownership would propose deletion of the existing
foundation, so the database leaf refuses that selection. It refuses dedicated-server,
app, job, repository, capture and runtime activation selectors. It changes no
identity/grant/admin/job count. Existing approved preparation settings can remain
selected so protected state inputs do not accidentally delete an owned identity
or restore/revoke a prior grant. The false default preserves both earlier
database modes and their existing selectors. The database keeps `prevent_destroy`.

## Observed state and reconciliation

The qualified metadata observation at 2026-10-31T08:48:06Z used the existing
production Core web revision `r40596470599a1-7953980`, configured image commit
`7953980159bd6ce69cfbd75fe5bc5d4aee83de4e`. Its receipt SHA-256 is
`735f650ec99b588d5f3324eba2f1f1086872b342dcacaac1e42515a3bddb7800`.
The exact before/after target was unchanged; five metadata SELECTs ran in a
read-only transaction. PostgreSQL reported 16.15, Core `production` reported
head `a659469204e2`, and the separate logical Scribe database did not exist.
Only the thirteen sampled `zoom_capture_binding` columns were missing, with no
sampled nullability mismatch. Missing columns do not establish table absence.
The configured image is not an attestation of loaded image contents.

Retain the existing Core server and business database. Prepare only the absent
logical Scribe database. Do not import/adopt an unexpected existing database.
Fresh absence, server, state-owner and protected-input reconciliation must occur
before a saved plan. A stale observation or plan is insufficient for apply.
The starting source pair is Core `c4e47f3b61f679ba2f31586f9feb07a49a0d80f2`
and Scribe `a327135743bd65f552dd2f9878c088fbde6c7492`; a later source/artifact
pair requires a fresh exact binding before any operational step.

## One-database plan and owner decision

No live plan, apply, SQL, configuration or identity change is authorized by this
source PR. Preserve the actual foundation's protected inputs, approved key
custody and preparation selectors, resource attributes and state ownership.
Do not force other inputs false merely to manufacture a one-create plan, and
do not use Terraform targeting to hide collateral changes.

A founder-selected saved full plan must contain exactly one managed create:
`azurerm_postgresql_flexible_server_database.scribe[0]`, name
`cosmaneura_scribe`, UTF8, collation `en_US.utf8`, parent
`/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres`.
All existing managed resources must be no-op. Reject any other create, update,
delete, replacement, import, move, unknown required database field, deferred
change or unreconciled resource drift. Read-only data-source lookups are allowed.

`tools/production/verify_core_bundle_database_plan.py` checks the exported saved
plan locally and emits fixed metadata only. It neither authenticates nor runs
Terraform/SQL. Its success is scope validation, not approval, state freshness,
server authorization, absence proof, role/schema readiness or production release.
The saved plan, export, exact source, provider locks, protected-input identity and
fresh preflight receipt must be bound before the reserved owner apply decision.

If the already-created migration identity and AcrPull assignment are absent from
state, prepare their separate full import-only saved plan before selecting the
database. Retain the actual owned group, key custody and migration preparation
inputs. `retained_production_migration_registry_scope=null` keeps the existing
scope selector. A protected explicit selection retains the live ARM scope's
literal case only after comparison against the case-insensitively identical
fixed owned registry and its actual resource ID. It never suppresses a diff,
ignores changes, widens scope or approves replacement. The full preview must show
two imports with zero resource creates/updates/deletes/replacements; any existing
writer address move and refreshed-state differences require explicit separate
owner disposition. Preserve the initial failed replacement preview as evidence.

## Separate schema and principal rungs

Ordinary Core uses only the direct additive `3d40e4e90e05` migration over the
observed `a659469204e2` head. Before using the existing manual migration executor,
require current database `production`, exactly that single previous head, no
`public.zoom_capture_binding` relation of any kind, expected parent key types
and the existing migration actor's required CREATE/REFERENCES rights. Abort on
any existing target, unexpected head or unqualified executor. Upgrade only to
the explicit `3d40e4e90e05` target with bounded timeouts and one transaction;
no business-row backfill, old-table change or runtime DDL permission is included.
The absent `AUTO_MIGRATE_ON_STARTUP` environment setting does not qualify the
effective source default; explicit false on all three Core hosts is a separate
configuration prerequisite before image promotion. Do not run `infra/deploy.sh`
as a migration shortcut: it also changes configuration and deployment state.

The Scribe database remains empty until its separately reviewed bootstrap rung.
That rung must bind the existing migration identity's actual object/client IDs,
Core-owned additive Entra/password-preserving settings and temporary migration
administrator, then create only the three exact runtime principals and the
25-revision empty-database schema through Scribe head `0024`. It must retain
tenant/RLS boundaries, deny ownership/broad privileges and keep configured
worker grants/cohort activation off until separately selected. It copies no
Core business tables, patients, notes, recordings or transcript data. Temporary
administrator removal and effective permission verification precede canary use.

The existing `cosmaneura-prod-migrate` manual job is preferred only after its
actual template, identity, command, image and permissions are qualified. The
paired runtime package is not yet a migration artifact: Scribe `migrations.py`
uses `Config("alembic.ini")`, whose script path is relative `alembic`, while the
bundle retains Core's working directory. Bootstrap therefore requires an exact
qualified Scribe migration-assets/working-directory route; replacing the job's
module name alone is insufficient. This leaf creates no new executor or job
and does not claim that route is operationally available.

## Recovery and validation

Before apply, discard the plan or leave the selector false. After an approved
database create, preserve the selector and database state address; setting it
false would propose destruction, which `prevent_destroy` refuses. Keep the
empty database dormant and withdraw runtime admission instead. After any
partial schema/role commit, preserve the structures and inspect the exact
metadata before an owner-reviewed forward repair; do not drop the database,
downgrade, restore broad grants or reattach the administrator automatically.
Likewise, preserve the dormant Core expand table after a committed migration.

Validation uses secretless provider-mocked plans with backend disabled and the
pure saved-plan guard's unit cases. These qualify source selection and plan
limits. They are not PostgreSQL migration rehearsals or live readiness. The
ordinary Core additive rung and Scribe empty-schema/role/configured-grant
rehearsals, existing executor qualification and owner live decisions remain
separate gates. No production activation is implied by this source completion.
