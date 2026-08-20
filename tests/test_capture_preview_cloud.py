from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PR_WORKFLOW = ROOT / ".github" / "workflows" / "capture-preview.yml"
DEPLOY_WORKFLOW = ROOT / ".github" / "workflows" / "capture-preview-deploy.yml"
STATIC_CONFIG = ROOT / "apps" / "capture" / "public" / "staticwebapp.config.json"
RUNBOOK = ROOT / "docs" / "CAPTURE_PREVIEW.md"
PREVIEW_FUNCTION = ROOT / "infra" / "preview" / "function.tf"


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
        "smoke/smoke.mjs",
    ):
        assert required in workflow

    assert "secrets." not in workflow
    assert "client-secret" not in workflow
    assert "CAPTURE_PREVIEW_SWA_DEPLOYMENT_TOKEN" not in workflow


def test_every_deployment_action_is_immutably_pinned() -> None:
    workflow = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
    action_references = re.findall(r"^\s*-?\s*uses:\s*([^\s#]+)", workflow, re.MULTILINE)

    assert action_references
    for reference in action_references:
        assert re.search(r"@[0-9a-f]{40}$", reference), reference


def test_hosted_demo_policy_is_synthetic_and_microphone_disabled() -> None:
    static_config = STATIC_CONFIG.read_text(encoding="utf-8")
    runbook = RUNBOOK.read_text(encoding="utf-8")

    assert "microphone=()" in static_config
    assert "microphone=(self)" not in static_config
    assert "one stable Azure Static Web Apps URL" in runbook
    assert "do not receive a live API" in runbook
    assert "Real microphone capture is disabled by the build gate" in runbook
    assert "no platform BFF" in runbook
    assert "CAPTURE_PREVIEW_DEPLOY_ENABLED=false" in runbook


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
    assert "auth_settings_v2" not in lifecycle_match.group("body")
