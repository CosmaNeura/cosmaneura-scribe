# Production ARM wrapping-key bootstrap

Risk: Tier 2, production key ownership and least-privilege identity. This is
source and plan preparation. Founder production dispatch and a separately
reviewed exact saved plan are required before any apply.

The approved production foundation omitted the wrapping key and its runtime
Reader assignment. Its vault is private. Selecting the false-default
`enable_production_arm_audio_key_bootstrap` creates the missing fixed
`session-audio-wrapping` ARM child through the management plane. It does not
open the Key Vault data plane or grant the deployment identity cryptographic
access. AzAPI 2.13.0 is pinned and schema validation stays enabled. Provider
preflight and automatic registration are disabled.

The key is non-exportable RSA3072 with only `unwrapKey` and `wrapKey` operations.
The resource exports no response properties. The API obtains the unchanged
versionless data-plane URI and key-scoped Reader role
`21090545-7ca7-4776-b22c-e363652d74d2`; it cannot unwrap audio. A future qualified
transcription worker retains its separate crypto-user grant and activation gate.
Neither is enabled by this bootstrap.

Existing AzureRM-owned keys remain in AzureRM when the flag is false. The
`azurerm_key_vault_key.audio` to `audio[0]` moved block is an address-only
migration. Both provider representations have `prevent_destroy`; a mistaken
owner switch for an existing key must fail instead of recreating it. Do not
remove state, import the same key into a second owner, or remove that protection.

## Plan and authority

1. Bind the current production backend, exact subscription, applied foundation
   lineage/serial, and current merged source. Confirm the fixed child is still
   absent with read-only ARM inspection. Existing foundation names, network,
   storage, identities and all activation flags remain unchanged.
2. Set only `enable_production_arm_audio_key_bootstrap = true` in the reviewed
   foundation values. Produce a saved plan with every app, database, job and
   activation gate false. A public operator may prepare a no-refresh plan from
   the protected existing state without reading private Blob/Key Vault data;
   that does not prove drift-free apply readiness. Keep provider auto-registration
   disabled and do not print raw plan/state or provider errors.
3. Independently review the saved plan. Its only non-no-op resource actions must
   be one ARM key create and one key-scoped runtime Reader create. No update,
   replacement, deletion, networking change, app, database, job, provider
   registration, Core workload change or traffic is allowed. The checked-in
   `tools/production/verify_audio_key_plan.py` emits a metadata-only projection
   and rejects a broader plan. Retain the binary plan protected; it can contain
   existing Terraform state secrets even though these resources create none.
4. Separately prove the later founder-approved deployment identity has the exact
   vault-scoped `Microsoft.KeyVault/vaults/keys/write` management action and the
   exact role-assignment write action. Do not substitute an API/worker identity.
   Refresh and re-review drift before founder dispatch. Agents do not apply.
5. After the separately authorized apply, verify fixed ARM key properties and
   the Reader scope. Actual runtime public-key reading over the selected private
   or reviewed egress route remains required before capture activation. No
   consent, transcript, recording or model work is started by key bootstrap.

## Recovery

Leave the production key and its Terraform owner in place. Keep capture and
processing gates false. Revoke only the new key-scoped Reader assignment if its
grant is faulty, through a separately reviewed saved plan. Do not delete or
recreate the key, remove `prevent_destroy`, open the private vault, or roll back
the flag after a successful ARM key create. The existing Core host/database
reuse and network/Clerk/Speech activation remain separate rungs.
