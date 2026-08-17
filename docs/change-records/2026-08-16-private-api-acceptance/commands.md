# Representative sanitized command and result ledger

This ledger records representative mutating commands, validation commands, and security-boundary verification used for the private API acceptance round. It is intentionally not a literal shell transcript: sensitive arguments, workstation-specific paths, long provider output, exploratory read-only queries, protected state, and raw logs are omitted or replaced with angle-bracket placeholders under the withholding policy in the companion README. Every infrastructure mutation and its actual action count is included.

## Local verification

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/api/src \
  <scribe-repo>/.venv/bin/python \
  -m pytest -p no:cacheprovider -q
```

Actual result: exit `0`; all collected tests passed or were explicitly skipped. PostgreSQL-marked cases skipped where no local test database URL was configured. One upstream Starlette/httpx deprecation warning was emitted.

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/api/src \
  <scribe-repo>/.venv/bin/python \
  -m pytest -p no:cacheprovider -q \
  tests/test_private_api_acceptance_runner.py \
  tests/test_private_api_acceptance_infra.py tests/test_settings.py
```

Actual result: exit `0`; `............................................................. [100%]` and the same single upstream deprecation warning.

```text
<scribe-repo>/.venv/bin/ruff check --no-cache .
```

Actual output: `All checks passed!`

```text
<scribe-repo>/.venv/bin/ruff format --check --no-cache .
```

Actual result: exit `1`; Ruff 0.16.3 reported six pre-existing files that it would reformat:

- `services/api/src/cosmaneura_scribe/database_bootstrap.py`
- `services/api/src/cosmaneura_scribe/delivery_reconciler_runner.py`
- `services/api/src/cosmaneura_scribe/main.py`
- `services/api/src/cosmaneura_scribe/repository.py`
- `tests/test_database_bootstrap.py`
- `tests/test_delivery_reconciler_infra.py`

The repository CI runs `ruff check`, which passed. These unrelated files were not changed.

```text
PYTHONPATH=services/api/src \
  <scribe-repo>/.venv/bin/pyright \
  --pythonpath <scribe-repo>/.venv/bin/python
```

Actual output: `0 errors, 0 warnings, 0 informations`. Pyright also noted that the isolated worktree has no local `.venv` directory.

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/api/src \
  <scribe-repo>/.venv/bin/python scripts/check_phi_logs.py
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/api/src \
  <scribe-repo>/.venv/bin/python scripts/check_secrets.py
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/api/src \
  <scribe-repo>/.venv/bin/python scripts/check_adr_numbers.py
```

Actual result: all three exited `0` with no output.

```text
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=services/api/src \
  <scribe-repo>/.venv/bin/python -c \
  '<generate app OpenAPI in memory and assert byte equality>'
```

Actual output: `openapi parity: match`.

```text
tofu fmt -check -recursive -diff infra
```

Actual result: exit `0` with no output.

```text
tofu validate -no-color
```

Actual output: `Success! The configuration is valid.`

## GitHub and image publication

```text
git push -u origin agent/private-api-acceptance-readiness
gh pr create --draft ...
gh pr ready 24
gh pr merge 24 --merge ...
```

Actual result: PR #24 merged as `beca8437ebca0bfba6bfb40eaf9ff59336923528`; `quality` and `infrastructure` checks succeeded.

```text
az acr build --registry cosmaneurascribedevacr \
  --image cosmaneura-scribe-api:beca8437ebca0bfba6bfb40eaf9ff59336923528 ...
```

Actual result: build succeeded; the tag resolved to `sha256:ecede3f499b5dbc806d33d2e882cb7b04f61d8d5dd7cdc9490aed123d346f6d2`.

## Terraform transitions

All plans used `-refresh=true`, state locking, the reviewed development variables, a protected `0600` output file, and explicit targets. Every apply consumed the exact reviewed saved file rather than regenerating a plan.

```text
tofu plan ... -out=<readiness-dormant-s48.tfplan>
tofu apply ... <readiness-dormant-s48.tfplan>
```

Actual result: plan hash `a15270ff50bad2e52ac553ec4227841f4ff61fb48ff93489934edf49fa600ca8`; `0 added, 1 changed, 0 destroyed`; state `48 -> 49`.

```text
tofu plan ... -out=<acceptance-enable-s49.tfplan>
tofu apply ... <acceptance-enable-s49.tfplan>
```

Actual result: plan hash `e06f5d32633925736f9d6b067eb91dc75228cc31a2d0678065c52415fc1ce1a5`; only the acceptance job environment changed; state `49 -> 50`.

```text
az containerapp job start --name cosmaneura-scribe-dev-api-proof \
  --resource-group cosmaneura-scribe-development --output none
