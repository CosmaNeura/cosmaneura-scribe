# Private API acceptance change record

Date: 2026-08-16 through 2026-08-17

Environment: development

Repository merge: `beca8437ebca0bfba6bfb40eaf9ff59336923528`

Readiness implementation commit: `131835658781dfb908a2341fff8ecce932ba7ad5`

Pull request: [#24](https://github.com/CosmaNeura/cosmaneura-scribe/pull/24)

## Initial-round outcome

The two-phase private API acceptance path was implemented and exercised exactly once.

- Readiness polled the unauthenticated `/healthz` endpoint until two consecutive HTTP 200 responses.
- Readiness succeeded on poll 2 after `37082.83` milliseconds.
- The runner then made exactly one authenticated request to `/v1/audio-encryption-key`; it did not retry.
- The authenticated request failed with the fixed class `PrivateApiAcceptanceHttpRejected`.
- The acceptance gates were closed immediately after the execution.
- The acceptance job, temporary Terraform jobs, temporary Terraform identity, all temporary runner role assignments, the custom state role, both temporary NSG rules, and both private plan objects were removed.

No prewarm or minimum-replica change was made. No retry was added to the authenticated probe.

## Phase 0 corrective follow-up

On 2026-08-17, Phase 0 corrected the authorization boundary and completed the previously blocked proof:

- The runtime identity kept the same built-in **Key Vault Reader** role and principal, but its scope moved from one key version to the versionless `session-audio-wrapping` key resource.
- No Key Vault Crypto role was granted to the runtime identity.
- The broad private Terraform runner was not recreated. A short-lived dormant acceptance job reused the reviewed digest and the existing platform workflow UAMI; its only temporary Azure role was `AcrPull` at the exact Scribe development registry.
- The job was enabled through a saved one-resource plan, started exactly once with no override body, and reached two consecutive readiness responses before issuing exactly one authenticated metadata request.
- The execution completed successfully and returned only the fixed metadata proof below. No token, key version, JWK modulus, exponent, response body, DNS answer, or tenant value was emitted or committed, and no private API URL was committed. Protected infrastructure logs were retained outside the repository under the withholding policy below.
- The two raw gates were closed immediately afterward. The acceptance job and its temporary `AcrPull` were then deleted through an independently reviewed two-resource plan.
- The former Terraform runner UAMI/jobs/custom role/eight assignments and both temporary NSG rules remained absent throughout.

The successful execution was terminal `Succeeded` and ran from `2026-08-17T21:09:18Z` through `2026-08-17T21:10:34Z`. The Activity Log contained one successful `Microsoft.App/jobs/start/action` correlation in the approved operator window.

```json
{"action":"private_api_acceptance.readiness_started","elapsed_ms":0,"error_class":null,"poll_count":0}
{"action":"private_api_acceptance.readiness_succeeded","elapsed_ms":39194.165,"error_class":null,"poll_count":2}
{"action":"private_api_acceptance.completed","algorithm":"RSA-OAEP-256","duration_ms":45388.916,"http_status":200,"key_operations":["wrapKey"],"key_size_bits":3072,"key_version_present":true,"kty":"RSA"}
```

This satisfies the authenticated private public-JWK prerequisite for the capture companion. It does not enable capture, transcription, delivery reconciliation, or master-platform handoff.

## Initial-round fixed structured events

Only the allowlisted metadata events are retained here:

```json
{"action":"private_api_acceptance.readiness_started","elapsed_ms":0,"error_class":null,"poll_count":0}
{"action":"private_api_acceptance.readiness_succeeded","elapsed_ms":37082.83,"error_class":null,"poll_count":2}
{"action":"private_api_acceptance.failed","duration_ms":43204.177,"entity_id":null,"error_class":"PrivateApiAcceptanceHttpRejected","tenant_id":null}
```

The single execution was terminal `Failed`. There was no second execution.

## Failure finding

Sanitized service metrics showed the authenticated path reached the API but failed when the API read the wrapping key metadata:

- API response family: HTTP 503.
- Key Vault operation: one `keyget` result with HTTP 403 in the probe window.
- The runtime identity had the built-in **Key Vault Reader** role only at one version-specific key scope.
- The API is configured with the versionless key URI, so the versionless metadata read was not authorized.

The narrow proposed correction was to replace the version-specific assignment with the same read-only **Key Vault Reader** role at the versionless wrapping-key resource scope. **Key Vault Crypto User was not required and was not granted.** This correction was deliberately not applied in the initial round and was completed in the Phase 0 follow-up above.

The initial request did not return HTTP 200; the Phase 0 follow-up subsequently completed the live proof.

## State and single-use plan record

The trusted starting Terraform state was lineage `9cc263b9-f1e2-dfc8-4a33-a67cb73459a6`, serial `48`. The state advanced as follows:

| Purpose | Input serial | Saved-plan SHA-256 | Planned actions | Resulting serial |
| --- | ---: | --- | --- | ---: |
| Deploy readiness image dormant | 48 | `a15270ff50bad2e52ac553ec4227841f4ff61fb48ff93489934edf49fa600ca8` | 0 add, 1 update, 0 destroy | 49 |
| Open acceptance gates | 49 | `e06f5d32633925736f9d6b067eb91dc75228cc31a2d0678065c52415fc1ce1a5` | 0 add, 1 update, 0 destroy | 50 |
| Close acceptance gates | 50 | `60673e8f5ce65f152c0fa24f5f0ee6af6631517258cb1e3c8a1ae405b8de26a4` | 0 add, 1 update, 0 destroy | 51 |
| Phase A privilege and NSG revocation | 51 | `a63f61cf853b47bde5ac1195c0616cb360190e48ac7efbae5fc0383ad09cda06` | 0 add, 3 update, 10 destroy | 55 |
| Phase B runner deletion | 55 | `2b3969248646918d89a50469865537cbd734089bda16e03da46b7cdf51f9e847` | 0 add, 0 update, 4 destroy | 56 |

Each saved plan was independently reviewed and applied only while its embedded lineage and serial matched the backend. The initial-round final backend serial was `56`.

The Phase 0 corrective follow-up advanced the same lineage as follows:

| Purpose | Input serial | Saved-plan SHA-256 | Planned actions | Resulting serial |
| --- | ---: | --- | --- | ---: |
| Deploy dormant proof job, add temporary `AcrPull`, and replace Reader scope | 56 | `8aaeb1c30b8617cb8e2905e2c13dc356a3254ba1f653e18a5aa673f6f401a0f3` | 3 add, 0 update, 1 destroy | 58 |
| Import the already-created exact versionless Reader after partial provider failure | 58 | `c3572470fff26f6f2ba7d1c1f9e191c869c88fbde153e7cbfd4f062779d837a1` | 1 import, 0 add, 1 update, 0 destroy | 59 |
| Prove Reader convergence after ignoring the provider-only create flag | 59 | `8ccbc05fcb70fa262376d4fbe4157eea5defb6e022b3aba429ef4e7e72d5fec1` | no changes | 59 |
| Open acceptance gates | 59 | `c5004effd7a5aa27a17987d8fd1febec2aefe85f3824907915781c534c53f753` | 0 add, 1 update, 0 destroy | 60 |
| Close acceptance gates | 60 | `a6ec73e3269f0e2f4fed59f29cc314ce4bde028ba39eef17f9d9246bedfb7cb3` | 0 add, 1 update, 0 destroy | 61 |
| Delete the proof job and temporary `AcrPull` | 61 | `b90073542fa69777485e35fd09951429ba9ba90fd23f8123374a710a8a03f2e5` | 0 add, 0 update, 2 destroy | 62 |

The first corrective apply was partial: Azure created the versionless Reader, but the provider connection reset before Terraform recorded it. The subsequent declarative import persisted the exact live assignment, then failed while attempting to update the provider-only `skip_service_principal_aad_check` create flag. The lifecycle correction ignores only that non-ARM field; a fresh-create configuration still supplies it as `true`. A targeted convergence plan then returned no changes. No role or action was added, and scope was not widened beyond the approved versionless wrapping-key resource; the acceptance execution was not retried.

The final backend serial is `62`; therefore **every saved plan listed in either table is stale and must not be reused**.

The private plan and manifest objects were checked after teardown and both returned `exists=false`.

## Teardown proof

Post-teardown read-only Azure queries returned empty lists for all of the following:

- temporary Terraform runner UAMI;
- temporary Terraform plan and apply jobs;
- private API acceptance job;
- seven enable-gated assignments for the temporary Terraform runner principal, removed in Phase A;
- the runner's final ACR pull assignment, removed in Phase B, bringing the runner total to all eight temporary assignments;
- the temporary custom state role definition;
- `AllowTemporaryTerraformArmOutbound` and `AllowTemporaryTerraformStateOutbound` NSG rules;
- the acceptance job's temporary ACR pull assignment on the platform workflow identity.

The Phase 0 follow-up again verified those absences after deleting the short-lived proof job. The platform workflow identity had no remaining Scribe-side Azure role assignment, while the API runtime retained the exact versionless-key-scoped **Key Vault Reader** and no Key Vault Crypto role.

Final state: lineage `9cc263b9-f1e2-dfc8-4a33-a67cb73459a6`, serial `62`.

## Build and validation

The readiness image was built from merge `beca8437ebca0bfba6bfb40eaf9ff59336923528` and pinned by digest:

`sha256:ecede3f499b5dbc806d33d2e882cb7b04f61d8d5dd7cdc9490aed123d346f6d2`

PR #24 merged with both `quality` and `infrastructure` checks successful. The post-teardown merged-main verification passed pytest, Ruff lint, Pyright, PHI-log, secret, ADR-number, OpenAPI parity, OpenTofu formatting, and OpenTofu validation. A separately invoked non-CI `ruff format --check` reported six pre-existing delivery-reconciler files that Ruff 0.16.3 would reformat; those unrelated files were not changed in the initial-round evidence-only commit.

[Phase 0 PR #26](https://github.com/CosmaNeura/cosmaneura-scribe/pull/26) contains the versionless Reader correction, structural regression tests, ADR/runbook reconciliation, capture-plan corrections, and this sanitized follow-up evidence. Its source changes were validated by the full repository checks before live execution; the evidence commit is subject to the same `quality` and `infrastructure` gates before merge.

## Master-platform PR #121

[Master PR #121](https://github.com/CosmaNeura/cosmaneura/pull/121) is open, draft, mergeable, and clean at `51bfb99746926ee73a1349bd2c04b7e4a9aae10e`. Release scope, Terraform Plan, Backend, and Frontend checks pass; deployment checks are skipped.

It must remain draft. It repeats the disproven cold-start assumption by increasing request timeouts to 60 seconds without adding bounded readiness polling. The network smoke performs one health request and then one POST; the workflow client sends its mutation directly. The recommended correction is bounded readiness before exactly one probe or mutation attempt, with no automatic mutation retry.

## Withheld artifacts

The following were intentionally not committed:

- Terraform state snapshots, binary plans, and rendered plan JSON because they contain infrastructure internals and sensitive-marked state fields;
- raw Azure and provider logs because they may contain URLs, identifiers, response text, or request metadata outside the allowlist;
- tokens, claims, headers, response bodies, DNS answers, key version, public modulus, and exponent;
- the protected operator-authorization record.

Protected state snapshots, binary plans, and rendered plan JSON used for audit were mode `0600`. Temporary variable files are excluded from that claim. None of these files are source artifacts or required to reproduce the application code.

## Remaining work

The read-only public-JWK prerequisite is complete and the temporary execution path is gone. Mobile Phase 1 remains a separate PR and must not change the now-persistent versionless **Key Vault Reader** boundary or reintroduce the temporary Terraform runner.
