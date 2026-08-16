from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / "infra" / "runner" / "metadata.py"


def _run(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(METADATA), *arguments],
        check=False,
        capture_output=True,
        text=True,
    )


def test_metadata_reads_only_typed_fields(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    state.write_text(
        json.dumps(
            {
                "lineage": "9cc263b9-f1e2-dfc8-4a33-a67cb73459a6",
                "serial": 27,
            }
        ),
        encoding="utf-8",
    )

    lineage = _run("read-field", str(state), "lineage", "string")
    serial = _run("read-field", str(state), "serial", "integer")

    assert lineage.returncode == 0
    assert lineage.stdout == "9cc263b9-f1e2-dfc8-4a33-a67cb73459a6\n"
    assert serial.returncode == 0
    assert serial.stdout == "27\n"


def test_metadata_rejects_invalid_input_without_detail(tmp_path: Path) -> None:
    state = tmp_path / "state.json"
    state.write_text('{"serial":true,"unsafe":"do-not-echo"}\n', encoding="utf-8")

    result = _run("read-field", str(state), "serial", "integer")

    assert result.returncode == 1
    assert result.stdout == ""
    assert result.stderr == ""


def test_metadata_writes_the_pinned_manifest_shape(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    plan_sha256 = "a" * 64
    lineage = "9cc263b9-f1e2-dfc8-4a33-a67cb73459a6"

    result = _run("write-manifest", str(manifest), plan_sha256, lineage, "27")

    assert result.returncode == 0
    assert json.loads(manifest.read_text(encoding="utf-8")) == {
        "format_version": 1,
        "plan_sha256": plan_sha256,
        "state_lineage": lineage,
        "state_serial": 27,
    }
