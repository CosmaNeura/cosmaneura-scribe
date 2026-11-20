"""Synthetic fixtures only for write_production_inputs; no production values."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

from prepare_production_profiles import project
from write_production_inputs import (
    _HELPER_PATHS,
    _PUBLISHABLE_KEY_STOP,
    build_payload,
    encode_publishable_key,
    main,
    validator_clerk_host_literal,
)

SCRIPT = Path(__file__).resolve().with_name("write_production_inputs.py")

# Clearly synthetic — must never match live production ids/hashes/origins.
SYNTH_BOX = "10000000-0000-4000-8000-000000000002"
SYNTH_ENV = "10000000-0000-4000-8000-000000000001"
SYNTH_MI = "10000000-0000-4000-8000-000000000003"
SYNTH_SCOPE = "api://10000000-0000-4000-8000-000000000004/.default"
SYNTH_ORIGIN = "https://syntheticfixture.blob.core.windows.net"
SYNTH_RECEIVER_ORIGIN = "https://synthetic-fixture-production.example.azurecontainerapps.io"
SYNTH_RECEIPT_A = "a" * 64
SYNTH_RECEIPT_B = "b" * 64
SYNTH_RECEIPT_C = "c" * 64
SYNTH_RECEIPT_D = "d" * 64
DISALLOWED_WORKSPACE = "56f527ab-0caf-459b-bda9-cf7f0ca2f709"

FIXTURE_SECRETS = (
    SYNTH_BOX,
    SYNTH_ENV,
    SYNTH_MI,
    SYNTH_SCOPE,
    SYNTH_ORIGIN,
    SYNTH_RECEIVER_ORIGIN,
    SYNTH_RECEIPT_A,
    SYNTH_RECEIPT_B,
    SYNTH_RECEIPT_C,
    SYNTH_RECEIPT_D,
    DISALLOWED_WORKSPACE,
)


def _receiver(*, profile: str = "core-production-personal-v1", enabled: bool = True, **extra):
    body = {
        "authority_backend": "core-provider-context-v1",
        "beta_box_id": SYNTH_BOX,
        "core_scope": SYNTH_SCOPE,
        "database_host": None,
        "database_name": None,
        "database_reader_role": None,
        "desktop_native_session_without_origin": False,
        "enabled": enabled,
        "encounter_creation_enabled": True,
        "environment_id": SYNTH_ENV,
        "ingress_isolation_receipt": "synthetic-fixture-receipt",
        "managed_identity_client_id": SYNTH_MI,
        "native_visit_actions_v2_enabled": True,
        "platforms": ["ios", "desktop"],
        "production": {
            "audience": None,
            "core_origin": "https://app.cosmaneura.com",
            "deployment_receipt_sha256": SYNTH_RECEIPT_A,
            "issuer": "https://clerk.cosmaneura.com",
            "native_policy_receipt_sha256": SYNTH_RECEIPT_B,
            "organization_id": None,
            "protected_data_receipt_sha256": SYNTH_RECEIPT_C,
            "receiver_origin": SYNTH_RECEIVER_ORIGIN,
            "session_claims_receipt_sha256": SYNTH_RECEIPT_D,
        },
        "profile": profile,
        "schema": 1,
        **extra,
    }
    return body


def write_pin(
    path: Path,
    *,
    receiver: dict | None = None,
    origins: list[str] | None = None,
    duplicate_receiver: bool = False,
) -> Path:
    receiver = receiver or _receiver()
    origins = origins if origins is not None else [SYNTH_ORIGIN]
    encoded = json.dumps(json.dumps(receiver, separators=(",", ":")))
    origins_hcl = ", ".join(f'"{item}"' for item in origins)
    duplicate = ""
    if duplicate_receiver:
        duplicate = f"\n  receiver_configuration_json = {encoded}\n"
    text = f"""
