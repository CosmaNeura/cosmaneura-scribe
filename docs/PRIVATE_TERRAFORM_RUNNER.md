# Temporary private Terraform runner

This runbook is a one-time development bootstrap for reconciling the private wrapping key, replacing
the API's obsolete vault-wide role, and updating the existing authenticated API revision. It creates
two manual Container Apps Jobs (`tf-plan` and `tf-apply`) with one dedicated user-assigned managed
identity.
Both deployment and execution are false by default. The jobs have no schedule, event trigger,
retry, ingress, secret, command argument, or Terraform-created permission for a caller to start
them.

This is not an application identity or the permanent deployment design. Never attach the API,
transcription, Speech-smoke, migration, delivery, or platform workflow identity to these jobs.

## Exact temporary authority

The dormant jobs receive only `AcrPull` on the Scribe registry so their immutable image can start.
Setting `enable_private_terraform_runner = true` adds exactly these assignments to the dedicated
runner principal:

| Scope | Role | Role definition ID | Reason |
| --- | --- | --- | --- |
| Scribe development resource group | Reader | `acdd72a7-3385-48ef-bd42-f606fba81ae7` | Refresh the targeted wrapping-key dependency graph |
| Existing remote-state Blob container | Temporary Scribe state-object data role | Terraform-created; no fixed ID | List only the exact OpenTofu workspace prefix; lease/read/write the exact state object without delete; and read/write/delete only the exact reviewer-hash-pinned plan and manifest |
| Scribe development Key Vault | Key Vault Crypto Officer | `14b46e9e-c2b7-41b4-b07b-48a6ebf60603` | Create and reconcile the RSA-3072 wrapping key over the private endpoint |
| Exact `cosmaneura-scribe-dev-api` resource | Container Apps Contributor | `358470bc-b998-42bd-ab17-a7e34c199c0f` | Update only the existing API revision with auth and key configuration |
| Exact API runtime UAMI | Managed Identity Operator | `f1a07417-d97a-45cb-824c-7a7467783830` | Permit the full Container App PUT to reattach the existing workload and registry identity |
| Exact Scribe managed environment | Container Apps Contributor | `358470bc-b998-42bd-ab17-a7e34c199c0f` | Permit only the environment read/join check required by the full Container App PUT |
| Scribe development Key Vault | Role Based Access Control Administrator | `f58310d9-a9f6-439a-9e8d-f62e7b41a168` | Delete the obsolete vault-wide Secrets User assignment and create the key-scoped Reader assignment |

There is no resource-group Contributor, Owner, User Access Administrator, subscription-wide
assignment, application role, or permission to start another Container Apps Job. The RBAC
Administrator assignment is deliberately limited to the one vault; the two Container Apps
assignments are limited to the exact API and exact environment. Managed Identity Operator is
limited to the existing API runtime UAMI. At those leaf scopes, the linked-resource assignments
cannot create, update, or delete another app, environment, or identity. The state assignment has an
Azure ABAC condition for exactly
`terraform_state_key`, `private_terraform_plan_blob_name`, and its `.manifest.json` companion. The
only list request allowed is OpenTofu's exact `${terraform_state_key}env:` workspace prefix. It
cannot access unrelated state objects, cannot delete the state object or its snapshot, and can
delete only the plan pair after a successful apply.

Enablement also creates the temporary custom state role definition and adds two TCP/443 rules to
the existing Container Apps subnet NSG: `AzureResourceManager` and `Storage.NorthCentralUS`. The
runner sets `ARM_RESOURCE_PROVIDER_REGISTRATIONS=none` and
`ARM_PROVIDER_ENHANCED_VALIDATION_RESOURCE_PROVIDERS=false`. The Azure backend continues to use the
dedicated managed identity directly. The AzureRM provider uses only the authenticated Azure CLI
session created by the fixed `az login --identity --client-id` step; direct AzureRM MSI is disabled
because the provider's ACA flow does not send the platform-required identity header. All providers
must already be registered, and the identity has no authority to register or enumerate providers at
subscription scope. The immutable image includes the locked AzureRM provider in a fail-closed
filesystem mirror, so runtime initialization does not require public OpenTofu Registry egress. The
rules apply to the shared ACA subnet, while Azure RBAC still denies other workload identities
access; this wider network reach is why Phase A must remove both rules immediately. Phase A also
removes the seven enabled assignments and custom role. Phase B then deletes `AcrPull`, both jobs,
and the identity.

