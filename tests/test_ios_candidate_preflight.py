from __future__ import annotations

import hashlib
import json
import plistlib
import runpy
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/check_ios_candidate.py"
PREFLIGHT = runpy.run_path(str(SCRIPT))
INSPECT = PREFLIGHT["inspect_candidate"]
BUNDLE = "com.cosmaneura.synthetic.fixture"
# Invented hostname. No network request occurs, including in successful cases.
ORIGIN = "https://scribe-beta.fixture-clinic.dev"
ROOT = "Payload/Fixture.app/"


def _files(*, origin: str = ORIGIN, bundle: str = BUNDLE) -> dict[str, bytes]:
    return {
        ROOT + "Info.plist": plistlib.dumps(
            {
                "CFBundleIdentifier": bundle,
                "CFBundleSupportedPlatforms": ["iPhoneOS"],
                "MinimumOSVersion": "17.0",
                "CosmasNativeAuth": {"enabled": True},
            }
        ),
        ROOT + "capacitor.config.json": json.dumps(
            {
                "appId": bundle,
                "loggingBehavior": "none",
            }
        ).encode(),
        ROOT
        + "public/index.html": b'<script type="module" src="./assets/index-fixture.js"></script>',
        ROOT + "public/assets/index-fixture.js": (
            "const config={VITE_API_BASE:"
            + json.dumps(origin)
            + ',VITE_WORKSPACE_NATIVE_AUTH_ENABLED:"true",VITE_COSMAS_ENV:"synth_os",'
            + 'VITE_WORKSPACE_ENABLED:"true",VITE_WORKSPACE_AUTHENTICATED_ENABLED:"true",'
            + 'VITE_WORKSPACE_NATIVE_SYNTHETIC_ENABLED:"false",'
            + 'VITE_DESKTOP_SYNTHETIC_ENABLED:"false"};'
        ).encode(),
    }


def _ipa(tmp_path: Path, files: dict[str, bytes]) -> Path:
    path = tmp_path / "fixture.ipa"
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return path


def _check(path: Path, **kwargs):
    return INSPECT(
        path,
        expected_bundle_id=kwargs.pop("expected_bundle_id", BUNDLE),
        approved_api_origin=kwargs.pop("approved_api_origin", ORIGIN),
        **kwargs,
    )


def test_static_pass_is_not_network_identity_signature_or_release_acceptance(tmp_path):
    path = _ipa(tmp_path, _files())
    before = path.read_bytes()
    result = _check(path)
    assert result["static_preflight_passed"] is True
    assert result["findings"] == []
    assert result["ipa_sha256"] == hashlib.sha256(before).hexdigest()
    assert result["expected_bundle_id_sha256"] == hashlib.sha256(BUNDLE.encode()).hexdigest()
    assert result["approved_api_origin_sha256"] == hashlib.sha256(ORIGIN.encode()).hexdigest()
    for name in (
        "network_verified",
        "signature_verified",
        "authentication_verified",
        "physical_device_verified",
        "release_accepted",
    ):
        assert result[name] is False
    assert path.read_bytes() == before
    assert sorted(item.name for item in tmp_path.iterdir()) == ["fixture.ipa"]
    assert ORIGIN not in json.dumps(result)


@pytest.mark.parametrize(
    "origin",
    [
        "http://127.0.0.1:8046",
        "https://127.0.0.1",
        "https://[::1]",
        "https://localhost",
        "https://api.localhost",
        "https://api.local",
        "https://api.internal",
        "https://api.invalid",
        "https://10.0.0.2",
        "https://8.8.8.8",
        "https://2130706433",
        "https://0x7f000001",
        "https://api.example.com",
        "https://api.test",
        "https://localhost.",
        "https://api",
        ORIGIN + "/api",
        ORIGIN + "/?",
        ORIGIN + "#",
        ORIGIN + "?token=synthetic-secret-marker",
        "https://synthetic-secret-marker@scribe-beta.fixture-clinic.dev",
        ORIGIN + ":8443",
        ORIGIN + "\\wrong",
        ORIGIN + "\n",
    ],
)
def test_non_candidate_or_credential_bearing_endpoint_fails_without_echo(tmp_path, origin):
    result = _check(_ipa(tmp_path, _files(origin=origin)))
    assert "api_origin_not_device_candidate" in result["findings"]
    assert result["static_preflight_passed"] is False
    assert "synthetic-secret-marker" not in json.dumps(result)
    assert origin not in json.dumps(result)


