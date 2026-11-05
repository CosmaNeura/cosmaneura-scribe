from __future__ import annotations

import importlib.util
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import cast

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check_staging_build_hosts.py"


def _checker() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_staging_build_hosts", CHECKER)
    if spec is None or spec.loader is None:
        raise RuntimeError("staging build host checker could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_repository_staging_surfaces_do_not_name_live_hosts() -> None:
    find_violations = cast(Callable[[Path], list[dict[str, object]]], _checker().find_violations)
    assert find_violations(ROOT) == []


def test_staging_assemble_default_with_live_host_is_refused(tmp_path: Path) -> None:
    module = _checker()
    find_violations = cast(Callable[[Path], list[dict[str, object]]], module.find_violations)

    # Minimal mirror of required staging surfaces so the scanner runs.
    for relative in module.STAGING_QUALIFICATION_PATHS:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if relative.endswith("assemble-standalone-provider.py"):
            path.write_text(
                'coreOrigin = "https://app.cosmaneura.com"\n'
                'frontend = "https://clerk.cosmaneura.com"\n',
                encoding="utf-8",
            )
        else:
            path.write_text('coreOrigin = "https://staging-app.cosmaneura.com"\n', encoding="utf-8")

    violations = find_violations(tmp_path)
    assert any(
        item["path"] == "scripts/assemble-standalone-provider.py"
        and item["reason"] == "staging_or_qualification_names_live_host"
        for item in violations
    )


def test_founder_production_path_may_name_live_hosts(tmp_path: Path) -> None:
    module = _checker()
    find_violations = cast(Callable[[Path], list[dict[str, object]]], module.find_violations)

    for relative in module.STAGING_QUALIFICATION_PATHS:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('coreOrigin = "https://staging-app.cosmaneura.com"\n', encoding="utf-8")

    production = tmp_path / "scripts/standalone-provider/prepare_production_profiles.py"
    production.parent.mkdir(parents=True, exist_ok=True)
    production.write_text(
        'ORIGIN = "https://app.cosmaneura.com"\nISSUER = "https://clerk.cosmaneura.com"\n',
        encoding="utf-8",
    )

    assert find_violations(tmp_path) == []


def test_staging_named_profile_fixture_is_scanned(tmp_path: Path) -> None:
    module = _checker()
    find_violations = cast(Callable[[Path], list[dict[str, object]]], module.find_violations)

    for relative in module.STAGING_QUALIFICATION_PATHS:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('coreOrigin = "https://staging-app.cosmaneura.com"\n', encoding="utf-8")

    fixture = tmp_path / "apps/capture/fixtures/ios-staging-profile.json"
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_text(
        '{"frontendOrigin":"https://clerk.cosmaneura.com","coreOrigin":"https://app.cosmaneura.com"}\n',
        encoding="utf-8",
    )

    violations = find_violations(tmp_path)
    assert any(
        item["path"] == "apps/capture/fixtures/ios-staging-profile.json"
        and "clerk.cosmaneura.com" in cast(list[str], item["markers"])
        for item in violations
    )


def test_missing_required_staging_surface_fails_closed(tmp_path: Path) -> None:
    module = _checker()
    find_violations = cast(Callable[[Path], list[dict[str, object]]], module.find_violations)
    violations = find_violations(tmp_path)
    assert any(item["reason"] == "required_staging_surface_missing" for item in violations)


def test_staging_app_host_is_not_flagged_as_live() -> None:
    find_live_markers = cast(Callable[[str], list[str]], _checker().find_live_markers)
    assert find_live_markers('coreOrigin = "https://staging-app.cosmaneura.com"') == []
    assert find_live_markers('coreOrigin = "https://app.cosmaneura.com"') == ["app.cosmaneura.com"]
    assert find_live_markers('issuer = "https://clerk.cosmaneura.com"') == ["clerk.cosmaneura.com"]
