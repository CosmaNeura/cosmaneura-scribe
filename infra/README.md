# Scribe Azure infrastructure

OpenTofu/Terraform baseline for private audio custody. It intentionally creates no credentials and
accepts no secret values. Local runs authenticate through Azure CLI; GitHub runs use OIDC.

Read [`../docs/AZURE_ONBOARDING.md`](../docs/AZURE_ONBOARDING.md) before initialization.

Do not apply this configuration until the subscription has been inventoried and a reviewed plan
confirms there are no replacements. The canonical development subscription had no compatible East
US VNet or private DNS zones, so this configuration creates a dedicated network boundary for scribe.

```bash
cp backend.hcl.example backend.hcl
cp development.tfvars.example development.auto.tfvars
tofu init -backend-config=backend.hcl
tofu fmt -check -recursive
tofu validate
tofu plan
```

`backend.hcl` and `development.auto.tfvars` are local configuration and must remain uncommitted.

The deployed foundation provisions a dedicated East US VNet and private DNS, private Blob custody,
Key Vault, private endpoints, a runtime managed identity, and least-privilege data-plane roles.

The Container Apps slice adds a dedicated delegated subnet, ACR, Log Analytics, and an internal
workload-profile environment. Deployment is intentionally two-stage so Azure never receives a
reference to an image that does not yet exist:

1. Keep `deploy_container_app = false`, review and apply the foundation plan.
2. Build an immutable commit-tagged image without local Docker:

   ```bash
   az acr build \
     --registry <registry-name> \
     --image cosmaneura-scribe-api:<git-commit-sha> \
     --file Dockerfile \
     ..
   ```

3. Set the gitignored `container_image_tag` to that commit SHA and
   `deploy_container_app = true`; review and apply the second plan.

The API has VNet-only ingress and scales from zero to one replica. The currently deployed revision
still uses process memory. Durable PostgreSQL is implemented but is deliberately controlled by
three false-by-default flags:

```hcl
deploy_postgres_foundation    = false
deploy_database_migration_job = false
use_postgres_repository       = false
```

The PostgreSQL cutover is also staged so creation, schema bootstrap, and traffic are independently
reviewable:

1. Confirm subscription capacity in East US. Set only `deploy_postgres_foundation = true`, then
   review the paid-resource plan and apply it. This adds a delegated subnet, private DNS zone/link,
   PostgreSQL 16 Flexible Server (`B_Standard_B1ms`, 32 GiB), application database, migration
   managed identity, scoped ACR pull grant, and diagnostics. Password authentication and public
   network access remain disabled.
2. Build an immutable image from the persistence commit. Set its exact commit tag and enable only
   `deploy_database_migration_job`. Apply the job definition, start it manually once, and verify the
   successful execution. The migration identity creates the runtime Entra database principal,
   applies reversible Alembic migrations, and grants least privilege.
3. Set `use_postgres_repository = true`. Review the Container App revision plan, apply, and verify
   `/readyz`. Keep the prior revision available for rollback until the persistence smoke test passes.

No database password or token is a Terraform variable. See
[`../docs/POSTGRES_OPERATIONS.md`](../docs/POSTGRES_OPERATIONS.md) for the operational commands and
rollback boundary.

The 2026-08-13 preview is **9 to add, 0 to change, 0 to destroy**. Microsoft's East US retail
meters list B1ms compute at $0.017/hour and storage at $0.115/GB-month, approximately $16.09/month
for 730 compute hours and 32 GB. Backup above the included allowance, private DNS queries, and
diagnostic-log ingestion are usage-dependent and excluded from that estimate. Recheck pricing when
approval is requested.

As of 2026-08-13, this subscription is restricted from creating PostgreSQL Flexible Server in East
US and East US 2. Do not redirect the server to Central US without a separately reviewed
cross-region design; VNet-integrated Flexible Server must use networking in its own region.

The master-platform handoff is false by default. After the platform's Entra app role and workload
endpoint are configured, set `enable_master_platform_handoff`, `master_platform_base_url`, and
`master_platform_scope` as described in
[`../docs/MASTER_PLATFORM_HANDOFF.md`](../docs/MASTER_PLATFORM_HANDOFF.md). These are non-secret
identifiers; the runtime managed identity obtains the token.

Inbound workflow authentication is independently false by default. Configure the Scribe API app
registration and assign `Scribe.Workflow.Access` to the exact master-platform managed identity
before setting `enable_workflow_authentication = true`. The API then validates the token's issuer,
audience, tenant, app-only token type, caller client ID, and role before accepting `X-Tenant-ID`.
Health and readiness probes remain unauthenticated. See
[`../docs/PLATFORM_WORKFLOW_AUTH.md`](../docs/PLATFORM_WORKFLOW_AUTH.md).

Private connectivity to the platform is also independently false by default. Scribe owns only its
reverse peering and the link from its private Container Apps DNS zone to the platform VNet. The
platform owns the new VNet, environment, and opposite peering. Do not enable
`connect_parallel_platform_vnet` until the platform foundation exists and both plans have been
separately reviewed. The paired sequence and rollback boundaries are documented in the platform
repository's `docs/PLATFORM_SCRIBE_NETWORK_PLAN.md` and summarized in
[`../docs/PLATFORM_WORKFLOW_AUTH.md`](../docs/PLATFORM_WORKFLOW_AUTH.md).

Service Bus, CMK wiring, retention automation, and deployment identities follow in reviewed
slices.
