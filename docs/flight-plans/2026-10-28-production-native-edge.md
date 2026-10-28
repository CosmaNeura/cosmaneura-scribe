# Flight plan: production native Scribe edge

## Outcome and boundaries

- Problem and measurable outcome: provide a reviewable Azure plan that can host
  the two Scribe production workloads required by the current clients and Core:
  an HTTPS standalone native receiver and the Entra-protected workflow API.
  The plan must remain false by default and must not claim that the existing
  private-only Scribe foundation is reachable from production callers.
- In scope: a dedicated production-only external, VNet-injected Container Apps
  environment on its own delegated subnet, leaving the existing private
  environment and subnet intact; two separately authenticated public ingress
  workloads; private Key Vault and PostgreSQL paths; a private endpoint to the existing Core
  registry PostgreSQL server; immutable image inputs; and a public Blob data
  endpoint limited by Azure authorization to short-lived create/write
  user-delegation SAS grants for encrypted envelopes.
- Explicit non-goals: building or pushing the receiver image, applying this
  plan, creating secrets, changing Clerk/Core/Azure grants, applying migrations,
  distributing a client, enrolling a cohort, or activating production.
- Affected surfaces if separately applied: the dedicated production Scribe
  resource group and VNet, the existing Scribe ACR, the referenced existing
  Scribe workflow managed identity, and a private endpoint on the existing Core
  registry PostgreSQL server. The public Blob endpoint carries encrypted
  envelopes; the receiver and workflow API process protected clinical data.

## Risk and dependencies

- Tier: Tier 2 because network reachability, workload identity, authentication,
  PostgreSQL access, encrypted audio custody, and production deployment are in
  scope.
- The current production Core Container Apps environment is public and has no
  VNet. The production resource group has no shared VNet. Native iOS/Desktop
  clients also call the receiver directly. Therefore neither the standalone
  receiver nor the workflow API can be private-only without first introducing
  a separately owned connectivity change. Both workload ingresses are public in
  this plan and retain application authentication and exact authority binding.
- The standalone receiver validates Clerk production issuer, audience,
  organization, session, exact native origin, exact receiver host, and the
  receipt-bound native policy. It then calls public Core using the explicitly
  supplied existing Scribe workflow UAMI and reads only its configured Core
  registry database role. The workflow API independently validates Entra tokens
  from Core's exact trusted client ID and audience.
- Dependency order, each safely holdable: (1) merged, independently reviewed
  receiver image source with the contract below; (2) Core production native
  policy/routes and read-only registry role held dark; (3) this infrastructure
  PR merged with all flags false; (4) real provider plan plus Azure
  name/capacity/private-endpoint verification; (5) foundation and both
  digest-pinned apps deployed dark;
  (6) database migration; (7) synthetic canary activation; (8) separately signed
  clients and an explicitly authorized beta cohort.
- Receiver image contract: merged source `f6cac86283bea56b407c50f3f9435e8978f12129`
  provides the fail-closed package and launcher, but no production image has
  been built or approved. A future image input requires an immutable digest and
  exact source commit. The image accepts exactly
  `COSMANEURA_SCRIBE_PROVIDER_CONFIGURATION_JSON` and
  `COSMANEURA_SCRIBE_PROVIDER_IMAGE_CONTRACT_SHA256` within the provider prefix.
  The second value is the SHA-256 of the packaged
  `/app/provider/receiver-image-manifest.json`. The fixed non-root launcher
  verifies that manifest, the five packaged receiver/launcher source hashes,
  the prepared identity-source manifest, fixed entrypoint
  `/app/provider/image_entrypoint.py`, fixed runtime target
  `/app/provider/serve.py`, runtime user `10001:10001`, and configuration path
  `/app/provider-config/receiver.json`. It then writes the supplied JSON once,
  byte-for-byte and mode `0600`, validates it through `ReceiverConfiguration`,
  removes both environment values, and execs the server on TCP 8080. Missing,
  extra, malformed, mismatched, embedded-config, credential, pre-existing-file,
  or source-identity failures stop before the listener. This PR supplies only
  the infrastructure input contract, not an image build or manifest hash.