```

Actual result: exactly one execution, with no override body. Terminal status `Failed`. Fixed events:

```json
{"action":"private_api_acceptance.readiness_started","elapsed_ms":0,"error_class":null,"poll_count":0}
{"action":"private_api_acceptance.readiness_succeeded","elapsed_ms":37082.83,"error_class":null,"poll_count":2}
{"action":"private_api_acceptance.failed","duration_ms":43204.177,"entity_id":null,"error_class":"PrivateApiAcceptanceHttpRejected","tenant_id":null}
```

```text
tofu plan ... -out=<acceptance-close-s50.tfplan>
tofu apply ... <acceptance-close-s50.tfplan>
```

Actual result: plan hash `60673e8f5ce65f152c0fa24f5f0ee6af6631517258cb1e3c8a1ae405b8de26a4`; only acceptance gates closed; state `50 -> 51`.

```text
tofu plan ... -out=/private/tmp/cosmaneura-runner-phase-a-revoke-beca843-s51.tfplan
tofu apply -input=false -lock=true -lock-timeout=5m -no-color \
  /private/tmp/cosmaneura-runner-phase-a-revoke-beca843-s51.tfplan
```

Actual result: plan hash `a63f61cf853b47bde5ac1195c0616cb360190e48ac7efbae5fc0383ad09cda06`; `Apply complete! Resources: 0 added, 3 changed, 10 destroyed.` State advanced to serial `55`.

```text
tofu plan ... -out=/private/tmp/cosmaneura-runner-phase-b-delete-beca843-s55.tfplan
tofu apply -input=false -lock=true -lock-timeout=5m -no-color \
  /private/tmp/cosmaneura-runner-phase-b-delete-beca843-s55.tfplan
```

Actual result: plan hash `2b3969248646918d89a50469865537cbd734089bda16e03da46b7cdf51f9e847`; `Apply complete! Resources: 0 added, 0 changed, 4 destroyed.` Final state serial `56`.

## Final live verification

```text
az identity list --resource-group cosmaneura-scribe-development \
  --query "[?name=='cosmaneura-scribe-development-private-tf-runner']" -o json
```

Actual output: `[]`.

```text
az containerapp job list --resource-group cosmaneura-scribe-development \
  --query "[?name=='cosmaneura-scribe-dev-tf-plan' || \
  name=='cosmaneura-scribe-dev-tf-apply' || \
  name=='cosmaneura-scribe-dev-api-proof'].name" -o json
```

Actual output: `[]`.

```text
az role assignment list --assignee-object-id <temporary-runner-principal> \
  --include-inherited --all -o json
az role definition list --name <temporary-state-role-id> -o json
```

Actual output from each command: `[]`.

```text
az network nsg show --resource-group cosmaneura-scribe-development \
  --name cosmaneura-scribe-development-container-apps-nsg \
  --query "securityRules[?name=='AllowTemporaryTerraformArmOutbound' || \
  name=='AllowTemporaryTerraformStateOutbound'].name" -o json
```

Actual output: `[]`.

```text
az role assignment list --assignee-object-id <platform-workflow-principal> \
  --scope <scribe-acr-resource-id> --include-inherited -o json
```

Actual output: `[]`.

```text
az storage blob exists --auth-mode login --account-name cosmaneuratfstate \
  --container-name cosmaneura-tfstate --name <private-plan-object> -o tsv
az storage blob exists --auth-mode login --account-name cosmaneuratfstate \
  --container-name cosmaneura-tfstate --name <private-plan-manifest-object> -o tsv
```

Actual output from each command: `false`.

## Phase 0 versionless-Reader follow-up

The following representative sanitized ledger covers the 2026-08-17 corrective follow-up. Protected plans, state, rendered JSON, and logs remained outside the repository at mode `0600`.

```text
tofu plan -refresh=true ... \
  -target=azurerm_role_assignment.runtime_audio_key_reader \
  -target=azurerm_role_assignment.private_api_acceptance_acr \
  -target=azurerm_container_app_job.private_api_acceptance \
  -out=<phase0-dormant-s56.tfplan>
tofu apply ... <phase0-dormant-s56.tfplan>
```

Actual result: plan SHA-256 `8aaeb1c30b8617cb8e2905e2c13dc356a3254ba1f653e18a5aa673f6f401a0f3`; planned `3 added, 0 changed, 1 destroyed`. The dormant proof job and exact-registry `AcrPull` were created with both gates false. Azure also created the replacement versionless **Key Vault Reader**, but the provider connection reset before Terraform recorded that assignment. The backend advanced from serial `56` to `58`; execution stopped and no probe was started.

```text
tofu plan -refresh=true ... -out=<phase0-reader-import-s58.tfplan>
tofu apply ... <phase0-reader-import-s58.tfplan>
```

Actual result: plan SHA-256 `c3572470fff26f6f2ba7d1c1f9e191c869c88fbde153e7cbfd4f062779d837a1`; exactly one declarative import of the existing assignment and one provider-state-only update, with no add or destroy. The import persisted, then the provider rejected updating the create-only `skip_service_principal_aad_check` flag. State advanced from serial `58` to `59`. Live scope, role, and principal were unchanged.

```text
tofu plan -refresh=true ... \
  -target=azurerm_role_assignment.runtime_audio_key_reader \
  -out=<phase0-reader-convergence-s59.tfplan>
