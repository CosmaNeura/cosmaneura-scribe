"""Pin Store vs direct-beta Mac public display names after Guideline 5.2.5."""

from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STORE_NAME = "Cosmas Scribe"
DIRECT_BETA_NAME = "Cosmaneura Scribe for Mac"
PRODUCT_NAME_EXPR = (
    'productName: storeXpc ? "Cosmaneura Scribe Store" : "Cosmaneura Scribe Beta"'
)
PACKAGING_SCRIPTS = (
    REPO / "scripts/assemble-disabled-desktop-candidate.py",
    REPO / "scripts/prepare-desktop-mas-variant.py",
    REPO / "scripts/assemble-standalone-provider.py",
)


def _string_literals(line: str) -> list[str]:
    return re.findall(r'"((?:\\.|[^"\\])*)"', line)


def test_direct_beta_names_match_main_baseline() -> None:
    release = (REPO / "apps/desktop-companion/desktop-release.json").read_text()
    assert f'"displayName": "{DIRECT_BETA_NAME}"' in release
    source = (REPO / "apps/desktop-companion/src/public-app-release.ts").read_text()
    assert f'PUBLIC_DIRECT_BETA_MAC_NAME = "{DIRECT_BETA_NAME}"' in source
    assert f'PUBLIC_STORE_MAC_NAME = "{STORE_NAME}"' in source
    html = (REPO / "apps/desktop-companion/standalone/provider.html").read_text()
    assert f"<title>{DIRECT_BETA_NAME}</title>" in html
    assemble = (REPO / "scripts/assemble-disabled-desktop-candidate.py").read_text()
    assert f'app = output / "{DIRECT_BETA_NAME}.app"' in assemble
    assert '"CFBundleName": "Cosmaneura Scribe Beta"' in assemble
    assert '"CFBundleDisplayName": release["displayName"] + " " + marker' in assemble
    assert f'release.get("displayName") != "{DIRECT_BETA_NAME}"' in assemble
    host = (REPO / "scripts/build-desktop-provider-host.mjs").read_text()
    assert f'release.displayName !== "{DIRECT_BETA_NAME}"' in host


def test_store_public_names_are_cosmas_scribe_without_mac() -> None:
    source = (REPO / "apps/desktop-companion/src/public-app-release.ts").read_text()
    assert f'PUBLIC_STORE_MAC_NAME = "{STORE_NAME}"' in source
    assert re.search(r"mac", STORE_NAME, re.I) is None
    mas = (REPO / "scripts/prepare-desktop-mas-variant.py").read_text()
    assert f'"CFBundleName": "{STORE_NAME}"' in mas
    assert f'"CFBundleDisplayName": "{STORE_NAME}"' in mas
    host = (REPO / "scripts/build-desktop-provider-host.mjs").read_text()
    assert f'const publicDisplayName = store ? "{STORE_NAME}" : release.displayName;' in host


def test_product_name_pin_rejects_mac_in_product_name() -> None:
    host = (REPO / "scripts/build-desktop-provider-host.mjs").read_text()
    assert PRODUCT_NAME_EXPR in host
    for match in re.finditer(r"productName:\s*([^,\n]+)", host):
        assert re.search(r"mac", match.group(1), re.I) is None


def test_cfbundle_string_literals_on_packaging_lines_exclude_mac() -> None:
    for path in PACKAGING_SCRIPTS:
        for line in path.read_text().splitlines():
            if "CFBundleName" not in line and "CFBundleDisplayName" not in line:
                continue
            for literal in _string_literals(line):
                assert "Mac" not in literal, f"{path.name}: {line.strip()}"


def test_assemble_pins_display_name_expression_and_cfbundlename() -> None:
    assemble = (REPO / "scripts/assemble-disabled-desktop-candidate.py").read_text()
    assert '"CFBundleDisplayName": release["displayName"] + " " + marker' in assemble
    assert '"CFBundleName": "Cosmaneura Scribe Beta"' in assemble
