from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PR_WORKFLOW = ROOT / ".github" / "workflows" / "capture-preview.yml"
DEPLOY_WORKFLOW = ROOT / ".github" / "workflows" / "capture-preview-deploy.yml"
ACCEPT_WORKFLOW = ROOT / ".github" / "workflows" / "capture-preview-acceptance.yml"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
STATIC_CONFIG = ROOT / "apps" / "capture" / "public" / "staticwebapp.config.json"
VITE_CONFIG = ROOT / "apps" / "capture" / "vite.config.ts"
PREVIEW_BUNDLE_CHECK = ROOT / "apps" / "capture" / "scripts" / "check-preview-bundle.mjs"
RUNBOOK = ROOT / "docs" / "CAPTURE_PREVIEW.md"
PREVIEW_FUNCTION = ROOT / "infra" / "preview" / "function.tf"
PREVIEW_MAIN = ROOT / "infra" / "preview" / "main.tf"
PREVIEW_VARIABLES = ROOT / "infra" / "preview" / "variables.tf"
PREVIEW_API_BUILDER = (
    ROOT / "apps" / "capture-preview-api" / "scripts" / "build-package.mjs"
)
PREVIEW_SCOPE_CLASSIFIER = (
    ROOT / ".github" / "scripts" / "classify-capture-preview-scope.sh"
)


def classify_preview_scope(*paths: str) -> dict[str, str]:
    result = subprocess.run(
        ["bash", str(PREVIEW_SCOPE_CLASSIFIER)],
        input=b"".join(path.encode() + b"\0" for path in paths),
        capture_output=True,
        check=True,
    )
    return dict(line.split("=", 1) for line in result.stdout.decode().splitlines())


def classify_preview_range(repository: Path, base: str, head: str) -> dict[str, str]:
    result = subprocess.run(
        ["bash", str(PREVIEW_SCOPE_CLASSIFIER), "--range", base, head],
        cwd=repository,
        capture_output=True,
        check=True,
    )
    return dict(line.split("=", 1) for line in result.stdout.decode().splitlines())


def git(repository: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        cwd=repository,
        capture_output=True,
        check=True,
        text=True,
    )
    return result.stdout.strip()


def test_capture_preview_deployment_scope_is_narrow_and_fail_open() -> None:
    assert classify_preview_scope("docs/CAPTURE_PREVIEW.md")["deploy"] == "false"
    assert classify_preview_scope("apps/capture-preview-api/README.md")["deploy"] == "false"
    assert classify_preview_scope("services/api/src/example.py")["deploy"] == "false"
    assert classify_preview_scope("apps/desktop-companion/src/main.ts")["deploy"] == "false"
    assert classify_preview_scope("apps/capture/android/app/build.gradle")["deploy"] == "false"
    assert classify_preview_scope(".github/workflows/change-budget.yml")["deploy"] == "false"
    assert (
        classify_preview_scope(".github/workflows/core-image-provenance.yml")["deploy"]
        == "false"
    )

    for preview_input in (
        ".github/workflows/capture-preview-deploy.yml",
        ".github/workflows/ci.yml",
        "package-lock.json",
        "apps/capture/src/main.ts",
        "apps/capture-preview-api/src/index.ts",
        "packages/capture-preview-domain/src/domain.ts",
        "packages/capture-protocol/src/generated.ts",
        "apps/capture/native-plugins/secure-queue/src/index.ts",
        "infra/preview/main.tf",
    ):
        assert classify_preview_scope(preview_input)["deploy"] == "true"

    unknown_scope = classify_preview_scope("packages/future-preview-runtime/src/index.ts")
    assert unknown_scope["deploy"] == "true"
    assert classify_preview_scope()["deploy"] == "true"


