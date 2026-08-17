# Private API acceptance change record

Date: 2026-08-16 through 2026-08-17

Environment: development

Repository merge: `beca8437ebca0bfba6bfb40eaf9ff59336923528`

Readiness implementation commit: `131835658781dfb908a2341fff8ecce932ba7ad5`

Pull request: [#24](https://github.com/CosmaNeura/cosmaneura-scribe/pull/24)

## Outcome

The two-phase private API acceptance path was implemented and exercised exactly once.

- Readiness polled the unauthenticated `/healthz` endpoint until two consecutive HTTP 200 responses.
- Readiness succeeded on poll 2 after `37082.83` milliseconds.
- The runner then made exactly one authenticated request to `/v1/audio-encryption-key`; it did not retry.
- The authenticated request failed with the fixed class `PrivateApiAcceptanceHttpRejected`.
- The acceptance gates were closed immediately after the execution.
- The acceptance job, temporary Terraform jobs, temporary Terraform identity, all temporary runner role assignments, the custom state role, both temporary NSG rules, and both private plan objects were removed.

No prewarm or minimum-replica change was made. No retry was added to the authenticated probe.

## Fixed structured events

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

The narrow proposed correction is to replace the version-specific assignment with the same read-only **Key Vault Reader** role at the versionless wrapping-key resource scope. **Key Vault Crypto User is not required and was not granted.** This correction was deliberately not applied in this round.

The live public-JWK response remains unverified because the authenticated request did not return HTTP 200.

## State and single-use plan record

The trusted starting Terraform state was lineage `9cc263b9-f1e2-dfc8-4a33-a67cb73459a6`, serial `48`. The state advanced as follows:

| Purpose | Input serial | Saved-plan SHA-256 | Planned actions | Resulting serial |
| --- | ---: | --- | --- | ---: |
| Deploy readiness image dormant | 48 | `a15270ff50bad2e52ac553ec4227841f4ff61fb48ff93489934edf49fa600ca8` | 0 add, 1 update, 0 destroy | 49 |
| Open acceptance gates | 49 | `e06f5d32633925736f9d6b067eb91dc75228cc31a2d0678065c52415fc1ce1a5` | 0 add, 1 update, 0 destroy | 50 |
| Close acceptance gates | 50 | `60673e8f5ce65f152c0fa24f5f0ee6af6631517258cb1e3c8a1ae405b8de26a4` | 0 add, 1 update, 0 destroy | 51 |
| Phase A privilege and NSG revocation | 51 | `a63f61cf853b47bde5ac1195c0616cb360190e48ac7efbae5fc0383ad09cda06` | 0 add, 3 update, 10 destroy | 55 |
| Phase B runner deletion | 55 | `2b3969248646918d89a50469865537cbd734089bda16e03da46b7cdf51f9e847` | 0 add, 0 update, 4 destroy | 56 |

Each saved plan was independently reviewed and applied only while its embedded lineage and serial matched the backend. The final backend serial is `56`; therefore **every saved plan from serial 48 or earlier, and every saved plan listed above, is now stale and must not be reused**.

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

Final state: lineage `9cc263b9-f1e2-dfc8-4a33-a67cb73459a6`, serial `56`.

## Build and validation

The readiness image was built from merge `beca8437ebca0bfba6bfb40eaf9ff59336923528` and pinned by digest:

`sha256:ecede3f499b5dbc806d33d2e882cb7b04f61d8d5dd7cdc9490aed123d346f6d2`

PR #24 merged with both `quality` and `infrastructure` checks successful. The post-teardown merged-main verification passed pytest, Ruff lint, Pyright, PHI-log, secret, ADR-number, OpenAPI parity, OpenTofu formatting, and OpenTofu validation. A separately invoked non-CI `ruff format --check` reported six pre-existing delivery-reconciler files that Ruff 0.16.3 would reformat; those unrelated files were not changed in this evidence-only commit.

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

The read-only public-JWK acceptance proof is incomplete. A future reviewed change must correct only the Key Vault Reader scope, recreate a short-lived private execution path, run one acceptance attempt, and tear that path down again. No temporary runner privilege remains live from this round.