@pytest.mark.parametrize(
    ("approved", "finding"),
    [
        (None, "approved_api_origin_missing"),
        ("http://localhost:8046", "approved_api_origin_invalid"),
        ("https://other.fixture-clinic.dev", "api_origin_not_approved"),
    ],
)
def test_explicit_exact_destination_required(tmp_path, approved, finding):
    result = _check(_ipa(tmp_path, _files()), approved_api_origin=approved)
    assert finding in result["findings"]


def test_wrong_app_and_mismatched_capacitor_identity_rejected(tmp_path):
    files = _files(bundle="com.cosmasos.synthetic.w13")
    files[ROOT + "capacitor.config.json"] = json.dumps(
        {
            "appId": "com.cosmaneura.synthetic.other",
            "loggingBehavior": "none",
        }
    ).encode()
    result = _check(_ipa(tmp_path, files))
    assert set(result["findings"]) == {"bundle_identity_mismatch", "capacitor_identity_mismatch"}


@pytest.mark.parametrize(
    ("key", "value", "finding"),
    [
        ("MinimumOSVersion", "27.0", "ios17_support_floor_not_preserved"),
        ("MinimumOSVersion", None, "ios17_support_floor_not_preserved"),
        ("CFBundleSupportedPlatforms", ["iPhoneSimulator"], "not_iphoneos_package"),
        ("CosmasNativeAuth", {"enabled": "true"}, "native_auth_not_configured"),
        ("CosmasNativeAuth", {"enabled": False}, "native_auth_not_configured"),
    ],
)
def test_device_floor_platform_and_native_auth_metadata(tmp_path, key, value, finding):
    files = _files()
    info = plistlib.loads(files[ROOT + "Info.plist"])
    if value is None:
        info.pop(key)
    else:
        info[key] = value
    files[ROOT + "Info.plist"] = plistlib.dumps(info)
    assert finding in _check(_ipa(tmp_path, files))["findings"]


@pytest.mark.parametrize(
    "html",
    [
        '<script type="module" src="https://foreign.fixture-clinic.dev/main.js"></script>',
        '<script type="module" src="../secret.js"></script>',
        '<script type="module" src="./assets/missing.js"></script>',
        '<script type="module" '
        'src="./assets/index-fixture.js?token=synthetic-secret-marker"></script>',
        '<script type="module" src="./assets/index-fixture.js" src="./assets/other.js"></script>',
        "<script>synthetic-secret-marker</script>",
        '<base href="https://foreign.fixture-clinic.dev/">'
        '<script src="./assets/index-fixture.js"></script>',
        '<script type="module" src="./assets/index-fixture.js"></script>' * 2,
    ],
)
def test_only_supported_referenced_entry_is_inspected(tmp_path, html):
    files = _files()
    files[ROOT + "public/index.html"] = html.encode()
    result = _check(_ipa(tmp_path, files))
    assert result["static_preflight_passed"] is False
    assert "synthetic-secret-marker" not in json.dumps(result)


@pytest.mark.parametrize(
    "transform",
    [
        lambda source: source + source,
        lambda source: source.replace(b"VITE_API_BASE:", b"OTHER_API_BASE:"),
        lambda source: source.replace(json.dumps(ORIGIN).encode(), b"computeOrigin()"),
    ],
)
def test_unknown_or_ambiguous_compiled_config_fails_closed(tmp_path, transform):
    files = _files()
    entry = ROOT + "public/assets/index-fixture.js"
    files[entry] = transform(files[entry])
    assert "compiled_config_unsupported" in _check(_ipa(tmp_path, files))["findings"]


def test_unreferenced_good_asset_cannot_hide_bad_entry(tmp_path):
    files = _files(origin="http://127.0.0.1:8046")
    files[ROOT + "public/assets/unreferenced.js"] = _files()[
        ROOT + "public/assets/index-fixture.js"
    ]
    assert "api_origin_not_device_candidate" in _check(_ipa(tmp_path, files))["findings"]


@pytest.mark.parametrize("extra", ["../outside", "/absolute", "Payload/Other.app/Info.plist"])
def test_ambiguous_or_unsafe_archive_does_not_extract(tmp_path, extra):
    files = _files()
    files[extra] = b"synthetic-secret-marker"
    result = _check(_ipa(tmp_path, files))
    assert "archive_layout_unsupported" in result["findings"]
    assert "synthetic-secret-marker" not in json.dumps(result)
    assert sorted(item.name for item in tmp_path.iterdir()) == ["fixture.ipa"]


