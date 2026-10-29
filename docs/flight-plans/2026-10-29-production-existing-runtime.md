# Production capture on existing Core hosting — Tier 2

This is source and unapplied-plan preparation. It authorizes no Azure, SQL,
identity, Clerk, model, registry, traffic or production-data mutation. Hashes
bind technical evidence; they are not an attestation, legal agreement, founder
approval or completed qualification. The founder owns each production dispatch.

## Placement and ownership

Keep the existing Core app, worker, scheduler, PostgreSQL server, password
authentication and firewall rules under Core's IaC owner. The Scribe API and
native receiver remain separate revisions on Core's existing Container Apps
environment. Use the isolated logical `cosmaneura_scribe` database on the existing
server, API pool 2/0 and job pools 1/0. Do not create a paid hosting environment,
PostgreSQL server, Speech account or model deployment.

The applied Scribe foundation's internal environment runs the separate speech
and translation jobs. Their command is `cosmaneura_scribe.captured_worker_job_runner`,
not the legacy transcription job. Each has its own UAMI; enabled configuration
uses ManagedIdentityCredential and has no DATABASE_URL. Empty cohort plus manual
trigger and captured-worker false keep the prepared jobs nonoperational.

Reuse the existing `cosmaneuraprodopenai` AIServices account and its
`gpt-4.1-2025-04-14` deployment. Metadata-only ARM GETs verify kind, normal Speech
endpoint, transcription capability and model. Never query account access keys.
Add a private endpoint and the cognitive/openai/services.ai private DNS zones
within Scribe's VNet. Guard Speech and translation against the actual private
endpoint's one host /32; verify every DNS answer before the first synthetic call.
Do not alter the shared AI account's public/local-auth configuration.

## Independent preparation rungs

1. **Key custody:** PR488's production AzAPI RSA3072 wrapping-key create and
   key-scoped API Key Vault Reader. The existing two-create plan is unapplied.
   Both key owners preserve prevent_destroy; nonproduction AzureRM ownership is
   unchanged. API obtains public metadata and wraps locally; it never receives
   Crypto User or unwrap permission.
2. **Core-owned authentication:** merged Core PR885 adds default-off Entra auth
   on the existing server while password auth stays enabled. Its separately
   gated Scribe migration administrator is the exact migration UAMI. Generate
   the canonical Core-owner plan with its real protected inputs, review it and
   apply only after founder authorization. Scribe never adopts or duplicates
   the server. Observed Entra Disabled is an activation blocker, not a reason
   to substitute a password in captured-worker DATABASE_URL.
3. **Disabled private workers:** prepare two manual disabled jobs, two UAMIs,
   AcrPull and private paths to existing Core PG and AI. The PG NSG addition is
   only TCP5432 from Scribe's private ACA subnet to the PE subnet. No Blob,
   AI or key Crypto User grant exists in this rung. Immutable worker image
   publication is separate. Retained image use requires relevant runner/import
   inputs to be byte identical; a new API image must include later API changes.
4. **Bounded existing-host network:** follow the exact technical policy below.
   This is independently reviewable before any native identity/clinical cohort
   is populated. It creates no API or processing workload and starts no capture.
5. **Dark database/API/receiver:** use PR486's existing-host mode, real receiver
   manifest/session claims/native policy bindings, immutable current API and
   receiver images and read-only registry role. Publish reviewed images, create
   the isolated logical DB, run the existing manual bootstrap and expand schema
   only with separate founder authorization and rehearsal. Core registry read
   access, Scribe.Workflow.Access and Transcript.Write must be verified.
6. **Scoped role/model canary:** bind the founder-authorized real cohort, use
   configured-worker DB grants through the existing database_bootstrap rung,
   then separately enable workers and their scoped processing permissions.
   Confirm schema, exact principal identities, tenant grants, key versions,
   private DNS, assembly encryption and actual Speech/GPT4.1 capability/cost.
   API/runtime remains off during this worker qualification.
7. **Paired native canary:** existing-host runtime requires actual Core Entra
   Enabled/password Enabled, qualified private workers and real cohort, paired
   receiver/client evidence and live GET of the already-dark Scribe API's exact
   outbound IP. Set capture protocol/runtime; enable receiver and encounter
   creation only after their separate gates. Verify native production Clerk
   publishable key/session claims and Core organization mapping, authenticated
   capture/Save/reopen/dashboard/Listen, tenant isolation and bounded PG load.
   Synthetic operational canary precedes any clinical cohort activation.

No activation plan is represented as ready until these live gates pass. The
source's validation accepts receipt shape; independent review/operator checks
must confirm the evidence actually exists and covers the exact current inputs.

## Bounded network and upload policy

The existing non-VNet Core environment cannot reach Scribe's private Key Vault
or Blob endpoints. Keep both private endpoints and worker custody. Separately
set Key Vault public access true with default Deny, bypass None, no subnet
exceptions, and only **64.236.176.41/32**, verified from Core app's outbound IP.
Its ingress/static IP 135.224.13.80 is never an egress allowlist. Activation also
reads the actual already-dark Scribe API; IP drift or multiple egress addresses
stops the rung rather than broadening a range or adding AzureServices bypass.

Expose Blob's TLS data endpoint for encrypted user-delegation SAS PUTs. Keep
shared keys, local users, nested anonymous/public containers disabled, OAuth
default and the audio container private. The existing storage provider mints
object-specific Create/Write SAS only with a 15-minute default TTL and TLS-required
storage transport; it
grants no Read/List/Delete. Preserve the source's exact native origin CORS and
retention controls. Public ciphertext reachability is an explicit boundary
change requiring this reviewed plan and founder approval, not a global vault
opening. A network hash is technical policy evidence and grants no consent.

The enabled private speech identity alone receives Blob Reader; each worker's
Crypto User grant is at the wrapping key, never the vault. Translation gets
OpenAI User and speech gets Speech User at the existing AI account. These grants
exist only after the worker activation rung; API stays Reader only.

## Review and recovery

Two independent saved preparation plans against the existing Scribe backend
must show no Core resource updates or deletes/replacements. The worker plan
adds two PEs/four DNS zones (about $16.60/month at retained retail rates), plus
identity/manual-job resources with no running compute. Network preparation has
no fixed new service cost; key/storage/transfer/log and eventual model/job usage
are additional and require cost acceptance. Existing foundation approval is not
automatic authorization for these plans or usage. Azure has no hard billing cap.

After review, reconcile source/main, state lineage/serial, Azure IDs, image
digests and current ownership before founder dispatch. Saved no-refresh plans
are review artifacts; regenerate with current live controls before applying.
Never expose raw plan/state, receiver claims, credentials or provider errors in
PRs, browser tabs or conversation; publish only verified safe projections.

Recovery stops new capture/admission and schedules, drains accepted work,
preserves ciphertext and schema, then returns receiver/API gates to false.
Revoke bounded public access only after in-flight SAS expiry and drain are
verified. Remove no key, vault, database, table or retained recording as rollback.
Password auth/Core owner work remain. Removing prepared private paths or roles
requires its own reviewed plan after clients/jobs stop; source flags alone do
not claim security or data rollback.