Before initializing OpenTofu, the runner performs one silent Azure Resource Manager token preflight
through that CLI session. Failure emits only `AzureCliTokenPreflightFailed`; no token or CLI error
text is logged.

A Container Apps Job start permission is code-execution authority because a start request can
replace the deployed container template. Do not grant a person, runtime, or generic automation
principal `Microsoft.App/jobs/start/action` for these jobs. Use only the separately approved,
time-bounded control-plane operator for the two fixed starts below, with no start override body.

## Image and state prerequisites

1. Begin from the reviewed commit and build the dedicated image from the `infra` context. The
   context has its own `.dockerignore`, which excludes backend configuration, variable files,
   state, plans, and crash logs.

   ```bash
   az acr build \
     --registry <scribe-acr> \
     --image cosmaneura-scribe-terraform-runner:<40-character-commit-sha> \
     --file runner/Dockerfile \
     infra
   ```

   Record the resulting registry digest. Set `private_terraform_runner_image_tag` to the exact
   source commit SHA and `private_terraform_runner_image_digest` to the returned `sha256:` value.
   The job deploys by digest; never use `latest` or a tag-only image reference.

2. The live state Blob service currently has versioning unset and delete retention disabled; do not
   claim that it has those protections. A separately reviewed change may enable them later. For this
   bootstrap, preserve the authenticated pre-runner snapshot created at
   `2026-08-16T01:28:36.2131904Z` with ETag `0x8DEFB3100A356B3`. Its full lineage, serial `27`, and
   SHA-256 are recorded in the protected change record. Re-read that exact snapshot before starting;
   a missing snapshot or mismatched metadata is a stop condition. Do not download or paste state
   into logs, chat, or a pull request.

   ```bash
   tofu state pull | shasum -a 256
   az storage blob show \
     --account-name <state-account> \
     --container-name <state-container> \
     --name cosmaneura-scribe/development.tfstate \
     --snapshot 2026-08-16T01:28:36.2131904Z \
     --auth-mode login \
     --query '{snapshot:snapshot,etag:properties.etag}' \
     --output json
   ```

3. Choose a new plan object such as `plans/<approved-change-id>-<utc-timestamp>.tfplan`. The state
   container has no immutability policy or versioning, so `overwrite=false` prevents accidental
   replacement but does not make the object immutable. The apply job therefore requires a separate
   reviewer-pinned SHA-256 plus state lineage/serial before it will read or execute the object.

4. Configure the exact existing backend resource ID, resource group, account, container, and key.
   These are identifiers, not credentials. Managed identity is the only authentication path.

## Bootstrap, plan, and apply

First set only `deploy_private_terraform_runner = true`, keep
`enable_private_terraform_runner = false`, and set the source commit plus immutable image digest.
Use a reviewed targeted
plan to add only the identity, `AcrPull`, and two dormant jobs. The target is a one-time bootstrap
exception: it avoids asking a public runner to refresh the private Key Vault data plane.

```bash
tofu plan \
  -out=private-runner-bootstrap.tfplan \
  -target=azurerm_container_app_job.private_terraform_runner
tofu apply private-runner-bootstrap.tfplan
```

Then populate the exact backend and plan-object inputs and set
`enable_private_terraform_runner = true`. A second reviewed targeted plan may update only the two
job templates and existing Container Apps NSG, create the temporary state role definition, and add
the seven assignments in the table above. The NSG update may add only the two temporary rules named
above. Wait for RBAC propagation and verify the principal has exactly eight assignments including
`AcrPull` before starting either job.

