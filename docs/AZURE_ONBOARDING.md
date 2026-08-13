# Secure Azure onboarding

This guide connects the Cosmaneura product repositories to an existing Azure subscription without
putting passwords, client secrets, storage keys, or access tokens in GitHub, `.env` files, shell
history, issue text, or chat.

The default deployment region is **East US**. Keep all development data synthetic or de-identified
until the deployed service list, networking, logging, retention, and BAA eligibility have been
reviewed for the target environment.

## Bicep, Terraform, and the decision here

[Bicep](https://learn.microsoft.com/azure/azure-resource-manager/bicep/overview) is Microsoft's
declarative infrastructure-as-code language for Azure. A Bicep file says which resources should
exist; Azure Resource Manager performs the deployment and stores the resulting state.

The master Cosmaneura platform already uses Terraform/OpenTofu. The new services follow that
existing toolchain so the team has one state, review, import, OIDC, and deployment model. The
initial Bicep placeholder in this repository has therefore been replaced by the OpenTofu baseline
in `infra/`.

## The credential model

| Context | Authentication | Secret entered into the app? |
|---|---|---|
| Developer workstation | Interactive `az login` with Entra ID + MFA | No |
| Python locally | `DefaultAzureCredential` reads the Azure CLI session | No |
| GitHub Actions | GitHub OIDC federated to one Entra workload identity per repo/environment | No |
| Azure Container Apps | User-assigned managed identity | No |
| True application secrets | Existing 1Password workflow and/or Key Vault references | Only in the secret manager |

Do not create client secrets for routine CI/CD. Do not enable storage account keys. Do not paste any
credential into chat. Subscription, tenant, resource-group, resource, and client IDs are identifiers,
not authentication secrets, but they should still be handled as internal configuration.

## 1. Install and sign in on this Mac

If Azure CLI is not installed, Microsoft supports installing it with Homebrew on macOS:

```bash
brew update
brew install azure-cli
az version
```

Then sign in through the browser and complete MFA. If the account belongs to more than one tenant,
include the intended directory/tenant ID:

```bash
az login --tenant <tenant-id>
az account set --subscription <subscription-name-or-id>
az account show --query '{subscription:name, subscriptionId:id, tenantId:tenantId}' --output table
```

The final command prints identifiers only; it does not reveal the cached access token. Never use
`az login --user ... --password ...` for this workflow. Microsoft documents interactive Azure CLI
authentication at
[Sign into Azure interactively](https://learn.microsoft.com/cli/azure/authenticate-azure-cli-interactively).

When this succeeds, tell the coding agent only: **"Azure CLI is signed in to the development
subscription."** The agent can inspect resource identifiers with read-only Azure CLI calls; no token
or password needs to be copied.

### Remote state permission

OpenTofu uses Entra authentication for the remote state backend. A subscription Owner does not
automatically receive Azure Storage data-plane access. Grant each developer or CI plan identity
`Storage Blob Data Contributor` on only the state container; do not distribute an account key.

An Azure administrator can use the portal or this command after replacing the identifiers:

```bash
az role assignment create \
  --assignee-object-id <entra-object-id> \
  --assignee-principal-type User \
  --role "Storage Blob Data Contributor" \
  --scope /subscriptions/<subscription-id>/resourceGroups/<state-resource-group>/providers/Microsoft.Storage/storageAccounts/<state-account>/blobServices/default/containers/<state-container>
```

For GitHub OIDC, use the workload identity's object ID and
`--assignee-principal-type ServicePrincipal`. Permission changes can take several minutes to
propagate. Keep `use_azuread_auth = true` in `backend.hcl`.

The AzureRM provider also sets `storage_use_azuread = true`. Any identity that plans or applies
Blob properties and containers therefore needs an appropriate data-plane role on the scribe
storage account (`Storage Blob Data Reader` for read-only plans and `Storage Blob Data Contributor`
for applies). Do not work around a missing role by enabling shared keys.

## 2. Inventory the existing development environment

These commands are read-only:

```bash
az group list --query '[].{name:name,location:location}' --output table
az resource list --resource-group <resource-group> --query '[].{name:name,type:type,location:location}' --output table
az network vnet list --resource-group <resource-group> --query '[].{name:name,id:id}' --output table
az network vnet subnet list --resource-group <resource-group> --vnet-name <vnet-name> --query '[].{name:name,id:id}' --output table
az network private-dns zone list --resource-group <resource-group> --query '[].{name:name,id:id}' --output table
az monitor log-analytics workspace list --resource-group <resource-group> --query '[].{name:name,id:id}' --output table
az acr list --resource-group <resource-group> --query '[].{name:name,id:id,loginServer:loginServer}' --output table
az containerapp env list --resource-group <resource-group> --query '[].{name:name,id:id,location:location}' --output table
```

Record only the selected resource IDs/names in a gitignored `.env` or local Terraform variable file.
Do not put keys or connection strings in that file.

Recommended reuse boundary:

- Reuse: subscription, East US VNet, private-endpoint subnet, private DNS zones, Log Analytics,
  Container Apps environment, and container registry when their compliance posture matches.
- Create separately per product/environment: storage accounts, Blob containers, databases/schemas,
  Key Vault scope, managed identities, Service Bus topics/subscriptions, and audit/retention policy.
- Never import an existing resource into Terraform until a reviewed `tofu plan` shows that the
  configuration will not replace or weaken it.

The 2026-08-13 inventory found no compatible VNet, private-endpoint subnet, or Blob/Key Vault
private DNS zones in East US. The scribe development configuration therefore creates those
resources in its dedicated resource group. Existing West US, West US 2, and North Central US
resources are not reused for the East US PHI path.

## 3. Configure passwordless GitHub Actions access

Use a separate user-assigned managed identity for each repository and environment. Grant it only the
roles required to plan/apply that environment. The production identity must not be shared with
development.

For the development GitHub environments, create federated credentials with these subjects:

```text
repo:CosmaNeura/cosmaneura-scribe:environment:development
repo:CosmaNeura/cosmaneura-scheduling:environment:development
```

Create an additional `pull_request` subject only if pull-request Terraform plans need direct Azure
read access. Microsoft describes this passwordless setup in
[Authenticate to Azure from GitHub Actions with OIDC](https://learn.microsoft.com/azure/developer/github/connect-from-azure-openid-connect).

In each GitHub repository, create a protected `development` environment and add these **Actions
variables**:

```text
AZURE_CLIENT_ID
AZURE_TENANT_ID
AZURE_SUBSCRIPTION_ID
```

These are identifiers. There should be no `AZURE_CLIENT_SECRET`. The workflow must declare:

```yaml
permissions:
  contents: read
  id-token: write
```

and authenticate with `azure/login` using the three variables. Require environment approval for any
workflow that applies infrastructure.

Bootstrap role scope:

- Terraform plan identity: Reader on the dedicated development resource group, plus data-plane
  access to the remote-state container.
- Terraform apply identity: Contributor on the dedicated development resource group. Grant a
  narrowly scoped role-assignment capability only if Terraform must create RBAC bindings.
- Do not grant subscription Owner to either identity.

## 4. Configure runtime managed identities

Each API/worker receives its own user-assigned managed identity. Azure Container Apps can use this
identity to obtain Entra tokens for Storage, Key Vault, Service Bus, and other supported services
without credentials in environment variables. See
[Managed identities in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/managed-identity).

Initial scribe roles, scoped to the exact resource:

- Storage Blob Data Contributor on the scribe storage account. This also permits generation of a
  short-lived user-delegation SAS for one encrypted object.
- Key Vault Secrets User on the scribe vault when the service must resolve a secret.
- Service Bus Data Sender/Receiver only on the topics/subscriptions the process uses.
- PostgreSQL runtime access is created inside the database by a separate migration identity; the
  API identity is not an Entra database administrator.

The scribe API now uses `DefaultAzureCredential` and generates a user-delegation SAS rather than
using an account key. Microsoft documents this pattern at
[Create a user-delegation SAS with Python](https://learn.microsoft.com/azure/storage/blobs/storage-blob-user-delegation-sas-create-python).

PostgreSQL follows the same passwordless model. A dedicated migration managed identity is the
server's Entra administrator and runs the manual bootstrap job. That job creates the runtime
identity's database principal and grants only the operations the API requires. The API requests a
short-lived token for `https://ossrdbms-aad.database.windows.net/.default`; no database password or
connection string is placed in Container Apps, Key Vault, Terraform state, or GitHub.

## 5. Enter true application secrets

Azure identity does not require a secret. A small number of non-Azure integrations may still do so.
Use one of these approved paths:

1. Enter the value in the existing Cosmaneura 1Password vault, then let the established deployment
   workflow sync/reference it.
2. Enter the value directly in Azure Portal → Key Vault → Secrets, using a named administrative
   account protected by MFA.

Container Apps should reference Key Vault through managed identity; the secret value is never copied
into Terraform or GitHub. See
[Key Vault references in Container Apps](https://learn.microsoft.com/azure/container-apps/manage-secrets).

Never:

- paste a secret into chat, an issue, a PR description, or a terminal command argument;
- commit `.env`, `*.tfvars`, Terraform plans, Azure profiles, or downloaded credentials;
- use `AZURE_CLIENT_SECRET` when OIDC or managed identity is available;
- store Blob account keys or long-lived SAS tokens;
- put PHI into Stripe, telemetry attributes, resource tags, blob names, or queue metadata.

## 6. Safe local app configuration

Copy the non-secret template:

```bash
cp .env.example .env
```

For local mock storage, keep:

```text
COSMANEURA_SCRIBE_STORAGE_BACKEND=memory
```

After Azure RBAC and private networking are ready, change only these non-secret values:

```text
COSMANEURA_SCRIBE_STORAGE_BACKEND=azure
COSMANEURA_SCRIBE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net
COSMANEURA_SCRIBE_STORAGE_CONTAINER_NAME=audio
AZURE_TOKEN_CREDENTIALS=dev
```

For local development, keep PostgreSQL disabled unless using a disposable local test database:

```text
COSMANEURA_SCRIBE_REPOSITORY_BACKEND=memory
```

The deployed API receives only these non-secret PostgreSQL identifiers from OpenTofu:

```text
COSMANEURA_SCRIBE_REPOSITORY_BACKEND=postgres
COSMANEURA_SCRIBE_DATABASE_HOST=<private-server-fqdn>
COSMANEURA_SCRIBE_DATABASE_NAME=cosmaneura_scribe
COSMANEURA_SCRIBE_DATABASE_USER=<runtime-managed-identity-name>
```

Do not set `COSMANEURA_SCRIBE_DATABASE_URL` in Azure. That option exists only for disposable local
and CI PostgreSQL instances. The Azure runtime uses its managed identity and TLS.

`DefaultAzureCredential` will use the Azure CLI session. In the deployed Container App, set
`AZURE_TOKEN_CREDENTIALS=prod`, attach the runtime managed identity, and set this non-secret value
to the identity's client ID:

```text
COSMANEURA_SCRIBE_MANAGED_IDENTITY_CLIENT_ID=<runtime-managed-identity-client-id>
```

## 7. Connection readiness checklist

- [ ] Azure CLI installed and interactive MFA login succeeds.
- [ ] Correct subscription selected; no production subscription is selected accidentally.
- [ ] East US resource group and private networking targets identified.
- [ ] Existing ACR, Container Apps environment, Log Analytics, and private DNS compatibility checked.
- [ ] Dedicated development managed identities created for CI and each runtime.
- [ ] GitHub OIDC subjects exactly match repository casing and environment names.
- [ ] GitHub development environment requires approval for apply/deploy.
- [ ] Storage shared-key access disabled; public blob access disabled.
- [ ] Private endpoints and DNS resolution tested from Container Apps.
- [ ] Key Vault uses RBAC, purge protection, private networking, and managed-identity references.
- [ ] Only synthetic/de-identified data used during validation.
- [ ] Current Azure HIPAA-eligible-service list confirmed for every service in the PHI path.
- [ ] PostgreSQL Flexible Server provisioning is available for this subscription in the selected
      East Coast region.
- [ ] Migration identity is the PostgreSQL Entra administrator; runtime identity is not.
- [ ] Manual database job completed before `use_postgres_repository` is enabled.

## 8. Current regional provisioning prerequisite

On 2026-08-13, Azure's subscription-scoped PostgreSQL SKU API reported new Flexible Server
provisioning as restricted in both **East US** and **East US 2** for the development subscription.
Central US reported capacity, but using it would require a separate cross-region network design and
is not an automatic substitute for the approved East Coast topology.

An Azure subscription administrator should open Azure Portal → **Help + support** → **Create a
support request** → **Service and subscription limits (quotas)** and request PostgreSQL Flexible
Server provisioning in East US, with East US 2 as the acceptable fallback. Include the target SKU
`B_Standard_B1ms`, PostgreSQL 16, and one development server. No credential or PHI belongs in the
request. Re-run the subscription capacity check before any apply.
