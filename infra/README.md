# Scribe Azure infrastructure

OpenTofu/Terraform baseline for private audio custody. It intentionally creates no credentials and
accepts no secret values. Local runs authenticate through Azure CLI; GitHub runs use OIDC.

Read [`../docs/AZURE_ONBOARDING.md`](../docs/AZURE_ONBOARDING.md) before initialization.

Development and production use distinct backend keys, resource groups, and address spaces. The
production examples are `production.backend.hcl.example` and `production.tfvars.example`; their
gates are documented in
[`../docs/PRODUCTION_ENVIRONMENT_PLAN.md`](../docs/PRODUCTION_ENVIRONMENT_PLAN.md). Production
cannot deploy the API with process-memory persistence.

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
Key Vault, an RSA-3072 wrapping key, private endpoints, a runtime managed identity, and
least-privilege data-plane roles. The runtime can read only the key's public metadata; it cannot
unwrap a session key.

The selected three-existing-Core-host bundle has a separate IAM-only leaf:
`prepare_production_core_bundle_grants` and
`remove_owned_production_translation_blob_writer` both default false. It
prepares exact API public-key/delegated-create-write, Speech unwrap/read/Speech,
and translation unwrap/OpenAI rights; translation receives no Blob grant. Both
selectors require explicit owner policy/grant approval before apply, including
removal of this state's existing translation account-wide Blob writer before
worker attachment. It changes no network, host, identity attachment, database,
Graph service role or runtime activation. See the
[Tier 2 IAM sequence and recovery](../docs/flight-plans/2026-10-31-existing-core-three-container-bundle-dark.md#separate-existing-identity-iam-preparation).

The separate Core-bundle routing selectors also default false, with empty policy
receipt hashes and a null exact three-host binding. Their selected mode retains
the IAM grants and owned-writer removal while all old standalone modes stay off.
It changes only existing Key Vault public/egress-ACL and Blob public/native-CORS
properties, after fresh exact host metadata. Owner approval must explicitly
cover public worker unwrap and authenticated native uploads; hashes are not
approval. No resource, runtime, database or activation is added. See the
[routing policy, plan limits and withdrawal](../docs/flight-plans/2026-10-31-existing-core-three-container-bundle-dark.md#separate-core-bundle-routing-preparation).

For the intentionally absent production key only,
`enable_production_arm_audio_key_bootstrap = true` selects a Terraform-owned
`Microsoft.KeyVault/vaults/keys@2024-11-01` ARM child. This uses Azure's management
plane without opening the private vault. The key remains non-exportable RSA3072,
allows only wrap/unwrap operations, and has `prevent_destroy`. The API receives
the existing key-scoped **Key Vault Reader** role; no API unwrap permission is
created. Review the separate key-only saved plan under
[`../docs/flight-plans/2026-10-29-production-arm-audio-key.md`](../docs/flight-plans/2026-10-29-production-arm-audio-key.md).
This flag defaults false. Keep it false for existing AzureRM-owned keys, including
development and staging. The declared `audio` to `audio[0]` move changes only their
Terraform address; it does not replace the key. Switching an already-owned key
between providers is refused by `prevent_destroy` and is not a rollback action.

The default wrapping key remains a second-stage private Key Vault data-plane resource. The vault, private
endpoint, and DNS link must exist before the key plan; do not include the key in an empty foundation
apply. Run key applies from an approved private-network runner that can resolve and reach the vault;
an ordinary public GitHub runner cannot create or reconcile it. The approved one-time bootstrap uses
the false-default, dedicated plan/apply jobs in
[`../docs/PRIVATE_TERRAFORM_RUNNER.md`](../docs/PRIVATE_TERRAFORM_RUNNER.md). Its vault-scoped
**Key Vault Crypto Officer** and RBAC Administrator assignments, exact-API Container Apps
Contributor assignment, exact-environment Container Apps Contributor assignment, exact-runtime-UAMI
Managed Identity Operator assignment, exact-object state data role/ABAC assignment, and
resource-group Reader exist only for the key/role/API proof window. The two linked-resource roles
allow Azure's full Container App PUT to reattach the unchanged environment and UAMI; both are scoped
to their exact leaf resources. State deletion and unrelated Blob objects are denied.
Provider auto-registration is disabled, and two temporary NSG rules permit only ARM and the North
Central US state service over TCP/443. The image uses its locked local provider mirror and does not
need public provider-registry egress. Phase A removes those seven enabled assignments, the custom
role, and both rules; Phase B removes `AcrPull`, the jobs, and the identity. Azure subscription
Owner or Contributor alone has no Key Vault data-plane key permission. No API or worker identity
may substitute for the deployment identity.

The Container Apps slice adds a dedicated delegated subnet, ACR, Log Analytics, and an internal
workload-profile environment. Deployment is intentionally two-stage so Azure never receives a
reference to an image that does not yet exist:

Observability activates in three reviewed stages. The initial configuration retains 30 days and a
temporary 0.5-GiB daily cap. This is an explicit audit-loss exception, not the accepted baseline.

1. Set `enable_development_cost_guardrails = true` with the existing, verified Azure Monitor action
   group resource ID. This creates the approved `$100/month` resource-group budget with both 80%
   actual and 80% forecast notifications. It does not create or copy an email receiver.
2. Set `enable_log_analytics_audit_baseline = true`,
   `log_analytics_retention_in_days = 90`, and `log_analytics_daily_quota_gb = -1`. Validation blocks
   this step until the budget gate is active. The uncapped 90-day workspace avoids silent audit loss
   during an incident; monitor its `Usage` table. It is not a long-term immutable audit archive.
3. Enable scrubbed data-plane diagnostics only after the first two stages and the transformation
   proof below pass.

Blob and Key Vault data-plane diagnostics have an additional false-by-default gate:

```hcl
enable_phi_safe_data_plane_diagnostics = false
```

Validation keeps it false until the budget and workspace-baseline gates are active. Enabling it
creates a `WorkspaceTransforms` DCR,
attaches it to the existing workspace, and only then enables `StorageRead`, `StorageWrite`,
`StorageDelete`, `Transaction`, Key Vault `AuditEvent`, and `AllMetrics`. The Blob transform drops
`Uri`, `ObjectKey`, `SourceUri`, and `DestinationUri` before `StorageBlobLogs` ingestion. Key Vault
audit metadata can include the fixed, non-clinical wrapping-key name, but not key material. Restrict
workspace access as PHI-adjacent operational data.

Before accepting the diagnostics apply, use the Azure transformation editor against sample data.
After apply, wait for propagation, perform only synthetic Blob reads/writes/deletes, and require:

```kusto
DCRLogErrors
| where TimeGenerated > ago(1h) and OperationName == "Transformation"
| summarize failures=count()

StorageBlobLogs
| where TimeGenerated > ago(1h)
| summarize leaked_locations=countif(
    isnotempty(Uri) or isnotempty(ObjectKey) or
    isnotempty(SourceUri) or isnotempty(DestinationUri))
```

Both counts must be zero. If either is nonzero, disable the diagnostic gate before further Blob
traffic; never accept raw object-location logging.

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

The manual transcription job is controlled independently and remains disabled by default:

```hcl
deploy_transcription_job = false
enable_transcription_job = false
```

`deploy_transcription_job` requires the private PostgreSQL foundation and an image tag equal to a
lowercase 40-character commit SHA.
It creates a dedicated managed identity, ACR pull, and a manual-only Container Apps Job with no
ingress, schedule, event trigger, or platform retry. Keep `enable_transcription_job = false` for the
first apply and run the database migration job again so bootstrap creates the identity's narrow
PostgreSQL role. The dormant runner exits nonzero before Settings, target UUID parsing, or client
creation, making accidental starts visible without touching custody.

Activation additionally requires keeping `deploy_database_migration_job = true`, setting
`use_postgres_repository = true`, and provisioning the Terraform-owned private Speech foundation.
Enabling creates only the worker's container-scoped Blob Reader, key-scoped Key Vault Crypto User,
and account-scoped Speech User assignments; its endpoint and exact private-IP guard are derived
from the owned resources.
Wait for all three role assignments to appear for the worker and propagate before starting the
first execution; an initial `403` is a reason to wait and retry, not to widen permissions. Run the
database bootstrap job only in a drained maintenance window with no API traffic or transcription
execution because it revokes current privileges before restoring the reviewed grant sets.
Terraform grants no caller permission to start the job. Activation remains blocked until the
reviewed full-template operator helper described in
[`../docs/TRANSCRIPTION_WORKER.md`](../docs/TRANSCRIPTION_WORKER.md) preserves every deployed
container field and injects only the tenant and session UUID arguments. An args-only Container Apps
override does not merge with the base template. Container Apps retries are zero; PostgreSQL permits
at most three durable manual attempts.

Decommissioning is also explicit: disable the runner and data roles, use a separately reviewed
migration-administrator procedure to revoke and drop the dedicated PostgreSQL role, and only then
remove the job identity. Recreating a deleted managed identity under the same name produces a
different Entra object ID and must never inherit the old database mapping.

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

Private Speech is independently staged behind three false-default flags:

```hcl
deploy_private_speech_foundation = false
deploy_speech_smoke_job          = false
enable_speech_smoke_job          = false
```

The foundation owns the S0 account, default-deny private endpoint/DNS, and only safe diagnostic
categories. The dormant smoke identity has ACR pull only; enabling adds account-scoped Speech User
and runs exactly two hash-pinned synthetic cases. Follow
[`../docs/SPEECH_PRIVATE_ACCEPTANCE.md`](../docs/SPEECH_PRIVATE_ACCEPTANCE.md) before activating the
clinical transcription job. Retention automation and deployment identities follow in later
reviewed slices.

The temporary private Terraform runner is independently false by default:

```hcl
deploy_private_terraform_runner = false
enable_private_terraform_runner = false
```

It is only a one-time private key, runtime-role, and API reconciliation. Follow the complete state
snapshot, key/moved-role/API saved-plan review, fixed-start, proof, seven enabled-assignment/custom
role/temporary-egress Phase A revocation, `AcrPull`/job/identity Phase B deletion, and replacement
requirements in
[`../docs/PRIVATE_TERRAFORM_RUNNER.md`](../docs/PRIVATE_TERRAFORM_RUNNER.md).

The authenticated private public-key route has a separate, one-shot acceptance job. It uses the
exact existing platform workflow UAMI, a digest-pinned image and fixed command, and only a temporary
registry-scoped `AcrPull`; it receives no Key Vault role. Deployment, enablement, and invocation are
independently false by default:

```hcl
deploy_private_api_acceptance_job       = false
enable_private_api_acceptance_job       = false
allow_private_api_acceptance_invocation = false
```

The runner proves the API hostname resolves only to the existing Container Apps environment's
private static address before obtaining a token, then emits only fixed key metadata. Before its
dormant deployment, enumerate inherited and direct job start/update authority, record the one
approved operator and maintenance window, and choose a new unused private-plan object name. The
dormant rollout also refreshes both temporary Terraform runner jobs and replaces only the
exact-object state assignment needed to rotate the plan/manifest paths. Wait for that assignment to
propagate and take a fresh state snapshot before reconciliation planning.

After the reviewed key/API plan applies, open the two acceptance gates only with
`private_terraform_reconciliation_completed = true`, execute once without start-time overrides,
and verify the effective execution template and Activity Log. Close the gates, then remove the job
and its temporary `AcrPull` in the same Phase A plan that revokes the temporary Terraform roles and
NSG rules. Follow ADR 0017 and the API-route section of
[`../docs/PRIVATE_TERRAFORM_RUNNER.md`](../docs/PRIVATE_TERRAFORM_RUNNER.md).

After that runner teardown, the versionless Key Vault Reader correction uses the external
saved-plan follow-up documented in the same runbook. It does not recreate the private Terraform
runner: the only temporary resources are the dormant acceptance job and its exact-registry
`AcrPull`; the permanent change is the same read-only role moved from one key version to the
versionless key ARM scope. Crypto User/Officer on the API runtime principal, runner roles, and
temporary NSG rules are forbidden; the transcription worker's separately scoped unwrap permission
is unchanged.
