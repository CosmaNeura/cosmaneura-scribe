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
| Production | `cosmaneura-scribe-production` | `cosmaneura-scribe/production.tfstate` | `10.46.0.0/16` |

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

The 2026-10-28 subscription inventory found that the earlier production example's
`10.44.0.0/16` already belongs to `cosmaneura-scheduling-dev-vnet` and that
`10.45.0.0/16` belongs to its PostgreSQL VNet. The example now uses the observed-unused
`10.46.0.0/16`. This is not a reservation: capture a fresh `az network vnet list` inventory and
run `python3 scripts/check_production_network_overlap.py` immediately before every reviewed plan
and apply.

## Automated dark-state contract

`infra/tests/production_receiver_dark.tftest.hcl` uses an OpenTofu mock provider and synthetic
identifiers, so it does not authenticate to Azure or read remote state. Run it from the repository
root with:

```bash
tofu -chdir=infra test -filter=tests/production_receiver_dark.tftest.hcl
```

The contract proves that the production configuration leaves the API, PostgreSQL, Speech, jobs,
platform peering, private-DNS platform link, workflow authentication, capture protocol, and
platform handoff disabled. It also checks that the dormant foundation retains internal-only
Container Apps ingress, managed-identity-only private storage, and private RBAC-only,
purge-protected Key Vault custody. Separate negative cases require durable PostgreSQL before a
production API and require both workflow authentication and PostgreSQL before capture can be
enabled.

This test is source validation, not evidence that a production receiver is deployable and not an
Azure plan or deployment approval. Its synthetic global names and VNet ID do not prove that those
names remain available, a platform VNet or peering target exists, native clients have a reachable
upload path, Core can reach a private receiver, or any receiver workload exists. A real production
plan still requires the isolated production backend, current non-secret Azure identifiers,
refreshed name/capacity checks, and independent review.

## Unresolved live production stop conditions

The 2026-10-28 read-only production inventory does not match the proposed private foundation: the
existing production Container Apps environment is public and has no VNet attachment, its resource
group has no VNet, and the existing upload account permits public-network and shared-key access.
Those resources are observations, not approved substitutes for this isolated Scribe boundary.

Two hard connectivity gates must be implemented and pass live synthetic acceptance before the
receiver can be called deployable:

1. **Native upload edge.** Private-only Blob storage is not directly reachable from iOS, desktop,
   or browser clients. Provide the false-by-default Front Door Premium private-origin edge from ADR
   0016, or the documented API-mediated fallback. The authorized BFF must issue only short-lived,
   operation-scoped user-delegation SAS grants to that reachable origin. Require a real synthetic
   `PUT`, private-path read-back and envelope verification while the Blob public endpoint remains
   denied, plus SAS/query/path log-scrubbing proof. Public Blob access or shared account keys are
   not an acceptable fallback.
2. **Core-to-private-receiver path.** Provision the separately owned platform VNet, approve both
   sides of peering, link the Scribe private Container Apps DNS zone to that VNet, and prove the
   production Core workload identity can resolve and call the internal receiver without a public
   ingress fallback. Authentication alone does not create network reachability.

Until both gates and the refreshed receiver plan pass review, a green mock test establishes only
source invariants. It does not establish a platform VNet, peering target, upload edge, deployed
receiver, production route, or customer-traffic readiness.

## Design-plan evidence

An isolated empty-state copy of this production configuration was planned on 2026-08-14 with every
deployment flag false and `-refresh=false`. The unsaved plan showed **23 add, 0 change, 0 destroy**:
the dedicated resource group, VNet and subnets, internal Container Apps environment, private DNS,
private endpoints, storage, Key Vault, registry, logging, runtime identity, and role assignments.
It showed no development resources, PostgreSQL server, migration job, API, peering, DNS cutover, or
customer traffic. This is a design check only; approval still requires a full refreshed plan using
the production backend and current name/capacity checks. It predates the protected RSA wrapping key
resource and must not be used as the expected count for the next plan.

## Safety invariants

- `production.backend.hcl` must use the production state key. Initializing production against the
  development state is a stop condition.
- The production API cannot be deployed with the process-memory repository. Terraform fails the
  plan unless `use_postgres_repository = true`.
- PostgreSQL creation, migration-job creation, repository cutover, API deployment, peering, Entra
  enforcement, platform handoff, transcription-job deployment, and transcription activation remain
  independent flags.
- Production never receives customer traffic through the development Scribe environment.
- Storage and Key Vault public access remain disabled and access remains managed-identity based.
- A production image uses an immutable Git commit tag built in the production ACR.

## Review sequence

1. Copy `production.backend.hcl.example` and `production.tfvars.example` to their gitignored local
   names. Enter identifiers only; authenticate with Azure CLI or GitHub OIDC—never a client secret.
   Capture current VNet names, resource groups, and address prefixes as JSON, then require:

   ```bash
   python3 scripts/check_production_network_overlap.py \
     --candidate 10.46.0.0/16 --inventory <path>
   ```

   Any overlap is a stop condition; do not choose a replacement range without a refreshed network
   review.
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
8. Deploy the manual transcription job disabled. After private Speech and the live synthetic
   round-trip pass, separately enable its three data-plane roles and runner gate.
9. Customer traffic requires a final production-readiness review and explicit approval.

## Rollback

Before data exists, delete only the separately owned production foundation through a reviewed
destroy plan. After PostgreSQL is initialized, preserve the database, storage, Key Vault, and state;
roll back application revisions and feature flags instead. Development is never a production
rollback target.
