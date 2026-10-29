# Production wrapping-key source and plan evidence

Risk: Tier 2. The change provides one Terraform-owned management-plane bootstrap
for the absent production key. It does not apply production infrastructure.

Validated on October 29, 2026 with OpenTofu 1.12.5, AzureRM 4.81.0 and pinned
AzAPI 2.13.0:

- `tofu validate`: PASS.
- `tofu test`: 28 provider-mocked plans PASS, including the original dedicated
  native edge, existing Core host reuse and private/default cases.
- The existing private-runner/acceptance source checks: 18 PASS.
- Plan projection regressions: 12 PASS; broader actions, a vault-scoped or
  crypto-user grant, a client ID used as principal, weaker/exportable key and
  activation are rejected.
- Ruff and Terraform formatting checks: PASS.

The actual production-backend no-refresh saved plan is
`32b0cbb076ba240602786c57084bde6f8f84c3dbed0c0b0a75c4142ad42144a3`.
Its only changes are one `azapi_resource.production_audio_key[0]` create and one
`azurerm_role_assignment.runtime_audio_key_reader` create. All 26 already-applied
foundation resources are no-op; there are no updates, replacements, deletions,
apps, databases or jobs. The metadata-only verifier accepted that exact plan.
Vault/Blob remain private and the existing Scribe environment remains internal.

The state uses the existing production backend, lineage
`cfecb4e4-c477-d434-0fd7-5fa404aa9ea9`, serial 12. After planning, resources,
outputs, lineage, serial and all 54 check records remain equal; check-record
serialization order differs between reads. No state lock was acquired. Fresh
read-only ARM inspection confirmed the fixed key remains absent. No apply,
role write, public-network opening, database operation, job or traffic occurred.

Raw state and the binary plan remain protected local artifacts because they can
contain existing state secrets. A no-refresh plan proves the bounded intended
delta; it does not prove drift-free apply readiness or runtime cryptographic
access. Independent final-source and saved-plan review, exact management-action
authority, a refreshed plan and founder authorization remain required before
apply. Follow the [flight plan](../flight-plans/2026-10-29-production-arm-audio-key.md).