- The external UAMI must already exist and be separately granted only ACR pull,
  the exact Core API application role, and the exact read-only Core registry
  database role. Terraform verifies the supplied resource ID and client ID but
  cannot prove the external Core role or database grant.

## Current deployed state

- Source base: `f6cac86283bea56b407c50f3f9435e8978f12129`.
  No Azure state or live configuration is read or changed by this PR.
- Merged image-packaging source can prepare a deterministic, disabled receiver
  context. Its static smoke fixture uses synthetic base-image digests and is not
  a production manifest or deployment input. A real context must be prepared
  from reviewed immutable base-image digests and the final merged source.
- Existing Terraform models one internal-load-balancer Scribe Container Apps
  environment and storage with public networking disabled. That is appropriate
  for its current private foundation but cannot serve the native clients or the
  public/no-VNet Core workload.
- The current workflow API issues short-lived, create/write-only user-delegation
  SAS URLs and the clients PUT an already encrypted complete envelope directly
  to Blob. Consequently the Blob data endpoint must be publicly routable for
  this client contract. Shared keys, local users, and anonymous container/blob
  reads remain disabled; the private endpoint remains for server-side access.
- Reconciliation decision: retain all current defaults and the private
  environment unchanged. The production-only edge flag adds a separate delegated
  subnet and external environment, moves the not-yet-deployed production workflow
  API onto that environment, and enables digest pinning only when the full
  reviewed production binding is supplied.
- The 2026-10-28 live VNet inventory invalidated the original `10.44.0.0/16`
  production example because scheduling development already owns that prefix.
  The corrected example uses the observed-unused `10.46.0.0/16`; it remains
  unreserved and must pass the checked-in overlap guard against a fresh inventory
  immediately before every plan and apply.
- Previous known-good artifact: the current false-default private foundation.
  There is no prior production receiver image or deployable production client
  path to designate as known-good.

## Feature flag / release control

- `deploy_production_native_edge` creates the dedicated external environment and
  subnet, private Core registry endpoint, and both apps while keeping the native
  receiver at zero replicas and its runtime configuration disabled. It does not
  convert or expose the existing private Container Apps environment.
- `enable_capture_protocol` remains the workflow API's authenticated capture
  gate. `enable_production_native_direct_upload` separately opens the Blob data
  endpoint and exact native CORS origins after an upload-policy receipt is bound.
- `enable_production_native_receiver` requires both of those gates and raises the
  receiver to one minimum replica. `enable_production_native_encounter_creation`
  is a final independent receiver gate.
- The founder owns activation. These controls have no implicit cohort, expiry,
  or production approval; the production promotion record must name the exact
  practice/cohort, expiry, image digests, configuration hashes, migration head,
  and rollback owner before any true value is applied.
- Removal condition: remove temporary dark-deployment controls only after a
  separate operational PR establishes permanent deployment and rollback policy.

## Schema/data sequence

N/A in this PR: it adds no schema, migration, backfill, or data rewrite. A future
promotion must run the existing migration job at the same workflow image digest
before enabling capture and must record the resulting Alembic head.

## Rollout and promotion

1. Run provider-mocked plans and negative tests. These prove Terraform control
   relationships only; they do not prove Azure SKU capacity, name availability,
   provider behavior, DNS, private endpoint acceptance, identity grants, or
   application health.
2. Build the separately reviewed receiver image and workflow image once. Record
   source commits, image digests, SBOM/signing evidence, and the receiver image
   contract hash. Reject mutable tags at the production edge.
3. Run a real read-only production plan with all behavior flags false. Confirm
   the new ACA environment is external and VNet-injected on its dedicated subnet,
   the existing ACA environment remains internal/private without replacement,
   both workloads use their exact digest, Key Vault and both PostgreSQL paths are
   private, and storage remains nonpublic until the upload gate. Abort on
   replacement of any existing environment/subnet/resource, an overlapping CIDR,
   an unexpected role, an unbounded public endpoint, or an unavailable PostgreSQL
   private-link subresource/capacity.