def test_symlink_and_duplicate_member_rejected(tmp_path):
    path = _ipa(tmp_path, _files())
    with zipfile.ZipFile(path, "a") as archive:
        symlink = zipfile.ZipInfo(ROOT + "linked")
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(symlink, "synthetic-secret-marker")
    assert "archive_layout_unsupported" in _check(path)["findings"]
    path = _ipa(tmp_path, _files())
    with zipfile.ZipFile(path, "a") as archive, pytest.warns(UserWarning):
        archive.writestr(ROOT + "Info.plist", b"synthetic-secret-marker")
    assert "archive_layout_unsupported" in _check(path)["findings"]


def test_cli_failure_is_metadata_only_and_nonzero(tmp_path):
    path = _ipa(tmp_path, _files(origin="http://127.0.0.1:8046"))
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--ipa",
            str(path),
            "--expected-bundle-id",
            BUNDLE,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 1
    report = json.loads(completed.stdout)
    assert report["findings"] == ["api_origin_not_device_candidate", "approved_api_origin_missing"]
    assert completed.stderr == ""
    assert "127.0.0.1" not in completed.stdout


def test_unreadable_input_does_not_expose_filename(tmp_path):
    result = _check(tmp_path / "synthetic-secret-marker.ipa")
    assert result["findings"] == ["candidate_unreadable"]
    assert "synthetic-secret-marker" not in json.dumps(result)


@pytest.mark.parametrize(
    "key",
    [
        "VITE_WORKSPACE_ENABLED",
        "VITE_WORKSPACE_AUTHENTICATED_ENABLED",
        "VITE_WORKSPACE_NATIVE_SYNTHETIC_ENABLED",
        "VITE_DESKTOP_SYNTHETIC_ENABLED",
    ],
)
def test_disabled_or_synthetic_identity_profile_is_not_native_acceptance(tmp_path, key):
    files = _files()
    entry = ROOT + "public/assets/index-fixture.js"
    old = b"false" if "SYNTHETIC" in key else b"true"
    new = b"true" if old == b"false" else b"false"
    files[entry] = files[entry].replace(key.encode() + b':"' + old, key.encode() + b':"' + new)
    assert "native_auth_trial_profile_mismatch" in _check(_ipa(tmp_path, files))["findings"]


@pytest.mark.parametrize(
    ("file", "body"),
    [
        ("capacitor.config.json", b'{"appId":"synthetic-secret-marker","appId":"other"}'),
        (
            "Info.plist",
            b"<plist><dict><key>enabled</key><true/><key>enabled</key><true/></dict></plist>",
        ),
    ],
)
def test_ambiguous_metadata_fails_closed(tmp_path, file, body):
    files = _files()
    files[ROOT + file] = body
    result = _check(_ipa(tmp_path, files))
    assert "candidate_metadata_ambiguous" in result["findings"]
    assert "synthetic-secret-marker" not in json.dumps(result)


@pytest.mark.parametrize(
    ("file", "body"),
    [
        ("Info.plist", b"<plist><dict><key>synthetic-secret-marker</key>"),
        ("capacitor.config.json", b"{synthetic-secret-marker"),
        ("capacitor.config.json", b"[]"),
    ],
)
def test_malformed_metadata_does_not_leak_parser_errors(tmp_path, file, body):
    files = _files()
    files[ROOT + file] = body
    result = _check(_ipa(tmp_path, files))
    assert result["static_preflight_passed"] is False
    assert "synthetic-secret-marker" not in json.dumps(result)


@pytest.mark.parametrize(
    ("key", "value", "finding"),
    [
        (
            "server",
            {"url": "https://synthetic-secret-marker.invalid"},
            "remote_webview_config_unsupported",
        ),
        ("loggingBehavior", "debug", "bridge_logging_not_disabled"),
    ],
)
def test_remote_webview_or_bridge_logging_blocks_trial(tmp_path, key, value, finding):
    files = _files()
    config = json.loads(files[ROOT + "capacitor.config.json"])
    config[key] = value
    files[ROOT + "capacitor.config.json"] = json.dumps(config).encode()
    result = _check(_ipa(tmp_path, files))
    assert finding in result["findings"]
    assert "synthetic-secret-marker" not in json.dumps(result)


@pytest.mark.parametrize(
    ("setting", "finding"),
    [
        ("MAX_ARCHIVE_BYTES", "archive_size_unsupported"),
        ("MAX_MEMBER_BYTES", "archive_member_unsupported"),
        ("MAX_MEMBERS", "archive_layout_unsupported"),
    ],
)
def test_bounded_archive_reads(tmp_path, monkeypatch, setting, finding):
    path = _ipa(tmp_path, _files())
    monkeypatch.setitem(INSPECT.__globals__, setting, 1)
    assert finding in _check(path)["findings"]
