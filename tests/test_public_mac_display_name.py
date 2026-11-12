"""Pin the public Mac app display name after Apple Guideline 5.2.5 rejection."""

from __future__ import annotations

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PUBLIC_NAME = "Cosmas Scribe"


def test_desktop_release_and_source_use_cosmas_scribe() -> None:
    release = json.loads((REPO / "apps/desktop-companion/desktop-release.json").read_text())
    assert release["displayName"] == PUBLIC_NAME
    assert re.search(r"mac", release["displayName"], re.I) is None
    source = (REPO / "apps/desktop-companion/src/public-app-release.ts").read_text()
    assert f'PUBLIC_MAC_NAME = "{PUBLIC_NAME}"' in source
    assert "Scribe for Mac" not in source
    assert "for Mac" not in source
    html = (REPO / "apps/desktop-companion/standalone/provider.html").read_text()
    assert f"<title>{PUBLIC_NAME}</title>" in html
    assert re.search(r"for Mac|Scribe for Mac", html, re.I) is None


def test_packaging_scripts_emit_cosmas_scribe_without_mac() -> None:
    host = (REPO / "scripts/build-desktop-provider-host.mjs").read_text()
    assert f'release.displayName !== "{PUBLIC_NAME}"' in host
    assert "Scribe for Mac" not in host
    assemble = (REPO / "scripts/assemble-disabled-desktop-candidate.py").read_text()
    assert f'release.get("displayName") != "{PUBLIC_NAME}"' in assemble
    assert 'output / (str(release["displayName"]) + ".app")' in assemble
    assert '"CFBundleName": release["displayName"]' in assemble
    assert "Cosmaneura Scribe for Mac" not in assemble
    mas = (REPO / "scripts/prepare-desktop-mas-variant.py").read_text()
    assert f'"CFBundleName": "{PUBLIC_NAME}"' in mas
    assert f'"CFBundleDisplayName": "{PUBLIC_NAME}"' in mas
    assert "for Mac" not in mas
    assert re.search(r"mac", PUBLIC_NAME, re.I) is None