4. Apply the foundation and apps dark under a separate approved production
   change. Confirm the native receiver has zero minimum replicas and config
   `enabled=false`; confirm the workflow API rejects missing/wrong Entra tokens;
   confirm Key Vault, Scribe PostgreSQL, and Core registry PostgreSQL deny public
   access and unintended identities.
5. Apply the migration job at the same digest and record one schema head. Enable
   the encrypted direct-upload gate only after confirming user-delegation SAS is
   create/write only, short-lived, single-object scoped, and a request without
   SAS cannot read or write. Confirm the native origins' preflight and PUT and
   reject other origins.
6. Enable the native receiver for one explicitly authorized synthetic canary.
   Verify wrong host, wrong Origin, missing/expired Clerk session, wrong audience,
   wrong organization, wrong Core role, and missing registry membership all fail.
   Verify one synthetic record/Finish/Save/reopen/Listen/dashboard journey and
   Core-to-workflow call. Keep encounter creation off until its own canary passes.
7. Hold for an observation window and then separately distribute signed clients
   to the bounded beta cohort. No staging result substitutes for this installed
   production acceptance.

Abort on any unauthorized 2xx, plaintext/audio in logs, identity fallback,
shared-key use, anonymous Blob access, cross-practice data, receipt mismatch,
public database/Key Vault path, error-rate regression, or stranded encrypted
queue item. Thresholds and telemetry queries must be recorded in the production
change packet because this source PR has no live baseline.

## Security and recovery

- Public ingress is necessary reachability, not public authority. The receiver
  remains Clerk/session/organization/origin/host protected. The workflow API
  remains Entra audience/client protected. Azure Container Apps TLS and system
  trust are used by existing clients; this PR introduces no certificate pin.
- The Blob endpoint is publicly routable only to honor the current direct-upload
  contract. Authorization remains per-object user-delegation SAS with create and
  write only; anonymous access, local users, and shared keys stay off. Encrypted
  envelopes and pending queue data must not be deleted during rollback.
- Behavioral rollback order: close cohort/client activation; turn off encounter
  creation; turn off receiver; turn off capture after in-flight uploads settle;
  drain/retain pending encrypted objects; restore the prior digest if an app
  rollback is safe. The upload endpoint may need to remain reachable until every
  already-issued short-lived SAS expires and pending queues are reconciled.
- Infrastructure rollback is not an immediate destroy. Preserve Key Vault,
  storage, databases, private endpoints, migrations, audit records, and pending
  encrypted data. Remove public reachability only after the drain record proves
  no installed client or Core caller depends on it.
- Observation window before irreversible cleanup: at least the longest client
  queue retention, SAS lifetime, and clinical retention window, determined and
  recorded by the production owner. No irreversible cleanup is part of this PR.

## Completion

- Source completion requires `tofu fmt`, `tofu validate`, provider-mocked positive
  and negative plans, exact-SHA independent review, and a clean diff. It does not
  make production deployable by itself until a real receiver context is built,
  its manifest hash is bound, its immutable image digest is published, and both
  artifacts are independently reviewed.
- Production completion additionally requires the real plan/apply records,
  image and contract receipts, identity/database grants, migration evidence,
  negative authorization matrix, encrypted-upload denial/retention checks,
  synthetic canary, installed-client acceptance, rollback rehearsal, and founder
  cohort authorization.
- Follow-up owners: receiver-image owner builds/publishes the deterministic image
  from reviewed real base-image digests and supplies its packaged manifest hash;
  Core owner supplies exact API role/native routes/read-only registry role;
  production owner supplies receipts and executes the controlled Azure change;
  client owner builds/signs the receiver and upload origins into both apps.
- Update this plan and the production organization profile if any origin,
  identity, image contract, upload method, network topology, or rollback boundary
  changes.
