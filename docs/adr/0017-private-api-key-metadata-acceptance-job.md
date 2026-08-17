# ADR 0017: Prove the private key-metadata route with the platform identity

**Status:** Accepted (deployment, enablement, and invocation remain disabled)

## Context

The authenticated `GET /v1/audio-encryption-key` route must be proven from the private Container
Apps network after the wrapping key and API revision are applied. The temporary Terraform identity
is deliberately overqualified for an API test and does not hold the `Scribe.Workflow.Access` Entra
application role. The live platform runtime does hold that role, but its separate VNet path is not
yet deployed.

The proof must not expose the public modulus, key version, token, request URL, synthetic tenant, or
response body in logs. It must not grant the platform caller Key Vault access or create a second
identity that behaves differently from the real caller.

## Decision

Add one false-by-default manual Container Apps Job to the existing private Scribe environment. It
looks up and attaches the exact existing platform workflow user-assigned managed identity. A
Terraform precondition requires the resolved identity's client ID to equal the one configured as
Scribe's trusted platform caller. The stack creates no identity and grants that principal only a
temporary `AcrPull` assignment on the exact Scribe registry. The existing external
`Scribe.Workflow.Access` app-role assignment is unchanged. No Key Vault, Blob, Speech, database,
subscription, resource-group, or job-start role is granted.

Deployment, API configuration, and invocation use three independent gates, all defaulting to
`false`. The job is manual, has one completion, parallelism one, zero platform retries, a bounded
timeout, no ingress, schedule, event rule, runtime arguments, secret, or Terraform-created start
permission. Its image is selected by immutable registry digest and records the reviewed source
commit. Its command is fixed to the acceptance module, which rejects every argument.

Terraform derives the stable API ingress origin and the Container Apps environment static IP. The
runner first requires every DNS answer to equal that exact private `/32`; it obtains no token if
private DNS is unavailable or resolves elsewhere. It then uses `ManagedIdentityCredential` with
the exact platform identity client ID and requests only the Scribe API's `/.default` scope. The
single request carries a configured synthetic practice-tenant UUID.

The runner disables redirects and proxy-environment trust, bounds the decoded response to 8 KiB,
requires HTTP 200 and the exact `AudioEncryptionPublicKey` schema, and proves RSA-3072,
`RSA-OAEP-256`, `wrapKey`-only public operations, and a present key-version identifier. Success
emits one constant metadata record containing only status, key type, algorithm, size, operations,
version presence, and duration. Failures emit only fixed classes.

The application `Settings` model is the single authority for the probe's HTTP timeout, which is
also its enforced maximum. Terraform does not duplicate it as a job environment value. The
Container Apps Job retry limit remains zero and the authenticated probe gains no retry.

**Correction (2026-08-17).** This ADR originally claimed the 60-second budget "covers one
scale-to-zero API cold start." A live execution disproved that: Container Apps internal ingress
answered with a non-200 before any replica existed, while API request metrics stayed at zero. The
earlier 15-second budget had already expired during image pull and start with zero requests
reaching the API. A gateway that answers early with an error cannot be outwaited, so no client
timeout value covers cold start. The two-phase contract below replaces that assumption.

## Amendment (2026-08-17): two-phase acceptance contract

Acceptance is split into two phases so cold start is handled where it occurs — the platform — while
the thing under test keeps its zero-retry proof.

1. **Readiness phase.** Bounded polling of the unauthenticated, ops-open `/healthz` route.
   Ingress-layer non-200 responses and transport errors count as "not ready yet," never as
   acceptance failures. Readiness requires two consecutive 200 responses. The poll interval and a
   hard overall deadline are pinned in `Settings` as the single authority (suggested: 240 seconds
   of polling inside the job's 300-second execution budget). Exhausting the deadline emits its own
   fixed failure code, distinct from every probe failure class. The readiness result records only
   poll count and elapsed milliseconds as numbers.
2. **Probe phase.** The authenticated `GET /v1/audio-encryption-key` request, exactly as specified
   above: single attempt, no retry, unchanged response validation and failure classification. If
   readiness passed and the probe fails, that is a real finding about the thing under test.

A prewarm or minimum-replica window was considered and rejected: scale-to-zero is the deployed
configuration, so acceptance must test that shape rather than a prewarmed one production does not
run; a prewarm would mutate the API's scaling through Terraform and require a revert apply; and the
zero-retry principle exists to keep failures of the thing under test unmasked — cold-start ingress
behavior is the platform, not the thing under test. Retrying the unauthenticated health poll is
readiness; the authenticated probe stays single-attempt so its result remains unambiguous.

Status of this amendment: decision accepted; implementation pending. The runner change, its
Settings-pinned constants, tests, and the structured readiness events land with the implementing
commit.

## Rollout and removal

1. Before deployment, enumerate every inherited or direct principal that can start or update the
   exact job. Record one approved operator and maintenance window. The stack creates no new start
   grant; any unreviewed principal or start/update activity is a stop condition. Build the reviewed
   commit in ACR and verify its digest.
2. Deploy the job with enablement and invocation closed. When the temporary Terraform runner is
   already live, this same reviewed rollout also refreshes its immutable image/configuration and
   rotates the exact plan-object ABAC paths through a state-role-assignment replacement. Take a
   fresh state snapshot only after that rollout and RBAC propagation; never advance state between
   reconciliation review and apply.
3. After the key/API apply, attest `private_terraform_reconciliation_completed = true` and review a
   plan that only configures the dormant acceptance job and opens both runtime gates. Read the job
   back and prove its identity, digest, command, environment, trigger, resources, timeout, and retry
   settings still match.
4. The approved operator starts the job once with no template override. Verify the execution's
   effective image, command, arguments, environment, resources, and identity, and verify Activity
   Log records only that approved start/update sequence. A second or different caller is a stop.
5. Record only the fixed success metadata, close both gates, and then remove the job and its
   temporary `AcrPull` in the same Phase A plan that revokes the Terraform runner's temporary
   authority. The externally owned platform identity and app-role assignment remain.

## Consequences

- The acceptance path uses the real caller identity without widening its access to Key Vault.
- The job can prove private DNS, Entra authorization, API routing, and public-key metadata, but it
  cannot prove future platform-VNet peering; that remains a separate network acceptance.
- The 60-second request budget allows one scale-to-zero cold start but no retry; a timeout remains a
  failed one-shot execution that requires closing the gates and a separately reviewed next attempt.
- Leaving the job or `AcrPull` assignment deployed after the proof is a failed teardown condition.
- A second execution requires reopening a reviewed invocation gate; the job itself has no schedule
  or durable authority to start.
- Existing inherited subscription authority is not narrowed by this stack. The short deployment
  window, exact operator record, no-override execution, Activity Log proof, and immediate removal
  are mandatory compensating controls.
