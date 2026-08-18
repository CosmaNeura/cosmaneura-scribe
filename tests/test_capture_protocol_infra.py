from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VARIABLES = ROOT / "infra" / "variables.tf"
CONTAINER_APPS = ROOT / "infra" / "container_apps.tf"
DEVELOPMENT = ROOT / "infra" / "development.tfvars.example"
PRODUCTION = ROOT / "infra" / "production.tfvars.example"


def test_capture_protocol_is_an_independent_false_default_gate() -> None:
    variables = VARIABLES.read_text(encoding="utf-8")
    container_apps = CONTAINER_APPS.read_text(encoding="utf-8")

    block = variables.split('variable "enable_capture_protocol" {', maxsplit=1)[1].split(
        "\n}\n", maxsplit=1
    )[0]
    assert "default     = false" in block
    assert "var.enable_workflow_authentication" in block
    assert "var.use_postgres_repository" in block
    assert "COSMANEURA_SCRIBE_CAPTURE_PROTOCOL_ENABLED" in container_apps
    assert "tostring(var.enable_capture_protocol)" in container_apps
    assert "enable_capture_protocol = false" in DEVELOPMENT.read_text(encoding="utf-8")
    assert "enable_capture_protocol        = false" in PRODUCTION.read_text(encoding="utf-8")
