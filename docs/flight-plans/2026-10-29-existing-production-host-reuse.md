# Flight plan: reuse existing production hosting for dormant Scribe workloads

## Outcome and current authority

Prepare a source-only, false-default alternative that reuses existing paid Azure
capacity. This plan authorizes local source and validation only. It does not
authorize an Azure plan/apply, database creation, identity or role change, image
publication, migration execution, application activation, or production traffic.

The current central architecture selects a separate parallel VNet-integrated
Container Apps environment for production Scribe connectivity. A central ADR
amendment or explicit supersession is required before this candidate can merge
or activate; owner direction authorizes preparation, not an undocumented policy
rewrite.

Exact Scribe base: `79d4b3dfa5442a417328f316f5bf58c63d77e8bc`.

## Reviewed existing resources

- Container Apps environment:
  `/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.App/managedEnvironments/cosmaneura-prod-app-environment`
- Environment domain: `lemonsmoke-1009414c.northcentralus.azurecontainerapps.io`
- Environment outbound IPv4: `64.236.176.41`
- PostgreSQL server:
  `/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.DBforPostgreSQL/flexibleServers/cosmaneura-prod-postgres`
- PostgreSQL FQDN: `cosmaneura-prod-postgres.postgres.database.azure.com`
- Existing Scribe/Core receiver identity:
  `/subscriptions/bab2a709-1fcb-4c87-a9fc-802f7477ec13/resourceGroups/cosmaneura-prod/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cosmaneura-prod-scribe-workflow`
- Isolated database to add later: `cosmaneura_scribe`.

Read-only inventory on 2026-10-29 also found an existing production S0
`AIServices` account, `cosmaneuraprodopenai` in East US 2, whose control-plane
capabilities include `realtimeTranscription=true`. Its public network is enabled,
local auth is not disabled, and it has no network ACL. It is a reuse candidate,
not an accepted Speech binding: the current Scribe adapter requires a managed
identity plus an exact private endpoint/CIDR, and the reused non-VNet environment
cannot reach the existing private Scribe boundary. Re-read and independently
qualify that account before proposing either adapter/network changes or any new
Speech resource.

The existing server is PostgreSQL 16, Standard B1ms, 2 GiB memory, 32 GiB
storage, public-network/password authentication enabled, Entra disabled, and has
the Container Apps environment's exact outbound IPv4 allowlisted. Existing Core
authentication and databases must remain usable.

A read-only 30-minute baseline on 2026-10-29 observed 11.6–14.5% average CPU
(24.75% maximum), 60.3–61.5% average memory (61.96% maximum), and 18–20
connections. This supports preparing the two-connection/zero-overflow dark
configuration; it is not load qualification or activation evidence.

## Source sequence

1. Add `deploy_production_existing_host_reuse=false` and exact selectors. Reject
   simultaneous dedicated-edge use, mutable images, shared database names, or
   any behavior/processing/network activation.
2. Place separate Scribe API, receiver, and migration-job resources in the exact
   existing environment. Keep API and receiver at minimum scale zero; keep API
   internal and receiver disabled.
3. Create only the `cosmaneura_scribe` database on the exact existing server.
   Preserve the dedicated/private server path unchanged.
4. Cap API PostgreSQL use at pool size two and zero overflow.
5. In a separate Core-owned change, enable PostgreSQL Entra authentication while
   retaining password authentication and register only the Scribe migration UAMI
   as Entra administrator. Do not change existing firewall rules or credentials.

## Required pre-apply gates

1. Merge independently reviewed Scribe and Core source with all reuse/activation
   variables false.
2. Re-read live resource IDs, domain, egress IP, PostgreSQL version/SKU/auth,
   firewall, existing databases, and Scribe foundation state.
3. Inventory existing production Azure Speech/AI resources and prove whether
   they satisfy Scribe's service/region/private-access requirements. Do not create
   another service merely because the dark source supports one.
4. Produce an exact saved production plan. It may add only the isolated database,
   one migration identity/ACR pull role, one manual migration job, and two dark
   Scribe apps. Any paid server/environment, deletion, replacement, Core app
   change, public storage/Key Vault change, or activation is an abort condition.
5. Independently review immutable API/receiver images and the exact plan. Obtain
   separate authorization before apply.

## Apply and activation remain separate

After a separately authorized dark apply, execute the migration only after the
Core Entra-auth delta is live and exact identity/admin bindings are verified.
Activation is a later change: the reused environment currently has no VNet and
cannot reach the private Scribe Blob/Key Vault endpoints. No public-network
opening or activation-network change is included here. Speech, capture, handoff,
receiver, encounter creation, processing, and traffic remain off.

## Recovery

Before activation, recovery is scale zero and disabled gates. If dark resources
must be removed, preserve `cosmaneura_scribe` and remove only the new Scribe
apps/job/role after a reviewed plan. Never delete or replace the shared Core
server/environment, existing databases, password auth, or applied private Scribe
foundation. Re-select the unchanged dedicated/private path if later approved.
