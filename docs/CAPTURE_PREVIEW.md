# Synthetic capture demo

This environment is a disposable, non-production demonstration of the capture workflow. It accepts
only the fixed synthetic encounter compiled into the preview domain. It has no platform BFF,
clinical authentication, Scribe API, production storage, Speech, Key Vault, PostgreSQL, retention,
or patient-data connection. Real microphone capture is disabled by the build gate and
the site-wide browser Permissions Policy.

The shareable deliverable is one stable Azure Static Web Apps URL. Pull requests still build and
test the PWA and debug APK, but they do not receive a live API. Azure does not support linking a
bring-your-own Function backend to Static Web Apps pull-request environments. Pretending those
URLs are end-to-end previews would fail after the first API call; provisioning a full cloud stack
per pull request is intentionally out of scope.

## Security and persistence boundary

The stable site links one dedicated Azure Function. The Function uses its own managed identity to
access one serverless Cosmos DB container; it has no key or connection string. The browser must
first bootstrap an opaque, `HttpOnly`, `Secure`, `SameSite=Strict` preview cookie. The API hashes
the canonical SWA host and cookie into the Cosmos partition key, so separate browsers cannot see or
mutate one another's state. State and encrypted synthetic envelopes expire automatically.

The hosted profile is deliberately smaller than the protocol ceiling: at most six ten-second
chunks. Requests are runtime-validated against the exact synthetic appointment, practitioner, and
patient identifiers. The public RSA key is a committed public-only test value; no private key is
deployed. Mutation idempotency, upload authorization, immutable envelope registration, completion,
and transcript status survive Function cold starts and scale-out. Upload capabilities are returned
only to the browser; Cosmos retains their digest, not the raw receipt or URL. Every committed
mutation adds one bounded metadata-only audit event.

The Function host rejects bodies above 384 KiB before invocation, and each route applies a smaller
streaming limit. At most 250 new anonymous browser scopes may be created per UTC day; an existing
cookie scope can still refresh after that ceiling. This bounds public-demo state growth without
introducing an identity or collecting a client IP address.

The service worker precaches only emitted static assets. It has no runtime cache and excludes
`/api/**`. API responses, cookies, capabilities, encrypted queue records, uploads, transcripts, and
IndexedDB contents are never service-worker cache entries. The hosted response policy disables the
microphone even if a future JavaScript regression attempted to request it.

Do not enter real names, identifiers, audio, or other patient information into this site. The API
rejects non-synthetic encounter values, but that is a guardrail rather than permission for clinical
use.

## Repository workflows

`.github/workflows/capture-preview.yml` is unprivileged. A same-repository pull request receives a
tested PWA artifact and an ephemeral-debug-signed APK artifact for 14 days. It receives no Azure
identity, deployment token, or cloud state access.

`.github/workflows/capture-preview-deploy.yml` runs only after the required `CI` workflow succeeds
for the exact current `main` commit and the repository variable
`CAPTURE_PREVIEW_DEPLOY_ENABLED=true`. Its build job has no cloud identity. Separate deployment
jobs download only the prebuilt Function ZIP or static directory, authenticate through GitHub OIDC,
and deploy to the protected `capture-preview` environment. The SWA token is fetched from Azure at
runtime, masked immediately, and is never stored as a GitHub secret. A final metadata-only smoke
gate exercises the linked HTTPS API.

Firebase distribution is not part of this Azure deployment. The debug APK remains available as a
GitHub Actions artifact. Stable non-production signing and managed tester distribution can be
reviewed separately; no production signing material belongs in this environment.

## Terraform state bootstrap

The preview is an independent OpenTofu root under `infra/preview/`. It must never share state with
the regulated Scribe development graph. Bootstrap one dedicated state account before the first
`tofu init`:

- resource group: `cosmaneura-capture-preview-state`
- storage account: `cosmaneurapreviewtf`
- private container: `tfstate`
- backend key: `capture-preview/synthetic.tfstate`
- Microsoft Entra data-plane authentication only; shared-key access disabled
- blob versioning, container soft delete, and blob soft delete enabled

The bootstrap account is intentionally outside the state it stores. Grant the operator `Storage
Blob Data Contributor` on only the `tfstate` container. Do not create an account key, SAS, service
principal secret, or local state workaround. Copy `infra/preview/backend.hcl.example` to the
gitignored `infra/preview/backend.hcl` and use the exact reviewed values.