def test_capture_preview_scope_covers_changes_since_last_accepted_sha(
    tmp_path: Path,
) -> None:
    git(tmp_path, "init")
    git(tmp_path, "config", "user.email", "scope-test@example.invalid")
    git(tmp_path, "config", "user.name", "Scope Test")

    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "status.md").write_text("baseline\n", encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "baseline")
    accepted_sha = git(tmp_path, "rev-parse", "HEAD")

    preview_source = tmp_path / "apps" / "capture" / "src"
    preview_source.mkdir(parents=True)
    (preview_source / "main.ts").write_text("export const changed = true;\n", encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "preview change")
    preview_sha = git(tmp_path, "rev-parse", "HEAD")

    (docs / "status.md").write_text("documentation follow-up\n", encoding="utf-8")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "docs follow-up")
    latest_sha = git(tmp_path, "rev-parse", "HEAD")

    cumulative = classify_preview_range(tmp_path, accepted_sha, latest_sha)
    assert cumulative == {"deploy": "true", "reason": "preview_input_changed"}

    docs_only = classify_preview_range(tmp_path, preview_sha, latest_sha)
    assert docs_only == {"deploy": "false", "reason": "known_non_preview_paths_only"}

    empty_range = classify_preview_range(tmp_path, latest_sha, latest_sha)
    assert empty_range == {"deploy": "true", "reason": "no_changed_paths"}

    missing_history = classify_preview_range(tmp_path, "0" * 40, latest_sha)
    assert missing_history == {"deploy": "true", "reason": "history_unavailable"}


def test_pull_request_preview_has_no_cloud_credential_or_deployment_job() -> None:
    workflow = PR_WORKFLOW.read_text(encoding="utf-8")

    for forbidden in (
        "id-token: write",
        "environment: capture-preview",
        "Azure/login@",
        "static-web-apps-deploy@",
        "az staticwebapp secrets",
        "secrets.",
        "deploy-swa:",
        "distribute-android:",
        "close-swa:",
    ):
        assert forbidden not in workflow
    assert "types: [opened, synchronize, reopened]" in workflow
    assert "VITE_CAPTURE_E2E_MICROPHONE_ENABLED: 'false'" in workflow


def test_live_deploy_is_bound_to_successful_current_main_and_oidc_environment() -> None:
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")

    for required in (
        "workflow_run:",
        "workflows: [CI]",
        "actions: read",
        "github.event.workflow_run.conclusion == 'success'",
        "github.event.workflow_run.event == 'push'",
        "github.event.workflow_run.head_branch == 'main'",
        "vars.CAPTURE_PREVIEW_DEPLOY_ENABLED == 'true'",
        "current_main=",
        'test "${current_main}" = "${DEPLOY_SHA}"',
        "environment: capture-preview",
        "id-token: write",
        "CAPTURE_PREVIEW_AZURE_CLIENT_ID",
        "CAPTURE_PREVIEW_AZURE_TENANT_ID",
        "CAPTURE_PREVIEW_AZURE_SUBSCRIPTION_ID",
        "VITE_CAPTURE_E2E_MICROPHONE_ENABLED: 'false'",
        "npm run check:preview-bundle",
        "VITE_CAPTURE_PREVIEW_PERSISTENT_ENABLED: 'true'",
        "Azure/functions-action@",
        "az staticwebapp secrets list",
        "::add-mask::",
        "capture-preview-deployment.json",
        "apps/capture-preview-api/scripts/acceptance.mjs --dry-run",
        "npm ci --ignore-scripts --no-audit --no-fund",
        '--expected-sha "${DEPLOY_SHA}"',
        "actions/workflows/capture-preview-deploy.yml/runs",
        'select(.name == "accept")',
        '--range "${baseline_sha}" "${DEPLOY_SHA}"',
    ):
        assert required in workflow

    assert "secrets." not in workflow
    assert "client-secret" not in workflow
    assert "CAPTURE_PREVIEW_SWA_DEPLOYMENT_TOKEN" not in workflow
    assert "smoke:capture-preview-api" not in workflow
    # The first cloud mutation acquires the release lease. Once the Function
    # changes, web must complete from the same artifacts rather than aborting
    # into a mixed-version preview if main advances between the two jobs.
    assert workflow.count("Reverify current main before cloud mutation") == 1

    accept_job = workflow.split("\n  accept:\n", 1)[1]
    assert "actions/checkout@" in accept_job
    assert 'ref: ${{ env.DEPLOY_SHA }}' in accept_job
    assert 'test "${current_main}" = "${DEPLOY_SHA}"' in accept_job
    assert "CAPTURE_PREVIEW_ACCEPTANCE_AUTHORIZED: synthetic-only" in accept_job
    assert (
        "CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN: "
        "https://${{ vars.CAPTURE_PREVIEW_FUNCTION_APP_NAME }}.azurewebsites.net"
    ) in accept_job
    assert (
        "CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN: "
        "https://${{ vars.CAPTURE_PREVIEW_SWA_HOSTNAME }}"
    ) in accept_job
    assert "id-token: write" not in accept_job
    assert 'test "${direct_status}" = "401"' in accept_job
    assert accept_job.index("exact AuthV2 401 denial") < accept_job.index(
        "--execute-live"
    )
    assert "401|403" not in accept_job


