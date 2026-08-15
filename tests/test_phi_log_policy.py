from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check_phi_logs.py"


def _run_checker(tmp_path: Path, source: str) -> subprocess.CompletedProcess[str]:
    service = tmp_path / "services" / "api" / "src" / "cosmaneura_scribe"
    service.mkdir(parents=True)
    (service / "safe_logging.py").write_text(
        (
            "LOG_FIELD_ALLOWLIST = frozenset(\n"
            '    {"action", "entity_id", "tenant_id", "error_class", "duration_ms"}\n'
            ")\n"
            "def log_event(**kwargs: object) -> None:\n"
            "    pass\n"
        ),
        encoding="utf-8",
    )
    (service / "unsafe.py").write_text(source, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(CHECKER), "--root", str(tmp_path)],
        check=False,
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize(
    "source",
    [
        'logger.info(f"transcript={transcript}")\n',
        'logger.error("patient=%s dob=%s", patient_name, dob)\n',
        'logger.warning("blob=%s", blob_url)\n',
        "print(token)\n",
        (
            "from .safe_logging import log_event\n"
            "log_event(\n"
            '    action="upload.failed",\n'
            "    sas_url=sas_url,\n"
            ")\n"
        ),
        (
            "from .safe_logging import log_event\n"
            'log_event(action="auth.failed", **{"token": token})\n'
        ),
    ],
)
def test_ast_log_policy_rejects_unsafe_logging(tmp_path: Path, source: str) -> None:
    result = _run_checker(tmp_path, source)

    assert result.returncode != 0
    assert "Unsafe application logging" in result.stderr


def test_ast_log_policy_accepts_only_allowlisted_structured_fields(tmp_path: Path) -> None:
    result = _run_checker(
        tmp_path,
        (
            "from .safe_logging import log_event\n"
            "log_event(\n"
            '    action="workflow_auth.rejected",\n'
            "    tenant_id=tenant_id,\n"
            '    error_class="audience_mismatch",\n'
            "    duration_ms=duration_ms,\n"
            ")\n"
        ),
    )

    assert result.returncode == 0, result.stderr


def test_repository_sources_comply_with_ast_log_policy() -> None:
    result = subprocess.run(
        [sys.executable, str(CHECKER)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