Every infrastructure change follows the saved-plan workflow: protected state snapshot, binary plan,
human and JSON review, exact SHA-256, immediate lineage/serial recheck, apply that binary once, then
live/state reconciliation. A plan containing a destroy, a production connection, or a wider role
assignment is rejected. The only subscription-level object is the custom role definition whose
assignable scope is the dedicated preview resource group; every workload resource and every role
assignment remains inside that boundary.

## GitHub environment configuration

Create the GitHub environment `capture-preview` and restrict deployments to `main`. Add no
environment secret. Configure these non-secret environment variables from the reviewed Terraform
outputs:

- `CAPTURE_PREVIEW_AZURE_CLIENT_ID`
- `CAPTURE_PREVIEW_AZURE_TENANT_ID`
- `CAPTURE_PREVIEW_AZURE_SUBSCRIPTION_ID`
- `CAPTURE_PREVIEW_RESOURCE_GROUP`
- `CAPTURE_PREVIEW_FUNCTION_APP_NAME`
- `CAPTURE_PREVIEW_SWA_NAME`
- `CAPTURE_PREVIEW_SWA_HOSTNAME`

The deploy identity has a federated credential whose exact subject is
`repo:CosmaNeura/cosmaneura-scribe:environment:capture-preview`. It receives only Function-package
deployment on the exact Function, Blob Data Contributor on only its private package container, and
SWA token retrieval on the exact Static Web App. It is not the Function runtime identity and has no
Cosmos data access or role-assignment authority.

Keep the repository variable `CAPTURE_PREVIEW_DEPLOY_ENABLED=false` until infrastructure and role
propagation are verified. Set it to `true` immediately before merging the reviewed implementation,
so the successful `main` CI run triggers the first deployment. Set
`CAPTURE_PREVIEW_SHARED_MOCK_READY=true` only after the live acceptance below passes; this second
variable records readiness and is not a bypass for the deployment gates.

## Live acceptance

The initial deployment is accepted only when all of these checks pass with fixed, metadata-only
output:

1. The direct `azurewebsites.net` Function endpoint returns `401` or `403`; only the linked SWA
   origin reaches the API.
2. SWA root and `/api/capture/preview/health` return HTTPS success with `no-store` API headers.
3. Two clean browser profiles receive isolated sessions and cannot read one another's receipts.
4. A silent synthetic record-to-transcript run completes through consent, session, wrapped-DEK
   receipt, lease, reservation, encrypted upload, registration, completion, and transcript.
5. A Function restart between committed mutations preserves exact idempotent replay.
6. Changed-body idempotency reuse, expired upload authorization, malformed envelope, oversized
   request, missing cookie, wrong origin, and non-synthetic encounter values fail closed.
7. Cosmos contains only bounded synthetic documents with the expected partition key and TTL; the
   encrypted envelope is removed after registration.
8. Azure and GitHub logs contain no request body, cookie, idempotency key, upload capability,
   wrapped DEK, envelope bytes, transcript content, or user-entered values.
9. The browser never requests microphone permission and the deployed CSP/Permissions Policy keeps
   microphone access disabled.

Only after these pass may the stable URL be shared as a synthetic demo. This is not an operational
or clinical acceptance. Real platform auth/BFF, private upload edge, PostgreSQL, transcription
trigger/status, consent revocation, retention controls, signed native releases, and physical-device
evidence remain later gates.

## Disable and recover

Set `CAPTURE_PREVIEW_DEPLOY_ENABLED=false` to stop deployments. Stop the Function first to remove
API access while preserving evidence; keep the SWA link in place so its AuthV2 protection remains
installed. Unlink only after the Function is stopped and its direct endpoint is confirmed closed.
If the API behaves unexpectedly, do not
retry mutations blindly: close access, preserve metadata-only logs, inspect Cosmos/state, fix in a
new reviewed PR, and redeploy one exact `main` commit.

For final teardown, first disable deployment, stop the Function, and confirm its direct endpoint is
closed. Only then may a separately reviewed destroy plan remove the SWA link/site, Function,
identities, Cosmos database/account, storage, and resource group. Delete the GitHub environment
variables and repository gates last. The dedicated state account is retained until final state and
deletion evidence are verified, then removed explicitly.