The enable gate also pins the one-time live manifest: API image tag
`804c4bacd692bc157ab101ff5055d999e00a37cc` (registry digest
`sha256:8d71145c675bd3be3397732cd3361188d49e3df0dd603527b52e804ba9817136`), workflow auth enabled,
audience `57264fe1-6a4a-4946-8412-e0be18805977`, trusted caller
`c7bae168-fbf5-4658-b0d9-dd4b5373a1be`, handoff and parallel peering disabled, PostgreSQL and
clinical transcription absent/disabled, delivery reconciliation undeployed/disabled, private
Speech foundation and dormant smoke job deployed, smoke invocation disabled, and Log Analytics
held at 30 days/0.5 GiB with diagnostics off. The approved budget/90-day/no-cap/diagnostics
activation is a later saved plan, not part of this key/API reconciliation.

```bash
tofu plan \
  -out=private-runner-enable.tfplan \
  -target=azurerm_container_app_job.private_terraform_runner
tofu apply private-runner-enable.tfplan
```

Start the plan job without `--container-name`, `--image`, `--command`, `--args`, environment, or
other template overrides:

```bash
az containerapp job start \
  --name cosmaneura-scribe-dev-tf-plan \
  --resource-group cosmaneura-scribe-development \
  --output none
```

The fixed runner executes only:

```text
tofu plan \
  -target=azurerm_key_vault_key.audio \
  -target=azurerm_role_assignment.runtime_audio_key_reader \
  -target=azurerm_role_assignment.runtime_vault \
  -target=azurerm_container_app.api[0] \
  -out=<ephemeral-file>
```

It keeps the Azure backend lease enabled, uploads the binary plan plus a JSON manifest containing
its SHA-256 and the exact pre-plan state lineage/serial, and logs only fixed action metadata, the
detailed-exit code, plan hash, lineage, and serial. Initialization, plan, and provider error details
remain in the ephemeral container and are not copied to Log Analytics. No state, key material, plan
body, token, object location, or variable value is logged.

If planning fails, the runner reads only a bounded tail of its ephemeral provider log and emits one
fixed class: target/configuration, provider registration, Key Vault network/DNS, Storage data-plane
read, API read, identity/RBAC, or generic plan failure. It never emits the matched text, status, URL,
provider response, resource name, or log fragment. A class is diagnostic evidence only; it never
authorizes an automatic role, network, target, or configuration change.

A no-change plan is a hard stop: it is not uploaded or applied. Re-verify live state and close or
redesign the one-time repair instead of forcing a no-op execution.
If only one of the plan/manifest uploads succeeds, stop and record the orphan. An external operator
must delete that exact orphan after verifying its object name and choose a new plan-object name;
never overwrite or reuse a partially published pair.

An authorized reviewer downloads the two blobs into an encrypted temporary directory, verifies the
hash and lineage/serial, and runs `tofu show` with the same OpenTofu/provider versions. The acceptance
boundary is exactly: create the RSA-3072 wrapping key; use the explicit `moved` block to replace the
obsolete vault-wide `runtime_vault` Secrets User assignment with key-scoped
`runtime_audio_key_reader`/Key Vault Reader; and update `cosmaneura-scribe-dev-api` with the pinned
image, workflow authentication, and key ID. OpenTofu requires both the old and new role addresses as
targets to honor that one move; they are one logical replacement. The role replacement is the only
accepted destroy.
The live vault, Key Vault private endpoint, Key Vault private-DNS VNet link, and every other
target-graph dependency are refresh-only and must show zero actions. Reject every other
add/change/destroy, including the temporary NSG rules (which belong only to the outer enable/revoke
plans), Speech, diagnostics, LAW, budget, PostgreSQL, transcription, delivery reconciliation,
handoff, or unrelated role change.

After approval, pin the reviewed hash, lineage, and serial into only the apply job with an Azure
control-plane update. This deliberately does not run Terraform or change the state serial that the
saved plan is bound to:

```bash
az containerapp job update \
  --name cosmaneura-scribe-dev-tf-apply \
  --resource-group cosmaneura-scribe-development \
  --container-name runner \
  --set-env-vars \
    TF_RUNNER_EXPECTED_PLAN_SHA256=<reviewed-64-character-sha256> \
    TF_RUNNER_EXPECTED_STATE_LINEAGE=<reviewed-state-lineage> \
    TF_RUNNER_EXPECTED_STATE_SERIAL=<reviewed-state-serial> \
  --output none
```

