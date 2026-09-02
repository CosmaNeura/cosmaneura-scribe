# PostgreSQL provisioning and cutover

This runbook moves the internal scribe API from process memory to durable, private PostgreSQL. It
does not contain credentials. Authenticate locally with interactive `az login`; Azure resources use
managed identities and short-lived Entra tokens.

## Safety boundary

- Never paste a database password, Azure access token, or connection string into chat, GitHub, a
  Terraform variable file, or a Container Apps environment variable.
- Keep `development.auto.tfvars`, backend configuration, and saved plans gitignored.
- Use only synthetic or de-identified records for the first smoke test.
- Do not apply a plan containing replacement or deletion of an existing resource.
- Keep all three PostgreSQL feature flags false until the relevant stage is approved.
- Run bootstrap only in a drained maintenance window: no API traffic and no transcription
  execution may be active. Bootstrap revokes each application's current privileges before
  re-granting its reviewed set, and PostgreSQL evaluates privileges per statement.

## 1. Confirm East Coast provisioning access

Run the subscription-scoped capacity check immediately before planning:

```bash
az postgres flexible-server list-skus --location eastus --output json
az postgres flexible-server list-skus --location eastus2 --output json
```

The result must contain supported server editions and must not report provisioning as restricted.
If both regions remain restricted, request the subscription limit exception described in
[`AZURE_ONBOARDING.md`](AZURE_ONBOARDING.md). Stop here; Central US is not a drop-in replacement for
the existing East US VNet.

## 2. Review the foundation plan

In the gitignored `infra/development.auto.tfvars`, set:

```hcl
deploy_postgres_foundation    = true
deploy_database_migration_job = false
use_postgres_repository       = false
```

Then create a saved plan:

```bash
cd infra
tofu init -backend-config=backend.hcl
tofu plan -out=postgres-foundation.tfplan
tofu show postgres-foundation.tfplan
```

Review the exact add/change/destroy counts, region, SKU, storage, private networking, Entra-only
authentication, diagnostic destination, and estimated recurring price. Apply only the reviewed
saved plan after explicit approval.

The read-only preview on 2026-08-13 was **9 additions, 0 changes, and 0 destroys**. At that time,
Microsoft's East US retail rates were $0.017/hour for B1ms compute and $0.115/GB-month for storage,
or approximately $16.09/month for 730 compute hours plus 32 GB. This excludes usage-dependent
backup overage, private DNS queries, and diagnostic-log ingestion. Treat it as a dated estimate,
not a quote.

## 3. Build and run the bootstrap job

Build the image from the exact reviewed commit and set `container_image_tag` to that commit SHA.
Enable `deploy_database_migration_job`, plan, review, and apply the job definition. Start the job:

```bash
az containerapp job start \
  --name cosmaneura-scribe-dev-migrate \
  --resource-group <scribe-resource-group>
```

Inspect only operational status and sanitized application output. A successful run creates or
verifies the runtime identity's Entra database principal, upgrades to Alembic `head`, and grants the
runtime role its minimal table privileges. If `deploy_transcription_job = true`, the same definition
also passes the distinct worker identity to bootstrap. Re-run the migration job after that identity
is created; bootstrap maps it to a separate Entra database role with only the consent/chunk/key/
transcript reads, transcript/audit inserts, and session/job updates required by transcription. It
has no upload-grant, idempotency, delivery, delete, or DDL privilege. The job does not print tokens,
connection strings, patient data, transcript data, SAS URLs, or object names.

Bootstrap also revokes default privileges on future tables, sequences, and routines from `PUBLIC`
and both application identities before migrations run. It deliberately does not grant blanket
future access: every migration that adds an object needed by the API or worker must update the
corresponding explicit grant list and bootstrap must run again. PostgreSQL ACLs are grantor-scoped
and default privileges are owner-scoped, so bootstrap fails if another grantor/owner leaves access; that grantor/owner must remove it before bootstrap is retried.
Use `pg_shdepend` ACL dependencies to locate the object; owner-side grant-option revocation with `CASCADE` requires separate review because it may remove unrelated downstream grants.

## 4. Switch the API

After the job succeeds, set `use_postgres_repository = true`, plan, and confirm that the change is a
Container App revision/configuration update rather than replacement of the environment, VNet,
storage, or database. Apply the reviewed plan and verify:

- `/healthz` succeeds as liveness;
- `/readyz` succeeds and therefore confirms a database connection;
- a synthetic consent/session survives scale-to-zero and restart;
- another synthetic tenant cannot read it;
- an idempotent replay returns the original result;
- no PHI, token, SAS URL, or object name appears in logs.

## Rollback

If the new revision fails before any durable records are accepted, route traffic back to the prior
Container App revision and set `use_postgres_repository = false`. Do not destroy the database.

After durable writes begin, application rollback must preserve the PostgreSQL repository setting.
Do not use schema downgrade as application rollback; leave additive structures dormant. Any later
removal requires a separately approved contract-cleanup change, founder approval, and proof that no
retained data would be lost. Both the server and application database have `prevent_destroy`
lifecycle protection.
