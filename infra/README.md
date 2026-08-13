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

This first slice provisions a dedicated East US VNet and private DNS, private Blob custody, Key
Vault, private endpoints, a runtime managed identity, and least-privilege data-plane roles.
PostgreSQL, Container Apps, Service Bus, monitoring, CMK wiring, retention automation, and
deployment identities follow in reviewed slices.
