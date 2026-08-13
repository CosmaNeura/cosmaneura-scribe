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

The API has VNet-only ingress and scales from zero to one replica because its repository is still
process memory. PostgreSQL, Service Bus, CMK wiring, retention automation, authenticated master
connectivity, and deployment identities follow in reviewed slices.