locals {{
  production_live_scribe_native_production_rollout = {{
    capture_upload_origins = toset([{origins_hcl}])
  }}
  production_live_scribe_core_bundle = {{
    receiver_configuration_json = {encoded}
  }}
}}
{duplicate}
"""
    path.write_text(text)
    return path


def helpers(tmp_path: Path) -> dict[str, Path]:
    paths = {}
    for role, name in (
        ("auth", "ScribeDesktopProvider"),
        ("audio", "ScribeDesktopAudioHelper"),
        ("presentation", "ScribeProviderPresentationHelper"),
    ):
        path = tmp_path / name
        path.write_bytes(f"synthetic-inert-{role}-fixture".encode())
        paths[role] = path
    return paths


def fixture_digests(paths: dict[str, Path]) -> set[str]:
    digests: set[str] = set()
    for path in paths.values():
        if path.is_file():
            digests.add(hashlib.sha256(path.read_bytes()).hexdigest())
    return digests


def assert_no_fixture_values(text: str, paths: dict[str, Path]) -> None:
    publishable = encode_publishable_key(validator_clerk_host_literal())
    banned = set(FIXTURE_SECRETS) | fixture_digests(paths) | {publishable}
    for value in banned:
        assert value not in text, "fixture value leaked into output stream"


def run_writer(tmp_path: Path, *, pin: Path, out: Path, extra: list[str] | None = None):
    paths = helpers(tmp_path)
    argv = [
        "--core-pin",
        str(pin),
        "--auth-build",
        str(paths["auth"]),
        "--audio-build",
        str(paths["audio"]),
        "--presentation-build",
        str(paths["presentation"]),
        "--out",
        str(out),
        *(extra or []),
    ]
    code = main(argv)
    return code, paths


def test_happy_path_passes_validator_and_mode_0600(tmp_path, capsys):
    pin = write_pin(tmp_path / "synthetic_pin.tf")
    out = tmp_path / "production-inputs.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 0
    payload = json.loads(out.read_text())
    project(payload)
    assert payload["schema"] == 1
    assert payload["receiver"]["enabled"] is False
    assert payload["receiver"]["profile"] == "core-production-personal-v1"
    assert payload["receiver"]["production"]["deployment_receipt_sha256"] == SYNTH_RECEIPT_A
    assert payload["client"]["workspace_id"] == SYNTH_BOX
    assert payload["client"]["upload_origin"] == SYNTH_ORIGIN
    assert payload["client"]["publishable_key"] == encode_publishable_key(
        validator_clerk_host_literal()
    )
    for role, relative in _HELPER_PATHS.items():
        assert payload["desktop_helpers"][role]["path"] == relative
        assert payload["desktop_helpers"][role]["sha256"] == hashlib.sha256(
            paths[role].read_bytes()
        ).hexdigest()
    mode = stat.S_IMODE(out.stat().st_mode)
    assert mode == 0o600
    captured = capsys.readouterr()
    combined = captured.out + captured.err
    assert "output: " + str(out) in captured.out
    assert "schema: present" in captured.out
    assert "client.publishable_key: present" in captured.out
    assert_no_fixture_values(combined, paths)
    # Never dump JSON, hash the written file for display, or diff it.
    assert "{" not in captured.out and "}" not in captured.out
    assert out.read_text() not in combined
    assert "diff" not in combined.lower()


def test_refuse_when_output_exists(tmp_path):
    pin = write_pin(tmp_path / "synthetic_pin.tf")
    out = tmp_path / "exists.json"
    out.write_text("already-here")
    paths = helpers(tmp_path)
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--presentation-build",
            str(paths["presentation"]),
            "--out",
            str(out),
        ],
        cwd=str(SCRIPT.parent),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "refuse:output:exists" in result.stderr
    assert_no_fixture_values(result.stdout + result.stderr, paths)


def test_refuse_malformed_pin(tmp_path, capsys):
    pin = tmp_path / "bad.tf"
    pin.write_text("locals { }\n")
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_ambiguous_receiver_assignment(tmp_path, capsys):
    pin = write_pin(tmp_path / "dup.tf", duplicate_receiver=True)
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:assignment:receiver_configuration_json:missing_or_ambiguous" in captured.err
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_non_matching_expect_profile_prints_labels_only(tmp_path, capsys):
    pin = write_pin(
        tmp_path / "org.tf",
        receiver=_receiver(profile="core-production-organization-v1"),
    )
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "expect_profile: core-production-personal-v1" in captured.err
    assert "pin_profile: core-production-organization-v1" in captured.err
    assert SYNTH_BOX not in captured.err
    assert SYNTH_ORIGIN not in captured.err
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_expect_profile_flag_accepts_matching_label(tmp_path, capsys):
    pin = write_pin(tmp_path / "personal.tf")
    out = tmp_path / "out.json"
    code, paths = run_writer(
        tmp_path,
        pin=pin,
        out=out,
        extra=["--expect-profile", "core-production-personal-v1"],
    )
    assert code == 0
    assert_no_fixture_values(capsys.readouterr().out + capsys.readouterr().err, paths)


def test_refuse_disallowed_workspace(tmp_path, capsys):
    pin = write_pin(
        tmp_path / "bad_box.tf",
        receiver=_receiver(beta_box_id=DISALLOWED_WORKSPACE),
    )
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:client.workspace_id:disallowed" in captured.err
    assert DISALLOWED_WORKSPACE not in captured.out + captured.err
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_bad_origin_count(tmp_path, capsys):
    pin = write_pin(tmp_path / "origins.tf", origins=[SYNTH_ORIGIN, "https://otherfixture.blob.core.windows.net"])
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:capture_upload_origins:count" in captured.err
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_non_https_origin(tmp_path, capsys):
    pin = write_pin(tmp_path / "http.tf", origins=["http://syntheticfixture.blob.core.windows.net"])
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:capture_upload_origins:not_https" in captured.err
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_missing_helper(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    paths["audio"].unlink()
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--presentation-build",
            str(paths["presentation"]),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:helper:" in captured.err
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_publishable_key_mismatch_stops_with_names_only(tmp_path, capsys, monkeypatch):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)

    def _wrong_key(_host: bytes) -> str:
        return "pk_live_not-validator-literal-fixture"

    monkeypatch.setattr(
        "write_production_inputs.encode_publishable_key",
        _wrong_key,
    )
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--presentation-build",
            str(paths["presentation"]),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert _PUBLISHABLE_KEY_STOP in captured.err
    assert "pk_live_" not in captured.out
    assert "pk_live_not-validator-literal-fixture" not in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_subprocess_happy_path_leaks_no_fixture_values(tmp_path):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--presentation-build",
            str(paths["presentation"]),
            "--out",
            str(out),
        ],
        cwd=str(SCRIPT.parent),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0
    assert_no_fixture_values(result.stdout + result.stderr, paths)
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    # Confirm O_EXCL: second write refuses.
    again = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--presentation-build",
            str(paths["presentation"]),
            "--out",
            str(out),
        ],
        cwd=str(SCRIPT.parent),
        capture_output=True,
        text=True,
        check=False,
    )
    assert again.returncode == 1
    assert_no_fixture_values(again.stdout + again.stderr, paths)


def test_forced_enabled_false_even_when_pin_enabled_true(tmp_path):
    pin = write_pin(tmp_path / "pin.tf", receiver=_receiver(enabled=True))
    paths = helpers(tmp_path)
    payload = build_payload(
        core_pin=pin,
        auth_build=paths["auth"],
        audio_build=paths["audio"],
        presentation_build=paths["presentation"],
    )
    assert payload["receiver"]["enabled"] is False
    project(payload)


def test_output_file_not_world_readable(tmp_path):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    code, _paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 0
    mode = out.stat().st_mode
    assert mode & (stat.S_IRGRP | stat.S_IROTH | stat.S_IWGRP | stat.S_IWOTH) == 0
    assert os.access(out, os.R_OK)
