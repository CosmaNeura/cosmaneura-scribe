# Production Scribe environment plan

**Plan date:** 2026-08-14
**Approval state:** configuration prepared; no foundation, database, workload, or traffic approved

## Boundary

Production Scribe is a new East US deployment with its own resource group, Terraform state, VNet,
private endpoints, storage, Key Vault, ACR, Log Analytics workspace, Container Apps environment,
managed identities, and eventual PostgreSQL server. It does not reuse or rename development
resources.

| Environment | Resource group | State key | VNet |
| --- | --- | --- | --- |
| Development | `cosmaneura-scribe-development` | `cosmaneura-scribe/development.tfstate` | `10.42.0.0/16` |
| Production | `cosmaneura-scribe-production` | `cosmaneura-scribe/production.tfstate` | `10.44.0.0/16` |

The checked-in examples contain no credentials. Subscription and tenant IDs are identifiers, not
secrets, but local `.auto.tfvars` and backend files remain gitignored so operators do not normalize
placing environment configuration in source control.

## Current capacity boundary

The production configuration keeps all deployment flags false. The pending East US PostgreSQL
region-access request blocks the durable production runtime but does not block formatting,
validation, or foundation-plan review. Do not substitute another database region without a new
latency, residency, failover, and network review.

The proposed globally unique storage, Key Vault, and registry names were available on 2026-08-14.
Azure does not reserve names during a check, so availability must be repeated immediately before a
reviewed apply.

## Design-plan evidence

An isolated empty-state copy of this production configuration was planned on 2026-08-14 with every
deployment flag false and `-refresh=false`. The unsaved plan showed **23 add, 0 change, 0 destroy**:
the dedicated resource group, VNet and subnets, internal Container Apps environment, private DNS,
private endpoints, storage, Key Vault, registry, logging, runtime identity, and role assignments.
It showed no development resources, PostgreSQL server, migration job, API, peering, DNS cutover, or
customer traffic. This is a design check only; approval still requires a full refreshed plan using
the production backend and current name/capacity checks.

## Safety invariants

- `production.backend.hcl` must use the production state key. Initializing production against the
  development state is a stop condition.
- The production API cannot be deployed with the process-memory repository. Terraform fails the
  plan unless `use_postgres_repository = true`.
- PostgreSQL creation, migration-job creation, repository cutover, API deployment, peering, Entra
  enforcement, and platform handoff remain independent flags.
- Production never receives customer traffic through the development Scribe environment.
- Storage and Key Vault public access remain disabled and access remains managed-identity based.
- A production image uses an immutable Git commit tag built in the production ACR.

## Review sequence

1. Copy `production.backend.hcl.example` and `production.tfvars.example` to their gitignored local
   names. Enter identifiers only; authenticate with Azure CLI or GitHub OIDC—never a client secret.
2. Run a full refreshed foundation plan with every deployment flag false. Review the new state
   boundary and verify there are no development resource addresses.
3. After East US capacity approval, enable only `deploy_postgres_foundation`; review the paid
   database additions and confirm zero changes/destroys.
4. Build and scan an immutable image. Enable the migration job, run it manually once, and capture
   its sanitized success evidence.
5. Enable the PostgreSQL repository and deploy the API with both workflow features still off.
6. Peer production Scribe to the parallel platform VNet and link only the production Scribe private
   Container Apps DNS zone.
7. Enable inbound Entra enforcement, run synthetic private-network and tenant-isolation tests, then
   enable the platform caller.
8. Customer traffic requires a final production-readiness review and explicit approval.

## Rollback

Before data exists, delete only the separately owned production foundation through a reviewed
destroy plan. After PostgreSQL is initialized, preserve the database, storage, Key Vault, and state;
roll back application revisions and feature flags instead. Development is never a production
rollback target.
