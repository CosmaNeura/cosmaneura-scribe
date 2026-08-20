# Synthetic capture preview infrastructure

This isolated OpenTofu root provisions only the synthetic, non-production capture preview in East
US 2. It does not connect to the clinical Scribe stack, production BFF, patient storage, Speech,
Key Vault, PostgreSQL, or any production identity.

## State bootstrap is a separate security boundary

Do not reuse the existing Scribe Terraform backend. AzureRM exposes the Static Web App deployment
API key and disabled service-account keys as sensitive computed provider attributes, so those
values are present in state even though this root never outputs or consumes them directly. Before
`tofu init`, an authorized operator must bootstrap a dedicated resource group, StorageV2 account,
and private blob container for this root's state.

The bootstrap account must have all of the following before state is written:

- Microsoft Entra data-plane authorization for only the approved Terraform operators;
- shared-key access, public containers, SFTP, and local users disabled;
- HTTPS-only transport with TLS 1.2 or newer and OAuth as the default authentication mode;
- blob versioning plus blob and container soft delete;
- a network rule restricted to the approved runner/operator path, with no anonymous access; and
- Azure Activity Log monitoring for management-plane changes, without copying state contents to
  logs.

The bootstrap is intentionally not managed by this root, which avoids a self-referential backend
and prevents deletion of the state store with the preview resource group. Copy
`backend.hcl.example` to the ignored `backend.hcl`; its state key is exactly
`capture-preview/synthetic.tfstate` and `use_azuread_auth` must remain true.

AzureRM provider auto-registration is disabled so a plan cannot mutate the subscription. Before
the reviewed resource plan, inventory and explicitly register only the required namespaces:
`Microsoft.Authorization`, `Microsoft.Consumption`, `Microsoft.DocumentDB`,
`Microsoft.ManagedIdentity`, `Microsoft.Resources`, `Microsoft.Storage`, and `Microsoft.Web`.
Provider registration is a separately recorded bootstrap action, not an incidental plan side
effect.

## What this root creates

- one dedicated resource group and a Standard Azure Static Web App with one stable default
  environment; pull requests remain artifact-only;
- one Node 24 Linux Consumption Function and its dedicated host storage account;
- one serverless Cosmos DB SQL account, database, and `/scopeId` state container with a 24-hour
  control-state TTL; uploaded encrypted envelopes carry a one-hour item TTL;
- a runtime user-assigned identity with only the exact Cosmos container item role and the
  HTTP-only Function host's minimum Blob Data Owner role on its dedicated storage account;
- a GitHub deployment user-assigned identity federated only to
  `repo:CosmaNeura/cosmaneura-scribe:environment:capture-preview`;
- exact-resource deployment roles: Website Contributor on the single Function, Blob Data
  Contributor on only its private `github-actions-deploy` container, and a custom SWA role limited
  to reading that one site's deployment token; and
- a resource-group budget. When no reviewed action group is supplied, the provider-required
  notification is disabled and has no contacts.

Cosmos and Function host storage use public Azure service endpoints because Linux Consumption has
no private egress in this small preview slice. Both disable reusable local credentials and accept
only Microsoft Entra/managed-identity authorization. This is acceptable only for synthetic data;
it is not the future private clinical upload edge.

The Function's direct hostname is public at the network layer. The SWA Function registration
enables the App Service AuthV2 Azure Static Web Apps provider, while this root explicitly owns the
rest of the fail-closed policy: authentication and HTTPS are required, the provider client ID is
the exact SWA hostname, token storage is disabled, and unauthenticated direct requests return a
hard `401` rather than redirecting. AzureRM 4.81.0 registers the Function with the stable default
environment. `preview_environments_enabled=false` is intentional: pull requests remain static
build/test artifacts and only a protected trusted-main workflow may update the live synthetic demo
URL.

On a brand-new graph, Azure writes the provider configuration when it creates the backend
registration after the Function. The mandatory post-apply ARM/direct-endpoint check must therefore
confirm the complete AuthV2 document. If Azure has replaced any Terraform-owned value, stop before
code deployment and use a second freshly saved, independently reviewed in-place plan to converge
the policy; never reuse the bootstrap plan or accept a redirect as proof of denial.

The Function action writes immutable packages only to the private `github-actions-deploy`
container. The runtime user-assigned identity is the named Blob reader for the action-owned package
URL; OpenTofu ignores drift only for that generated URL and continues to own every other app
setting. Do not apply a blanket age-based lifecycle rule to this container: it cannot distinguish
the currently active package. Any later cleanup must retain the active and rollback packages.

## Review and apply

Create ignored local configuration from the examples, then use a saved-plan workflow:

```sh
cp backend.hcl.example backend.hcl
cp preview.tfvars.example preview.auto.tfvars
tofu init -backend-config=backend.hcl
tofu fmt -check -recursive
tofu validate
tofu test
tofu plan -out=preview.tfplan
tofu show -json preview.tfplan > preview.tfplan.json
```

Before apply, independently verify the state lineage/serial, plan hash, exact `add/change/destroy`
counts, all generated global names, and the subscription/tenant. Every managed workload resource
must remain in the dedicated preview resource group. The one explicit ARM exception is the custom
role-definition object, whose assignable scope is still only that preview resource group and whose
assignment is only the exact SWA. Apply only the reviewed saved plan. A later apply with a different
plan is not equivalent.

After apply, set the non-secret values in the `github_environment_variables` output on the
protected GitHub environment `capture-preview`. Do not copy the SWA API key into GitHub. The trusted
workflow exchanges its short-lived environment-bound OIDC token, retrieves the key at runtime, and
passes it only to the SWA deployment action. Keep `CAPTURE_PREVIEW_DEPLOY_ENABLED` and
`CAPTURE_PREVIEW_SHARED_MOCK_READY` false until the Function package, default-registration/AuthV2
checks, cold-start/scale tests, and live synthetic end-to-end acceptance have all passed.
