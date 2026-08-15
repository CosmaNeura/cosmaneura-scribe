from __future__ import annotations

import importlib.util
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import cast

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check_adr_numbers.py"


def _checker_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_adr_numbers", CHECKER)
    if spec is None or spec.loader is None:
        raise RuntimeError("ADR checker could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _find_violations(directory: Path) -> list[str]:
    function = cast(
        Callable[[Path], list[str]],
        _checker_module().find_adr_number_violations,
    )
    return function(directory)


def test_duplicate_adr_prefixes_are_reported_deterministically(tmp_path: Path) -> None:
    (tmp_path / "0008-alpha.md").write_text("# alpha\n", encoding="utf-8")
    (tmp_path / "0008-beta.md").write_text("# beta\n", encoding="utf-8")

    assert _find_violations(tmp_path) == ["Duplicate ADR number 0008: 0008-alpha.md, 0008-beta.md"]


def test_unique_adr_prefixes_are_accepted(tmp_path: Path) -> None:
    (tmp_path / "0008-alpha.md").write_text("# alpha\n", encoding="utf-8")
    (tmp_path / "0009-beta.md").write_text("# beta\n", encoding="utf-8")

    assert _find_violations(tmp_path) == []


def test_malformed_adr_names_cannot_evade_the_check(tmp_path: Path) -> None:
    (tmp_path / "8-short.md").write_text("# short\n", encoding="utf-8")
    (tmp_path / "0008-Mixed.MD").write_text("# mixed\n", encoding="utf-8")

    assert _find_violations(tmp_path) == [
        "Malformed ADR filename: 0008-Mixed.MD",
        "Malformed ADR filename: 8-short.md",
    ]


def test_repository_adr_prefixes_are_unique() -> None:
    assert _find_violations(ROOT / "docs" / "adr") == []