Read the job back and prove that only those three initially `review-required` values changed; image,
identity, registry, command, every other environment value, resources, trigger, timeout, and retry
must still match the reviewed template. Do not use `tofu apply` to set the pins because that would
advance state and make the saved reconciliation plan stale.

After recording approval of that exact hash, start the apply job with no overrides:

```bash
az containerapp job start \
  --name cosmaneura-scribe-dev-tf-apply \
  --resource-group cosmaneura-scribe-development \
  --output none
```

The apply job requires the reviewer pins, then downloads the plan and manifest, checks all three
pins, recomputes SHA-256, checks current state lineage/serial, and applies only the saved plan. A
recreated object with different bytes, a stale plan, changed manifest, state-lock conflict, backend
failure, or provider failure is a hard nonzero exit. After a successful state advance, it deletes
the plan and manifest so the artifact cannot be applied twice; Terraform's stale-plan check also
rejects replay. Verify both blobs are absent. A post-apply artifact-deletion error is an incident
cleanup task, not permission to rerun the already-applied plan. Logs contain only fixed result
metadata and approved hash/lineage/serial.

An apply failure is terminal for that saved artifact. The runner classifies only fixed, bounded
failure classes from the private log and deletes the raw log before exiting; it never emits provider
text. Immediately reset all reviewer pins, pull and protect the new state, compare every planned
resource with live Azure, and record any partial commit. Never rerun the old plan even if its two
objects remain. Keep the stale pair only as a collision guard until an externally reviewed outer
plan has rotated both job templates and the exact-object ABAC condition to a new unique path; then
delete only the old pair and verify absence. A recovery plan must bind the current serial and include
only the still-missing action.

The first full API PUT stopped immediately after a successful `listSecrets`, before Azure recorded
`Microsoft.App/containerApps/write`. Azure did not retain the raw failure body, so the evidence
cannot identify which linked-resource check rejected the request first. AzureRM's full-model update
path resends both the unchanged UAMI and managed-environment links, and Azure requires the two
permissions in the authority table to authorize those links. A recovery rollout therefore adds
both exact assignments to avoid a sequential second failure; this remains unverified until a live
PUT succeeds. The rollout may otherwise update only the two runner jobs and runner provenance to the
repaired digest and replace the state-object assignment solely to rotate to a new plan/manifest
pair. Wait for both assignments to propagate before starting the plan job. The fresh private plan
must show the already-created key and key-scoped Reader as no-op and only the live API update as an
action. Any other action is a stop.

Do not use `-lock=false`, `state rm`, `state mv`, import, backend migration, force-unlock, local
state, an account key, a SAS, a client secret, or command-line variable values in this workflow.

## Proof and mandatory teardown

Before teardown, require all of the following:

- the saved-plan apply execution succeeded once, with zero retry;
- the post-apply state lineage is unchanged and the serial advanced only as expected;
- Key Vault reports one enabled RSA-3072 wrapping key with only `wrapKey` and `unwrapKey` operations;
- the API identity still has only key-scoped `Key Vault Reader`, not Crypto User/Officer; and
- the private authenticated `GET /v1/audio-encryption-key` acceptance returns the expected public
  metadata without exposing private material.

Immediately after that key/API proof, and within the same approved maintenance window, a separate
external operator performs teardown. The operator must use its own state-container access; neither
temporary job may plan or apply its own removal.

1. Confirm both temporary jobs have no active execution. An active execution is a stop condition.
2. **Phase A — revoke privilege and commit state.** Keep
   `deploy_private_terraform_runner = true`, set `enable_private_terraform_runner = false`, close
   both acceptance gates, and set `deploy_private_api_acceptance_job = false`. Use an external
   saved plan to remove the acceptance job and its temporary `AcrPull`; disable both Terraform jobs;
   destroy the seven enabled assignments and custom state role; and remove both temporary NSG rules.
   Keep the Terraform identity, jobs, and their `AcrPull` until this apply has committed state.

   ```bash
   tofu plan \
     -out=private-runner-revoke.tfplan \
     -target=azurerm_container_app_job.private_terraform_runner \
     -target=azurerm_network_security_group.container_apps \
     -target=azurerm_role_assignment.private_terraform_runner_api_contributor \
     -target=azurerm_role_assignment.private_terraform_runner_environment_join \
     -target=azurerm_role_assignment.private_terraform_runner_key_officer \
     -target=azurerm_role_assignment.private_terraform_runner_resource_reader \
     -target=azurerm_role_assignment.private_terraform_runner_runtime_identity_operator \
     -target=azurerm_role_assignment.private_terraform_runner_state \
     -target=azurerm_role_assignment.private_terraform_runner_vault_rbac_admin \
     -target=azurerm_role_definition.private_terraform_runner_state \
     -target=azurerm_container_app_job.private_api_acceptance \
     -target=azurerm_role_assignment.private_api_acceptance_acr
   tofu apply private-runner-revoke.tfplan
   ```