def test_manual_acceptance_is_dormant_protected_and_has_no_cloud_identity() -> None:
    workflow = ACCEPT_WORKFLOW.read_text(encoding="utf-8")

    for required in (
        "workflow_dispatch:",
        "group: capture-preview-live",
        "authorization:",
        "not-authorized",
        "synthetic-only",
        "environment: capture-preview",
        "github.ref == 'refs/heads/main'",
        "permissions:\n  contents: read",
        '[[ "${DEPLOY_SHA}" =~ ^[0-9a-f]{40}$ ]]',
        'test "${current_main}" = "${DEPLOY_SHA}"',
        'test "${direct_status}" = "401"',
        "CAPTURE_PREVIEW_ACCEPTANCE_AUTHORIZED: synthetic-only",
        "CAPTURE_PREVIEW_EXPECTED_FUNCTION_ORIGIN: "
        "https://${{ vars.CAPTURE_PREVIEW_FUNCTION_APP_NAME }}.azurewebsites.net",
        "CAPTURE_PREVIEW_EXPECTED_SWA_ORIGIN: "
        "https://${{ vars.CAPTURE_PREVIEW_SWA_HOSTNAME }}",
        "npm ci --ignore-scripts --no-audit --no-fund",
        "apps/capture-preview-api/scripts/acceptance.mjs --dry-run",
        '--expected-sha "${DEPLOY_SHA}"',
        "Readiness variable: unchanged",
        "Function restart: not performed",
    ):
        assert required in workflow

    for forbidden in (
        "schedule:",
        "push:",
        "pull_request:",
        "id-token: write",
        "Azure/login@",
        "az functionapp restart",
        "CAPTURE_PREVIEW_SHARED_MOCK_READY=true",
        "secrets.",
        "401|403",
        "smoke:capture-preview-api",
    ):
        assert forbidden not in workflow


def test_preview_oidc_subject_uses_github_immutable_repository_ids() -> None:
    main = PREVIEW_MAIN.read_text(encoding="utf-8")
    variables = PREVIEW_VARIABLES.read_text(encoding="utf-8")
    immutable_prefix = "CosmaNeura@186940615/cosmaneura-scribe@1333303738"

    assert (
        'subject                   = "repo:${var.github_oidc_repository_subject}'
        ':environment:${var.github_environment}"'
        in main
    )
    assert f'default     = "{immutable_prefix}"' in variables
    assert "var.github_repository}" not in main


def test_every_deployment_action_is_immutably_pinned() -> None:
    workflows = (
        DEPLOY_WORKFLOW.read_text(encoding="utf-8"),
        ACCEPT_WORKFLOW.read_text(encoding="utf-8"),
    )
    action_references = [
        reference
        for workflow in workflows
        for reference in re.findall(r"^\s*-?\s*uses:\s*([^\s#]+)", workflow, re.MULTILINE)
    ]

    assert action_references
    for reference in action_references:
        assert re.search(r"@[0-9a-f]{40}$", reference), reference


def test_hosted_demo_policy_is_synthetic_and_microphone_disabled() -> None:
    static_config = STATIC_CONFIG.read_text(encoding="utf-8")
    vite_config = VITE_CONFIG.read_text(encoding="utf-8")
    runbook = RUNBOOK.read_text(encoding="utf-8")

    assert "microphone=()" in static_config
    assert "microphone=(self)" not in static_config
    assert "one stable Azure Static Web Apps URL" in runbook
    assert "do not receive a live API" in runbook
    assert "Real microphone capture is disabled by the build gate" in runbook
    assert "no platform BFF" in runbook
    assert "CAPTURE_PREVIEW_DEPLOY_ENABLED=false" in runbook
    assert '"route": "/capture-preview-deployment.json"' in static_config
    assert '"Cache-Control": "no-store"' in static_config
    assert 'globIgnores: ["**/*.map", DEPLOYMENT_ATTESTATION_PATH]' in vite_config
    assert 'schema_version: 1' in vite_config
    assert 'mode: "synthetic"' in vite_config
    assert 'microphone_enabled: false' in vite_config


