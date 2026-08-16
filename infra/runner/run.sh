#!/bin/sh
set -eu

umask 077

cleanup() {
  rm -f \
    /tmp/backend.hcl \
    /tmp/candidate.tfplan \
    /tmp/candidate.tfplan.manifest.json \
    /tmp/current-state.json \
    /tmp/post-plan-state.json \
    /tmp/post-apply-state.json \
    /tmp/tofu-apply.log \
    /tmp/tofu-init.log \
    /tmp/tofu-plan.log
}

fail() {
  error_class="$1"
  cleanup
  printf '{"action":"private_terraform_runner.failed","error_class":"%s"}\n' "$error_class" >&2
  exit 1
}

trap cleanup EXIT
trap 'cleanup; exit 130' HUP INT TERM

if [ "${TF_RUNNER_ENABLED:-false}" != "true" ]; then
  printf '{"action":"private_terraform_runner.disabled"}\n' >&2
  exit 64
fi

case "${TF_RUNNER_ACTION:-}" in
  plan | apply) ;;
  *) fail "InvalidAction" ;;
esac

for value in \
  "${ARM_CLIENT_ID:-}" \
  "${ARM_SUBSCRIPTION_ID:-}" \
  "${ARM_TENANT_ID:-}" \
  "${TF_STATE_RESOURCE_GROUP:-}" \
  "${TF_STATE_STORAGE_ACCOUNT:-}" \
  "${TF_STATE_CONTAINER:-}" \
  "${TF_STATE_KEY:-}" \
  "${TF_RUNNER_PLAN_BLOB:-}"
do
  [ -n "$value" ] || fail "MissingConfiguration"
done

