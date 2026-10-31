# Existing Core public AI transport — Tier 2

The existing Core Container Apps environment has no VNet subnet. Its current
AI account, `cosmaneuraprodopenai`, already exposes public Speech-to-Text and
OpenAI endpoints. Existing Scribe workers require private endpoint DNS answers,
so putting those workers in the existing Core containers cannot use that
unchanged private transport. Prepare one explicit, default-off source selector
for the already-existing account. No endpoint, model deployment, dependency,
Container App/job or paid resource is added.

`existing_core_public_ai_enabled=false` retains the existing private guard and
private CIDR requirement. The new selector allows only the exact Core PostgreSQL
host with SSL and a nonzero managed identity, the exact Core Speech/OpenAI hosts
and existing dated translation deployment. Mixed private/public configuration
is rejected. Every guarded operation resolves the exact selected host and
requires all DNS answers to be globally routable; empty, private, local,
link-local, malformed or mixed answers deny. The existing adapter still owns
exact HTTPS origin/path, bounded response, credential and deadline checks.
Speech in the new mode requires `AZURE_TOKEN_CREDENTIALS=ManagedIdentityCredential`
before constructing its SDK credential. The worker runner already enforces that
same value. Default private configuration and existing staging settings remain
unchanged.

The source base is the independently reviewed merged receiver consumer,
`d4c4679fcf9bc2487b986d80b5d5443e02e190b5`, tree-identical to candidate c823.
Offline focused checks cover default transport, exact resource bindings, both
worker stages, managed-identity-only credential selection, unsafe DNS answers
and unchanged existing worker composition. They do not make AI calls, read
PostgreSQL, access secrets or exercise production credentials.

This leaf does not qualify the whole three-container topology. Existing Scribe
Terraform still declares separate Apps/jobs and private AI endpoints. Core API
dispatch and bounded existing-worker scheduling require their own source rung.
Existing Scribe Key Vault and Blob private custody must also have a separately
reviewed exact-Core-egress decision; their current public upload/key-read flags
do not grant worker read/unwrap access. Actual production schemas, tenant,
principals, grants, native creation/capture parity, cohort and receipts remain
held owner inputs. No permission, SQL, bootstrap, Azure mutation, image
publication, deploy or activation is performed by this source preparation.

Independent review must bind the final commit and focused check receipts before
publication. Before deployment, discard this commit. After separately approved
deployment, disable new pickups, drain accepted work under the existing capture
recovery procedure, disable this selector and restore the qualified prior image.
Do not fall back to CLI credentials or alter retained recordings, keys, schemas,
provider mappings or audit data as recovery.