```

Actual result: plan SHA-256 `8ccbc05fcb70fa262376d4fbe4157eea5defb6e022b3aba429ef4e7e72d5fec1`; `No changes. Your infrastructure matches the configuration.` The lifecycle rule ignores only the provider-only create flag; the configured fresh-create value remains `true`.

```text
tofu plan -refresh=true ... \
  -target=azurerm_container_app_job.private_api_acceptance \
  -out=<phase0-enable-s59.tfplan>
tofu apply ... <phase0-enable-s59.tfplan>
```

Actual result: plan SHA-256 `c5004effd7a5aa27a17987d8fd1febec2aefe85f3824907915781c534c53f753`; `Apply complete! Resources: 0 added, 1 changed, 0 destroyed.` Only the two raw gates and five derived non-secret inputs changed. State advanced from serial `59` to `60`.

```text
az containerapp job start --name cosmaneura-scribe-dev-api-proof \
  --resource-group cosmaneura-scribe-development --output none
```

Actual result: exactly one no-override execution. The effective execution template retained the reviewed digest, exact platform workflow UAMI, fixed command, empty arguments, manual trigger, retry limit `0`, and 300-second job bound. Terminal status was `Succeeded`. The Activity Log contained one successful start correlation in the approved operator window. Fixed metadata events:

```json
{"action":"private_api_acceptance.readiness_started","elapsed_ms":0,"error_class":null,"poll_count":0}
{"action":"private_api_acceptance.readiness_succeeded","elapsed_ms":39194.165,"error_class":null,"poll_count":2}
{"action":"private_api_acceptance.completed","algorithm":"RSA-OAEP-256","duration_ms":45388.916,"http_status":200,"key_operations":["wrapKey"],"key_size_bits":3072,"key_version_present":true,"kty":"RSA"}
```

```text
tofu plan -refresh=true ... \
  -target=azurerm_container_app_job.private_api_acceptance \
  -out=<phase0-close-s60.tfplan>
tofu apply ... <phase0-close-s60.tfplan>
```

Actual result: plan SHA-256 `a6ec73e3269f0e2f4fed59f29cc314ce4bde028ba39eef17f9d9246bedfb7cb3`; `Apply complete! Resources: 0 added, 1 changed, 0 destroyed.` Only the two gates closed and the five enable-only inputs were removed. State advanced from serial `60` to `61`. Live read-back showed both gates `false`, manual trigger, retry limit `0`, and the single execution terminal `Succeeded`.

```text
tofu plan -refresh=true ... \
  -target=azurerm_container_app_job.private_api_acceptance \
  -target=azurerm_role_assignment.private_api_acceptance_acr \
  -out=<phase0-teardown-s61.tfplan>
tofu apply ... <phase0-teardown-s61.tfplan>
```

Actual result: plan SHA-256 `b90073542fa69777485e35fd09951429ba9ba90fd23f8123374a710a8a03f2e5`; `Apply complete! Resources: 0 added, 0 changed, 2 destroyed.` Only the dormant proof job and the platform identity's exact-registry `AcrPull` were deleted. State advanced from serial `61` to `62`.

```text
tofu state pull | jq '{lineage,serial}'
```

Actual output: lineage `9cc263b9-f1e2-dfc8-4a33-a67cb73459a6`, serial `62`.

```text
az containerapp job list --resource-group cosmaneura-scribe-development ...
az role assignment list --assignee-object-id <platform-workflow-principal> --all ...
az identity list --resource-group cosmaneura-scribe-development ...
az role definition list --name <temporary-state-role-id> ...
az network nsg show --resource-group cosmaneura-scribe-development ...
az storage blob list --account-name cosmaneuratfstate \
  --container-name cosmaneura-tfstate --prefix plans/private-key-api- ...
```

Actual results:

- the jobs collection contained only the dormant Speech smoke job;
- the platform workflow principal had no remaining Azure role assignment in the Scribe environment;
- the temporary Terraform runner identity, plan/apply jobs, custom state role, both temporary NSG rules, and private-plan object prefix all returned empty lists;
- the API runtime retained `AcrPull`, `Storage Blob Data Contributor`, and the built-in **Key Vault Reader** exactly at `/keys/session-audio-wrapping`; it had no Key Vault Crypto role.