def test_deployment_attestation_is_exact_and_build_injected() -> None:
    builder = PREVIEW_API_BUILDER.read_text(encoding="utf-8")
    vite_config = VITE_CONFIG.read_text(encoding="utf-8")
    deploy_workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    ci_workflow = CI_WORKFLOW.read_text(encoding="utf-8")
    pr_workflow = PR_WORKFLOW.read_text(encoding="utf-8")
    bundle_check = PREVIEW_BUNDLE_CHECK.read_text(encoding="utf-8")

    for source in (builder, vite_config):
        assert "DEPLOY_SHA" in source
        assert "^[0-9a-f]{40}$" in source

    assert "__CAPTURE_PREVIEW_DEPLOY_SHA__" in builder
    assert "JSON.stringify(deploySha)" in builder
    assert "schema_version: 1" in vite_config
    assert "github.event.workflow_run.head_sha" in deploy_workflow
    assert ci_workflow.count("DEPLOY_SHA: ${{ github.sha }}") == 3
    assert "github.event.pull_request.head.sha" in pr_workflow
    assert "ref: ${{ env.DEPLOY_SHA }}" in pr_workflow
    assert "attestation.source_sha !== sourceSha" in bundle_check
    assert "serviceWorker.includes(deploymentAttestationName)" in bundle_check


def test_preview_function_authv2_fails_closed_on_direct_requests() -> None:
    function = PREVIEW_FUNCTION.read_text(encoding="utf-8")

    auth_match = re.search(
        r"auth_settings_v2\s*\{(?P<body>.*?)\n\s*\}\n\n\s*site_config",
        function,
        re.DOTALL,
    )
    assert auth_match is not None
    auth = auth_match.group("body")

    for required in (
        "auth_enabled           = true",
        'runtime_version        = "~1"',
        "require_authentication = true",
        "require_https          = true",
        'unauthenticated_action = "Return401"',
        "client_id = azurerm_static_web_app.preview.default_host_name",
        "token_store_enabled = false",
    ):
        assert required in auth

    lifecycle_match = re.search(
        r"lifecycle\s*\{(?P<body>.*?)\n\s*\}", function, re.DOTALL
    )
    assert lifecycle_match is not None
    lifecycle = lifecycle_match.group("body")
    assert "auth_settings_v2" not in lifecycle
    assert "content_share_force_disabled," in lifecycle
    assert 'app_settings["WEBSITE_ENABLE_SYNC_UPDATE_SITE"],' in lifecycle
    assert 'app_settings["WEBSITE_RUN_FROM_PACKAGE"],' in lifecycle


def test_preview_function_host_storage_is_keyless_and_provider_normalized() -> None:
    function = PREVIEW_FUNCTION.read_text(encoding="utf-8")
    app_settings_match = re.search(
        r"app_settings\s*=\s*\{(?P<body>.*?)\n\s*\}", function, re.DOTALL
    )
    assert app_settings_match is not None
    app_settings = app_settings_match.group("body")

    assert "AzureWebJobsStorage__accountName" not in app_settings
    assert '"AzureWebJobsStorage__credential"' in app_settings
    assert '"AzureWebJobsStorage__clientId"' in app_settings
    assert "WEBSITE_CONTENTAZUREFILECONNECTIONSTRING" not in app_settings
    assert "WEBSITE_CONTENTSHARE" not in app_settings
    assert "storage_uses_managed_identity = true" in function
    assert "content_share_force_disabled  = true" in function


def test_preview_function_uses_the_supported_linux_consumption_runtime() -> None:
    function = PREVIEW_FUNCTION.read_text(encoding="utf-8")
    builder = PREVIEW_API_BUILDER.read_text(encoding="utf-8")
    deploy_workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    ci_workflow = CI_WORKFLOW.read_text(encoding="utf-8")

    assert 'sku_name            = "Y1"' in function
    assert 'node_version = "22"' in function
    assert 'target: "node22"' in builder
    assert 'engines: { node: ">=22.0.0 <23" }' in builder
    for workflow in (deploy_workflow, ci_workflow):
        assert "node-version: 22.23.2" in workflow
        assert "apps/capture-preview-api/scripts/verify-runtime.mjs" in workflow
    assert "Exercise preview Function source under Node 22" in ci_workflow
    assert "unzip -tq capture-preview-function/function.zip" in deploy_workflow