3. Prove Phase A state advanced with unchanged lineage, both Terraform jobs are disabled, the
   acceptance job and its `AcrPull` are absent, the seven enabled assignments and custom role are
   absent, and the NSG has neither
   `AllowTemporaryTerraformArmOutbound` nor `AllowTemporaryTerraformStateOutbound`. Only `AcrPull`
   may remain.
4. **Phase B — delete the dormant bootstrap.** Set
   `deploy_private_terraform_runner = false` and use a second external saved plan to destroy the two
   disabled jobs, `AcrPull`, and the dedicated identity:

   ```bash
   tofu plan \
     -out=private-runner-delete.tfplan \
     -target=azurerm_container_app_job.private_terraform_runner \
     -target=azurerm_role_assignment.private_terraform_runner_acr \
     -target=azurerm_user_assigned_identity.private_terraform_runner
   tofu apply private-runner-delete.tfplan
   ```

5. Query assignments by the recorded principal object ID at the registry, resource group, state
   container, vault, exact API, exact environment, and runtime-UAMI resources. All eight assignments
   must be absent. Confirm both job
   resources, the managed identity, custom state role definition, and both temporary NSG rules no
   longer exist and no execution remains active.
6. Pull the post-teardown state through the normal backend, verify its lineage/serial and SHA-256,
   and prove that state lists the wrapping key but no temporary runner resource.
7. Verify the apply job already deleted its saved plan and manifest. Delete the pre-runner state
   snapshot only after the post-teardown state/hash checks and a separately reviewed state-protection
   replacement are recorded. The snapshot deletion is deliberate and irreversible; do not delete
   the current state blob or any unrelated snapshot.

The immediate replacement is deliberately **no standing key-management principal**. The wrapping
key remains in Terraform state and the API/worker identities keep only their runtime roles.

The long-term replacement requires a separate design and review: an ephemeral self-hosted GitHub
Actions runner inside the Scribe VNet, protected by GitHub environment approval and OIDC, using a
dedicated deployment UAMI. Its state-container and exact vault key-management roles exist only for
the approved reconciliation window and are revoked afterward. It must run full saved-plan review,
state-lock, private-DNS, no-secret-log, and teardown acceptance. It must never reuse an API, worker,
platform, or smoke-test identity and must not receive a generic ACA job-start grant.

## Separate API-route acceptance job

Do not attach the broad Terraform identity to an API test. ADR 0017 defines a separate one-shot job
in the existing private Container Apps environment. Its deployment, enablement, and invocation
gates all default to false. It attaches the exact externally owned platform workflow UAMI, checks
that identity's client ID against `trusted_platform_client_id`, and grants only temporary `AcrPull`
on the exact Scribe registry. The existing `Scribe.Workflow.Access` application role is its only API
authorization; it receives no Azure Key Vault role.

Build the API image from the reviewed acceptance commit and record both its source SHA and registry
digest. Configure the exact existing platform workflow identity resource ID and one synthetic
practice-tenant UUID. Before deployment, enumerate every inherited and direct principal that can
start or update the exact future job. Record the approved operator object ID and maintenance window;
do not proceed with any unreviewed principal. The stack grants no start role, but inherited
subscription authority can still replace the execution template, so the raw invocation gate is not
an Azure control-plane boundary.

For this one-time rollout, choose a new unused plan-object name before planning and set:

```hcl
deploy_private_api_acceptance_job       = true
enable_private_api_acceptance_job       = false
allow_private_api_acceptance_invocation = false
private_terraform_reconciliation_completed = false
```

Because the temporary Terraform runner is already live, the reviewed dormant-rollout plan may only:

- add the dormant acceptance job and its exact-registry `AcrPull`;
- update both temporary Terraform jobs and their UAMI provenance to the newly merged, digest-pinned
  runner image/configuration; and
- replace the exact state-object role assignment solely to rotate the old plan/manifest paths to
  the new unique pair. Scope, principal, role definition, condition version, state path, workspace
  list prefix, and state-delete denial must remain identical.

No API, wrapping-key, runtime-role, NSG, budget, Speech, PostgreSQL, transcription, delivery,
handoff, peering, or diagnostics action is accepted. After apply, wait for the replacement ABAC
assignment to propagate, prove backend init/state pull, and take a fresh state snapshot. Only that
post-rollout serial may be used by the private reconciliation plan. Changing Terraform state between
reconciliation review and apply makes the saved plan stale and is prohibited.

After the key/API apply succeeds, set `enable_private_api_acceptance_job = true` and
`allow_private_api_acceptance_invocation = true`, and set the validation-only external attestation
`private_terraform_reconciliation_completed = true`. The temporary runner embeds the immutable
dormant acceptance manifest, so review and apply only the expected acceptance-job template update.
Terraform derives the stable private API origin and exact Container Apps environment static IP
`/32`. Read the job back and verify its sole identity, digest-pinned image, fixed command, both raw
gates, audience, synthetic tenant, private address, CPU/memory, manual trigger, timeout, and zero
retry still match. Wait for the temporary `AcrPull` assignment to propagate.

The recorded operator starts exactly one execution without an image, command, argument,
environment, resource, or identity override:

```bash
az containerapp job start \
  --name cosmaneura-scribe-dev-api-proof \
  --resource-group cosmaneura-scribe-development \
  --output none
```

The runner rejects every argument and first verifies DNS resolves exclusively to the derived
private `/32`. It then polls the unauthenticated `/healthz` route every five seconds under a strict
180-second deadline and requires two consecutive 200 responses. Ingress-layer non-200 responses
and transport failures reset the readiness streak. The runner emits only the fixed readiness
started, succeeded, or deadline-exhausted events, with numeric poll count and elapsed milliseconds;
it never logs status, URL, endpoint, DNS answer, or body.

After readiness succeeds, the runner closes the unauthenticated client, repeats the exact `/32`
DNS proof, creates the exact UAMI `ManagedIdentityCredential`, and performs one authenticated
`GET /v1/audio-encryption-key`. The credentialed client shares no cookies or connection state with
readiness, disables redirects and proxy-environment trust, and bounds the decoded response to 8
KiB. Success is one fixed record containing only HTTP 200, RSA, RSA-OAEP-256, 3072 bits, `wrapKey`,
key-version presence, and duration. It never logs the JWK modulus, exponent, key-version value,
token, URL, tenant, DNS answer, or body.

`Settings` is the sole authority for the fixed 180-second readiness deadline, five-second interval,
and strict 60-second probe bound; Terraform and the job environment do not duplicate them. Those
bounds deliberately leave 60 seconds of the unchanged 300-second job limit for process startup,
DNS, token acquisition, cleanup, and logging. Neither phase prewarms the API or changes its
scale-to-zero configuration. The authenticated request is never retried, and the Container Apps
Job retry limit remains zero.

Immediately after start, read the effective execution template and prove image, command, arguments,
environment, resources, and identity equal the reviewed job. Query Activity Log and accept only the
recorded operator's no-override start/update sequence in the approved window. Any second execution,
different caller, or template difference is an incident and a stop.

After recording success, close the invocation and enable gates and apply that acceptance-job
template update. Confirm no execution remains active. Phase A above must then set
`deploy_private_api_acceptance_job = false` while setting
`enable_private_terraform_runner = false`; the same reviewed plan removes the acceptance job and
its temporary `AcrPull` while revoking the Terraform runner's seven enabled assignments, custom role,
and temporary NSG rules. The external platform identity and app-role assignment remain. No generic
job-start role is authorized by this runbook.