case "$TF_RUNNER_PLAN_BLOB" in
  "" | /* | *..* | *[!a-z0-9._/-]*) fail "InvalidPlanObject" ;;
  *.tfplan) ;;
  *) fail "InvalidPlanObject" ;;
esac

if [ "$TF_RUNNER_ACTION" = "apply" ]; then
  reviewed_plan_sha256="${TF_RUNNER_EXPECTED_PLAN_SHA256:-}"
  reviewed_state_lineage="${TF_RUNNER_EXPECTED_STATE_LINEAGE:-}"
  reviewed_state_serial="${TF_RUNNER_EXPECTED_STATE_SERIAL:-}"

  case "$reviewed_plan_sha256" in
    *[!0-9a-f]* | "") fail "InvalidReviewerPlanHash" ;;
  esac

  case "$reviewed_state_lineage" in
    *[!0-9a-f-]* | "") fail "InvalidReviewerStateLineage" ;;
  esac

  case "$reviewed_state_serial" in
    *[!0-9]* | "") fail "InvalidReviewerStateSerial" ;;
  esac

  if [ "${#reviewed_plan_sha256}" -ne 64 ] || [ "${#reviewed_state_lineage}" -ne 36 ]; then
    fail "InvalidReviewerPinLength"
  fi
fi

cat > /tmp/backend.hcl <<EOF
resource_group_name  = "$TF_STATE_RESOURCE_GROUP"
storage_account_name = "$TF_STATE_STORAGE_ACCOUNT"
container_name       = "$TF_STATE_CONTAINER"
key                  = "$TF_STATE_KEY"
use_azuread_auth     = true
use_msi              = true
client_id            = "$ARM_CLIENT_ID"
subscription_id      = "$ARM_SUBSCRIPTION_ID"
tenant_id            = "$ARM_TENANT_ID"
EOF

if ! az login \
  --identity \
  --client-id "$ARM_CLIENT_ID" \
  --allow-no-subscriptions \
  --output none >/dev/null 2>&1
then
  fail "ManagedIdentityAuthenticationFailed"
fi

if ! tofu init \
  -backend-config=/tmp/backend.hcl \
  -input=false \
  -no-color \
  -reconfigure >/tmp/tofu-init.log 2>&1
then
  fail "BackendInitializationFailed"
fi

plan_manifest_blob="${TF_RUNNER_PLAN_BLOB}.manifest.json"

if [ "$TF_RUNNER_ACTION" = "plan" ]; then
  if ! tofu state pull > /tmp/current-state.json 2>/dev/null; then
    fail "StateReadFailed"
  fi

  state_lineage="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/current-state.json lineage string 2>/dev/null)" ||
    fail "InvalidStateMetadata"
  state_serial="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/current-state.json serial integer 2>/dev/null)" ||
    fail "InvalidStateMetadata"

  set +e
  tofu plan \
    -detailed-exitcode \
    -input=false \
    -lock-timeout=5m \
    -no-color \
    -out=/tmp/candidate.tfplan \
    -target=azurerm_key_vault_key.audio \
    -target=azurerm_role_assignment.runtime_audio_key_reader \
    -target=azurerm_role_assignment.runtime_vault \
    -target='azurerm_container_app.api[0]' >/tmp/tofu-plan.log 2>&1
  plan_exit_code=$?
  set -e

  case "$plan_exit_code" in
    0) fail "NoChanges" ;;
    2) ;;
    *) fail "PlanFailed" ;;
  esac

  if ! tofu state pull > /tmp/post-plan-state.json 2>/dev/null; then
    fail "PostPlanStateReadFailed"
  fi

  post_plan_lineage="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/post-plan-state.json lineage string 2>/dev/null)" ||
    fail "InvalidPostPlanStateMetadata"
  post_plan_serial="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/post-plan-state.json serial integer 2>/dev/null)" ||
    fail "InvalidPostPlanStateMetadata"

  if [ "$post_plan_lineage" != "$state_lineage" ] || [ "$post_plan_serial" != "$state_serial" ]; then
    fail "StateChangedDuringPlan"
  fi

  plan_sha256="$(sha256sum /tmp/candidate.tfplan)"
  plan_sha256="${plan_sha256%% *}"
  if ! python3 /workspace/infra/runner/metadata.py write-manifest \
    /tmp/candidate.tfplan.manifest.json \
    "$plan_sha256" \
    "$state_lineage" \
    "$state_serial" 2>/dev/null
  then
    fail "InvalidManifest"
  fi

  if ! az storage blob upload \
    --account-name "$TF_STATE_STORAGE_ACCOUNT" \
    --auth-mode login \
    --container-name "$TF_STATE_CONTAINER" \
    --file /tmp/candidate.tfplan \
    --name "$TF_RUNNER_PLAN_BLOB" \
    --only-show-errors \
    --output none \
    --overwrite false >/dev/null 2>&1
  then
    fail "PlanUploadFailed"
  fi

  if ! az storage blob upload \
    --account-name "$TF_STATE_STORAGE_ACCOUNT" \
    --auth-mode login \
    --container-name "$TF_STATE_CONTAINER" \
    --file /tmp/candidate.tfplan.manifest.json \
    --name "$plan_manifest_blob" \
    --only-show-errors \
    --output none \
    --overwrite false >/dev/null 2>&1
  then
    fail "ManifestUploadFailed"
  fi

  printf '{"action":"private_terraform_runner.plan_ready","change_exit_code":%s,"plan_sha256":"%s","state_lineage":"%s","state_serial":%s}\n' \
    "$plan_exit_code" "$plan_sha256" "$state_lineage" "$state_serial"
  exit 0
fi

if ! az storage blob download \
  --account-name "$TF_STATE_STORAGE_ACCOUNT" \
  --auth-mode login \
  --container-name "$TF_STATE_CONTAINER" \
  --file /tmp/candidate.tfplan \
  --name "$TF_RUNNER_PLAN_BLOB" \
  --only-show-errors \
  --output none >/dev/null 2>&1
then
  fail "PlanDownloadFailed"
fi

if ! az storage blob download \
  --account-name "$TF_STATE_STORAGE_ACCOUNT" \
  --auth-mode login \
  --container-name "$TF_STATE_CONTAINER" \
  --file /tmp/candidate.tfplan.manifest.json \
  --name "$plan_manifest_blob" \
  --only-show-errors \
  --output none >/dev/null 2>&1
then
  fail "ManifestDownloadFailed"
fi

expected_sha256="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/candidate.tfplan.manifest.json plan_sha256 string 2>/dev/null)" ||
  fail "InvalidManifest"
manifest_version="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/candidate.tfplan.manifest.json format_version integer 2>/dev/null)" ||
  fail "InvalidManifest"
expected_lineage="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/candidate.tfplan.manifest.json state_lineage string 2>/dev/null)" ||
  fail "InvalidManifest"
expected_serial="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/candidate.tfplan.manifest.json state_serial integer 2>/dev/null)" ||
  fail "InvalidManifest"
actual_sha256="$(sha256sum /tmp/candidate.tfplan)"
actual_sha256="${actual_sha256%% *}"

if [ "$manifest_version" -ne 1 ]; then
  fail "UnsupportedManifestVersion"
fi

case "$expected_sha256" in
  *[!0-9a-f]* | "") fail "InvalidChecksum" ;;
esac

if [ "${#expected_sha256}" -ne 64 ] || [ "$expected_sha256" != "$actual_sha256" ]; then
  fail "ChecksumMismatch"
fi

if [ "$reviewed_plan_sha256" != "$expected_sha256" ] || \
  [ "$reviewed_state_lineage" != "$expected_lineage" ] || \
  [ "$reviewed_state_serial" != "$expected_serial" ]
then
  fail "ReviewerPinMismatch"
fi

if ! tofu state pull > /tmp/current-state.json 2>/dev/null; then
  fail "StateReadFailed"
fi

current_lineage="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/current-state.json lineage string 2>/dev/null)" ||
  fail "InvalidStateMetadata"
current_serial="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/current-state.json serial integer 2>/dev/null)" ||
  fail "InvalidStateMetadata"

if [ "$expected_lineage" != "$current_lineage" ] || [ "$expected_serial" != "$current_serial" ]; then
  fail "StateVersionMismatch"
fi

if ! tofu apply \
  -auto-approve \
  -input=false \
  -lock-timeout=5m \
  -no-color \
  /tmp/candidate.tfplan >/tmp/tofu-apply.log 2>&1
then
  fail "ApplyFailed"
fi

if ! tofu state pull > /tmp/post-apply-state.json 2>/dev/null; then
  fail "PostApplyStateReadFailed"
fi

post_apply_lineage="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/post-apply-state.json lineage string 2>/dev/null)" ||
  fail "InvalidPostApplyStateMetadata"
post_apply_serial="$(python3 /workspace/infra/runner/metadata.py read-field /tmp/post-apply-state.json serial integer 2>/dev/null)" ||
  fail "InvalidPostApplyStateMetadata"

if [ "$post_apply_lineage" != "$expected_lineage" ] || [ "$post_apply_serial" -le "$expected_serial" ]; then
  fail "PostApplyStateVersionMismatch"
fi

if ! az storage blob delete \
  --account-name "$TF_STATE_STORAGE_ACCOUNT" \
  --auth-mode login \
  --container-name "$TF_STATE_CONTAINER" \
  --name "$TF_RUNNER_PLAN_BLOB" \
  --only-show-errors \
  --output none >/dev/null 2>&1
then
  fail "PlanArtifactDeletionFailed"
fi

if ! az storage blob delete \
  --account-name "$TF_STATE_STORAGE_ACCOUNT" \
  --auth-mode login \
  --container-name "$TF_STATE_CONTAINER" \
  --name "$plan_manifest_blob" \
  --only-show-errors \
  --output none >/dev/null 2>&1
then
  fail "ManifestDeletionFailed"
fi

printf '{"action":"private_terraform_runner.apply_completed","plan_sha256":"%s","state_lineage":"%s","pre_apply_serial":%s,"post_apply_serial":%s}\n' \
  "$actual_sha256" "$post_apply_lineage" "$expected_serial" "$post_apply_serial"
