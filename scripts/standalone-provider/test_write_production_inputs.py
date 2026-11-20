"""Synthetic fixtures only for write_production_inputs; no production values."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import prepare_production_profiles
import pytest
from prepare_production_profiles import project
from write_production_inputs import (
    _HELPER_EXECUTABLES,
    _HELPER_PATHS,
    _PUBLISHABLE_KEY_STOP,
    _STORE_BRIDGE_PATH,
    _STORE_DECLARATION_MAX_BYTES,
    _STORE_HASH_ALGORITHM,
    _VALIDATOR_PATH,
    Refuse,
    build_payload,
    desktop_helpers_from_builds,
    desktop_helpers_from_store_declaration,
    encode_publishable_key,
    main,
    validator_clerk_host_literal,
)

ASSEMBLER = Path(__file__).resolve().parents[1] / "assemble-standalone-provider.py"

SCRIPT = Path(__file__).resolve().with_name("write_production_inputs.py")

# Clearly synthetic — must never match live production ids/hashes/origins.
SYNTH_BOX = "10000000-0000-4000-8000-000000000002"
SYNTH_ENV = "10000000-0000-4000-8000-000000000001"
SYNTH_MI = "10000000-0000-4000-8000-000000000003"
SYNTH_SCOPE = "api://10000000-0000-4000-8000-000000000004/.default"
SYNTH_ORIGIN = "https://syntheticfixture.blob.core.windows.net"
SYNTH_RECEIVER_ORIGIN = "https://synthetic-fixture-production.example.azurecontainerapps.io"
SYNTH_INGRESS = "synthetic-fixture-receipt"
SYNTH_RECEIPT_A = "a" * 64
SYNTH_RECEIPT_B = "b" * 64
SYNTH_RECEIPT_C = "c" * 64
SYNTH_RECEIPT_D = "d" * 64
SYNTH_STORE_SHA256 = "e" * 64
DISALLOWED_WORKSPACE = "56f527ab-0caf-459b-bda9-cf7f0ca2f709"

FIXTURE_SECRETS = (
    SYNTH_BOX,
    SYNTH_ENV,
    SYNTH_MI,
    SYNTH_SCOPE,
    SYNTH_ORIGIN,
    SYNTH_RECEIVER_ORIGIN,
    SYNTH_INGRESS,
    SYNTH_RECEIPT_A,
    SYNTH_RECEIPT_B,
    SYNTH_RECEIPT_C,
    SYNTH_RECEIPT_D,
    SYNTH_STORE_SHA256,
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
        "ingress_isolation_receipt": SYNTH_INGRESS,
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
    origins_inner: str | None = None,
    duplicate_receiver: bool = False,
    receiver_rhs: str | None = None,
) -> Path:
    receiver = receiver or _receiver()
    if receiver_rhs is None:
        encoded = json.dumps(json.dumps(receiver, separators=(",", ":")))
        receiver_rhs = encoded
    if origins_inner is not None:
        origins_hcl = origins_inner
    else:
        origins = origins if origins is not None else [SYNTH_ORIGIN]
        origins_hcl = ", ".join(f'"{item}"' for item in origins)
    duplicate = ""
    if duplicate_receiver:
        duplicate = f"\n  receiver_configuration_json = {receiver_rhs}\n"
    text = f"""
locals {{
  production_live_scribe_native_production_rollout = {{
    capture_upload_origins = toset([{origins_hcl}])
  }}
  production_live_scribe_core_bundle = {{
    receiver_configuration_json = {receiver_rhs}
  }}
}}
{duplicate}
"""
    path.write_text(text)
    return path


def helpers(tmp_path: Path) -> dict[str, Path]:
    """Assemble-compatible auth/ and audio/ directories with helper executables."""
    auth = tmp_path / "auth"
    audio = tmp_path / "audio"
    auth.mkdir()
    audio.mkdir()
    for kind, executable in _HELPER_EXECUTABLES:
        directory = auth if kind == "auth" else audio
        (directory / executable).write_bytes(f"synthetic-inert-{kind}-fixture".encode())
    return {"auth": auth, "audio": audio}


def assemble_style_helpers(auth_build: Path, audio_build: Path) -> dict[str, dict[str, str]]:
    """Build desktop_helpers the same way assemble-standalone-provider.assemble does."""
    built: dict[str, dict[str, str]] = {}
    for kind, executable in _HELPER_EXECUTABLES:
        source = (auth_build if kind == "auth" else audio_build) / executable
        assert source.is_file() and not source.is_symlink()
        built[kind] = {
            "path": "native/" + executable + ".app/Contents/MacOS/" + executable,
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        }
    return built


def fixture_digests(paths: dict[str, Path]) -> set[str]:
    digests: set[str] = set()
    for directory in paths.values():
        if not directory.is_dir():
            continue
        for child in directory.iterdir():
            if child.is_file() and not child.is_symlink():
                digests.add(hashlib.sha256(child.read_bytes()).hexdigest())
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
        "--out",
        str(out),
        *(extra or []),
    ]
    code = main(argv)
    return code, paths


def test_validator_path_matches_imported_module():
    assert Path(prepare_production_profiles.__file__).resolve() == _VALIDATOR_PATH


def test_happy_path_passes_validator_and_mode_0600(tmp_path, capsys):
    pin_receiver = _receiver(enabled=True)
    pin = write_pin(tmp_path / "synthetic_pin.tf", receiver=pin_receiver)
    out = tmp_path / "production-inputs.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 0
    payload = json.loads(out.read_text())
    project(payload)
    assert payload["schema"] == 1
    expected_receiver = {**pin_receiver, "enabled": False}
    assert payload["receiver"] == expected_receiver
    assert payload["client"]["workspace_id"] == SYNTH_BOX
    assert payload["client"]["upload_origin"] == SYNTH_ORIGIN
    assert payload["client"]["publishable_key"] == encode_publishable_key(
        validator_clerk_host_literal()
    )
    assert payload["desktop_helpers"] == assemble_style_helpers(paths["auth"], paths["audio"])
    assert payload["desktop_helpers"] == desktop_helpers_from_builds(paths["auth"], paths["audio"])
    for role, relative in _HELPER_PATHS.items():
        assert payload["desktop_helpers"][role]["path"] == relative
    mode = stat.S_IMODE(out.stat().st_mode)
    assert mode == 0o600
    captured = capsys.readouterr()
    combined = captured.out + captured.err
    assert "output: " + str(out) in captured.out
    assert "schema: present" in captured.out
    assert "client.publishable_key: present" in captured.out
    assert_no_fixture_values(combined, paths)
    assert "{" not in captured.out and "}" not in captured.out
    assert out.read_text() not in combined
    assert "diff" not in combined.lower()


def test_desktop_helpers_match_assemble_binding(tmp_path):
    pin = write_pin(tmp_path / "pin.tf")
    paths = helpers(tmp_path)
    payload = build_payload(
        core_pin=pin, auth_build=paths["auth"], audio_build=paths["audio"]
    )
    assert payload["desktop_helpers"] == assemble_style_helpers(paths["auth"], paths["audio"])


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
    assert out.exists()
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
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_profile_mismatch_names_only(tmp_path, capsys):
    pin = write_pin(
        tmp_path / "org.tf",
        receiver=_receiver(profile="core-production-organization-v1"),
    )
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:receiver.profile:mismatch" in captured.err
    assert "expect_profile:" not in captured.err
    assert "pin_profile:" not in captured.err
    assert "core-production-organization-v1" not in captured.err
    assert SYNTH_BOX not in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_organization_pin_refuses_even_when_expect_profile_matches(tmp_path, capsys):
    pin = write_pin(
        tmp_path / "org.tf",
        receiver=_receiver(profile="core-production-organization-v1"),
    )
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    # Direct call: expect_profile matches the pin label; personal-only gate still refuses.
    try:
        build_payload(
            core_pin=pin,
            auth_build=paths["auth"],
            audio_build=paths["audio"],
            expect_profile="core-production-organization-v1",
        )
        raised = False
    except Refuse as exc:
        assert str(exc) == "receiver.profile:mismatch"
        raised = True
    assert raised
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--out",
            str(out),
            "--expect-profile",
            "core-production-personal-v1",
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:receiver.profile:mismatch" in captured.err
    assert not out.exists()
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
    captured = capsys.readouterr()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_expect_profile_rejects_organization_choice(tmp_path):
    pin = write_pin(tmp_path / "personal.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    try:
        main(
            [
                "--core-pin",
                str(pin),
                "--auth-build",
                str(paths["auth"]),
                "--audio-build",
                str(paths["audio"]),
                "--out",
                str(out),
                "--expect-profile",
                "core-production-organization-v1",
            ]
        )
        raised = False
    except SystemExit as exc:
        assert exc.code == 2
        raised = True
    assert raised
    assert not out.exists()


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
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_zero_upload_origins(tmp_path, capsys):
    pin = write_pin(tmp_path / "empty.tf", origins_inner="")
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:capture_upload_origins:count" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_origin_literal_plus_reference(tmp_path, capsys):
    pin = write_pin(
        tmp_path / "mixed.tf",
        origins_inner=f'"{SYNTH_ORIGIN}", var.synthetic_fixture_origin',
    )
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:capture_upload_origins:count" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_bad_origin_count(tmp_path, capsys):
    pin = write_pin(
        tmp_path / "origins.tf",
        origins=[SYNTH_ORIGIN, "https://otherfixture.blob.core.windows.net"],
    )
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:capture_upload_origins:count" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_non_https_origin(tmp_path, capsys):
    pin = write_pin(tmp_path / "http.tf", origins=["http://syntheticfixture.blob.core.windows.net"])
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:capture_upload_origins:not_https" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_missing_helper(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    (paths["audio"] / "ScribeDesktopAudioHelper").unlink()
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:helper:" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_symlinked_helper(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    target = tmp_path / "elsewhere-audio"
    target.write_bytes(b"synthetic-inert-symlink-target")
    helper = paths["audio"] / "ScribeDesktopAudioHelper"
    helper.unlink()
    helper.symlink_to(target)
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:helper:" in captured.err
    assert not out.exists()
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


def test_refuse_interpolation_dollar_in_receiver_json(tmp_path, capsys):
    receiver = _receiver()
    text = json.dumps(receiver, separators=(",", ":"))
    text = text.replace(SYNTH_BOX, "${var.synthetic_box_id}")
    pin = write_pin(tmp_path / "interp_dollar.tf", receiver_rhs=json.dumps(text))
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:receiver_configuration_json:interpolation" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_interpolation_percent_in_receiver_json(tmp_path, capsys):
    receiver = _receiver()
    text = json.dumps(receiver, separators=(",", ":"))
    text = text.replace(SYNTH_BOX, "%{synthetic_box_id}")
    pin = write_pin(tmp_path / "interp_percent.tf", receiver_rhs=json.dumps(text))
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:receiver_configuration_json:interpolation" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_duplicate_keys_in_receiver_json(tmp_path, capsys):
    # Hand-built JSON object text with a duplicate top-level key.
    inner = (
        '{"schema":1,"schema":1,"enabled":true,"profile":"core-production-personal-v1",'
        f'"authority_backend":"core-provider-context-v1","beta_box_id":"{SYNTH_BOX}",'
        f'"environment_id":"{SYNTH_ENV}","managed_identity_client_id":"{SYNTH_MI}",'
        f'"core_scope":"{SYNTH_SCOPE}","ingress_isolation_receipt":"{SYNTH_INGRESS}",'
        '"platforms":["ios","desktop"],"database_host":null,"database_name":null,'
        '"database_reader_role":null,"desktop_native_session_without_origin":false,'
        '"encounter_creation_enabled":true,"native_visit_actions_v2_enabled":true,'
        '"production":{'
        '"audience":null,"organization_id":null,'
        '"core_origin":"https://app.cosmaneura.com",'
        '"issuer":"https://clerk.cosmaneura.com",'
        f'"receiver_origin":"{SYNTH_RECEIVER_ORIGIN}",'
        f'"deployment_receipt_sha256":"{SYNTH_RECEIPT_A}",'
        f'"session_claims_receipt_sha256":"{SYNTH_RECEIPT_D}",'
        f'"native_policy_receipt_sha256":"{SYNTH_RECEIPT_B}",'
        f'"protected_data_receipt_sha256":"{SYNTH_RECEIPT_C}"'
        "}}"
    )
    pin = write_pin(tmp_path / "dupkeys.tf", receiver_rhs=json.dumps(inner))
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:receiver_configuration_json:malformed" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_jsonencode_receiver(tmp_path, capsys):
    pin = write_pin(
        tmp_path / "jsonencode.tf",
        receiver_rhs="jsonencode({ profile = \"core-production-personal-v1\" })",
    )
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:receiver_configuration_json:jsonencode_unsupported" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_missing_beta_box_id(tmp_path, capsys):
    receiver = _receiver()
    del receiver["beta_box_id"]
    pin = write_pin(tmp_path / "nobox.tf", receiver=receiver)
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:client.workspace_id:missing" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_validator_failure(tmp_path, capsys):
    receiver = _receiver()
    receiver["production"]["native_policy_receipt_sha256"] = "G" * 64
    pin = write_pin(tmp_path / "badreceipt.tf", receiver=receiver)
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:validator:failure" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_symlink_pin(tmp_path, capsys):
    real = write_pin(tmp_path / "real.tf")
    pin = tmp_path / "link.tf"
    pin.symlink_to(real)
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:core_pin:missing" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_missing_pin(tmp_path, capsys):
    pin = tmp_path / "absent.tf"
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:core_pin:missing" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_non_utf8_pin(tmp_path, capsys):
    pin = tmp_path / "binary.tf"
    pin.write_bytes(b"\xff\xfe receiver_configuration_json = \"bad\"\n")
    out = tmp_path / "out.json"
    code, paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:core_pin:encoding" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_core_pin_oserror(tmp_path, capsys, monkeypatch):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    pin_resolved = pin.resolve()
    original = Path.read_text

    def _selective(self, *args, **kwargs):
        if self.resolve() == pin_resolved:
            raise OSError("synthetic-fixture-oserror")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", _selective)
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:core_pin:unreadable" in captured.err
    assert "synthetic-fixture-oserror" not in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_write_unlinks_partial_output_on_failure(tmp_path, monkeypatch):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    payload = build_payload(
        core_pin=pin, auth_build=paths["auth"], audio_build=paths["audio"]
    )

    real_fdopen = os.fdopen

    def _failing_fdopen(fd, mode="r", *args, **kwargs):
        handle = real_fdopen(fd, mode, *args, **kwargs)

        def _fail(_data):
            raise OSError("synthetic-write-failure")

        handle.write = _fail  # type: ignore[method-assign]
        return handle

    monkeypatch.setattr(os, "fdopen", _failing_fdopen)
    from write_production_inputs import Refuse, write_payload

    try:
        write_payload(payload, out)
        raised = False
    except Refuse as exc:
        assert str(exc) == "output:unwritable"
        raised = True
    assert raised
    assert not out.exists()


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
    pin_receiver = _receiver(enabled=True)
    pin = write_pin(tmp_path / "pin.tf", receiver=pin_receiver)
    paths = helpers(tmp_path)
    payload = build_payload(
        core_pin=pin, auth_build=paths["auth"], audio_build=paths["audio"]
    )
    assert payload["receiver"] == {**pin_receiver, "enabled": False}
    project(payload)


def test_output_file_not_world_readable(tmp_path):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    code, _paths = run_writer(tmp_path, pin=pin, out=out)
    assert code == 0
    mode = out.stat().st_mode
    assert mode & (stat.S_IRGRP | stat.S_IROTH | stat.S_IWGRP | stat.S_IWOTH) == 0
    assert os.access(out, os.R_OK)


# --- Store bridge declaration mode (MAS XPC) ---


def store_declaration(
    path: Path,
    *,
    body: dict | None = None,
    text: str | None = None,
) -> Path:
    if text is not None:
        path.write_text(text)
    else:
        declaration = body or {
            "path": _STORE_BRIDGE_PATH,
            "sha256": SYNTH_STORE_SHA256,
            "hashAlgorithm": _STORE_HASH_ALGORITHM,
        }
        path.write_text(json.dumps(declaration) + "\n")
    return path


def run_store_writer(
    tmp_path: Path,
    *,
    pin: Path,
    out: Path,
    declaration: Path | None = None,
    extra: list[str] | None = None,
):
    declaration = declaration or store_declaration(tmp_path / "bridge-declaration.json")
    argv = [
        "--core-pin",
        str(pin),
        "--store-bridge-declaration",
        str(declaration),
        "--out",
        str(out),
        *(extra or []),
    ]
    code = main(argv)
    return code, declaration


def test_store_mode_happy_path_all_three_keys_equal_and_mode_0600(tmp_path, capsys):
    pin_receiver = _receiver(enabled=True)
    pin = write_pin(tmp_path / "synthetic_pin.tf", receiver=pin_receiver)
    out = tmp_path / "production-inputs.json"
    declaration = store_declaration(tmp_path / "bridge-declaration.json")
    expected = {
        "path": _STORE_BRIDGE_PATH,
        "sha256": SYNTH_STORE_SHA256,
        "hashAlgorithm": _STORE_HASH_ALGORITHM,
    }
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 0
    payload = json.loads(out.read_text())
    projected = project(payload)
    assert payload["desktop_helpers"] == {
        "auth": expected,
        "audio": expected,
        "presentation": expected,
    }
    assert payload["desktop_helpers"] == desktop_helpers_from_store_declaration(declaration)
    for role in ("auth", "audio", "presentation"):
        assert projected["desktop"][role] == expected
        assert projected["desktop"][role]["path"] == _STORE_BRIDGE_PATH
        assert projected["desktop"][role]["hashAlgorithm"] == _STORE_HASH_ALGORITHM
    assert projected["desktop"]["auth"] == projected["desktop"]["audio"]
    assert projected["desktop"]["audio"] == projected["desktop"]["presentation"]
    mode = stat.S_IMODE(out.stat().st_mode)
    assert mode == 0o600
    captured = capsys.readouterr()
    assert_no_fixture_values(captured.out + captured.err, {})
    again = main(
        [
            "--core-pin",
            str(pin),
            "--store-bridge-declaration",
            str(declaration),
            "--out",
            str(out),
        ]
    )
    assert again == 1
    second = capsys.readouterr()
    assert "refuse:output:exists" in second.err
    assert_no_fixture_values(second.out + second.err, {})


def test_store_mode_prepare_projects_store_bridge_into_desktop_profile(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("SCRIBE_FOUNDER_PRODUCTION_UNLOCK", "1")
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "production-inputs.json"
    declaration = store_declaration(tmp_path / "bridge-declaration.json")
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 0
    profiles_out = tmp_path / "profiles"
    prepare_production_profiles.prepare(
        out, profiles_out, i_am_john_unlocking_production=True
    )
    desktop = json.loads((profiles_out / "desktop-profile.json").read_text())
    expected = {
        "path": _STORE_BRIDGE_PATH,
        "sha256": SYNTH_STORE_SHA256,
        "hashAlgorithm": _STORE_HASH_ALGORITHM,
    }
    for role in ("auth", "audio", "presentation"):
        assert desktop[role] == expected


def test_refuse_both_modes(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    declaration = store_declaration(tmp_path / "bridge-declaration.json")
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--audio-build",
            str(paths["audio"]),
            "--store-bridge-declaration",
            str(declaration),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:mode:exclusive" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_neither_mode(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    code = main(["--core-pin", str(pin), "--out", str(out)])
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:mode:required" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_incomplete_build_mode(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:mode:incomplete" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_store_declaration_symlink(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    real = store_declaration(tmp_path / "real-declaration.json")
    linked = tmp_path / "linked-declaration.json"
    linked.symlink_to(real)
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=linked)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:missing" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_missing(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    declaration = tmp_path / "absent-declaration.json"
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:missing" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_malformed_json(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    declaration = store_declaration(
        tmp_path / "bad.json", text="{not-json"
    )
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:malformed" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_duplicate_keys(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    text = (
        '{"path":"Contents/MacOS/ScribeStorePipeBridge",'
        f'"sha256":"{SYNTH_STORE_SHA256}",'
        '"hashAlgorithm":"macho-store-v1",'
        '"path":"Contents/MacOS/ScribeStorePipeBridge"}'
    )
    declaration = store_declaration(tmp_path / "dup.json", text=text)
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:duplicate_keys" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_extra_keys(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    declaration = store_declaration(
        tmp_path / "extra.json",
        body={
            "path": _STORE_BRIDGE_PATH,
            "sha256": SYNTH_STORE_SHA256,
            "hashAlgorithm": _STORE_HASH_ALGORITHM,
            "extra": "nope",
        },
    )
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:keys" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_missing_key(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    declaration = store_declaration(
        tmp_path / "missing.json",
        body={"path": _STORE_BRIDGE_PATH, "sha256": SYNTH_STORE_SHA256},
    )
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:keys" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_wrong_path(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    declaration = store_declaration(
        tmp_path / "wrong-path.json",
        body={
            "path": "native/ScribeDesktopProvider.app/Contents/MacOS/ScribeDesktopProvider",
            "sha256": SYNTH_STORE_SHA256,
            "hashAlgorithm": _STORE_HASH_ALGORITHM,
        },
    )
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:path" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_wrong_algorithm(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    declaration = store_declaration(
        tmp_path / "wrong-algo.json",
        body={
            "path": _STORE_BRIDGE_PATH,
            "sha256": SYNTH_STORE_SHA256,
            "hashAlgorithm": "sha256",
        },
    )
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:hashAlgorithm" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_bad_sha256(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    for bad in ("E" * 64, "e" * 63, "e" * 65, "g" * 64, "not-hex"):
        declaration = store_declaration(
            tmp_path / "bad-sha.json",
            body={
                "path": _STORE_BRIDGE_PATH,
                "sha256": bad,
                "hashAlgorithm": _STORE_HASH_ALGORITHM,
            },
        )
        if out.exists():
            out.unlink()
        code, _decl = run_store_writer(
            tmp_path, pin=pin, out=out, declaration=declaration
        )
        assert code == 1
        captured = capsys.readouterr()
        assert "refuse:store_bridge_declaration:sha256" in captured.err
        assert not out.exists()
        assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_non_object(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    declaration = store_declaration(
        tmp_path / "array.json", text=json.dumps([_STORE_BRIDGE_PATH]) + "\n"
    )
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:malformed" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_store_mode_output_refused_by_assembler_production_profiles(tmp_path):
    """Store-mode JSON must not pass Direct Beta production_profiles equality."""
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "store-production-inputs.json"
    declaration = store_declaration(tmp_path / "bridge-declaration.json")
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 0

    spec = importlib.util.spec_from_file_location("assemble_standalone_provider", ASSEMBLER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    auth = tmp_path / "auth"
    audio = tmp_path / "audio"
    auth.mkdir()
    audio.mkdir()
    for kind, executable in _HELPER_EXECUTABLES:
        directory = auth if kind == "auth" else audio
        (directory / executable).write_bytes(f"synthetic-inert-{kind}-fixture".encode())
    helpers = {
        kind: {
            "path": "native/" + executable + ".app/Contents/MacOS/" + executable,
            "sha256": module.digest(
                (auth if kind == "auth" else audio) / executable
            ),
        }
        for kind, executable in _HELPER_EXECUTABLES
    }
    repo = ASSEMBLER.parents[1]
    native_paths = [
        "scripts/standalone-provider/DesktopProviderMain.swift",
        "scripts/standalone-provider/ProviderNativeTransport.swift",
        *[
            "apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/" + name
            for name in ("NativeClerkConfiguration.swift", "NativeTokenPolicy.swift")
        ],
    ]
    receipt = tmp_path / "build-inputs.json"
    receipt.write_text(
        json.dumps(
            {
                "production_organization_compiled": True,
                "command": [
                    "xcrun",
                    "swift",
                    "build",
                    "-Xswiftc",
                    "-DSCRIBE_PRODUCTION_ORGANIZATION",
                ],
                "source_sha256": {
                    path: module.digest(repo / path) for path in native_paths
                },
            }
        )
    )
    args = argparse.Namespace(
        production_inputs=out,
        production_native_build_receipt=receipt,
        enable_production_clients=False,
        ios_profile=None,
    )
    with pytest.raises(ValueError, match=r"^store_declaration_not_accepted_by_assembler$"):
        module.production_profiles(args, helpers)


def test_refuse_store_mode_with_only_auth_build(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    declaration = store_declaration(tmp_path / "bridge-declaration.json")
    code = main(
        [
            "--core-pin",
            str(pin),
            "--auth-build",
            str(paths["auth"]),
            "--store-bridge-declaration",
            str(declaration),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:mode:exclusive" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_store_mode_with_only_audio_build(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    paths = helpers(tmp_path)
    declaration = store_declaration(tmp_path / "bridge-declaration.json")
    code = main(
        [
            "--core-pin",
            str(pin),
            "--audio-build",
            str(paths["audio"]),
            "--store-bridge-declaration",
            str(declaration),
            "--out",
            str(out),
        ]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:mode:exclusive" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, paths)


def test_refuse_store_declaration_sha256_trailing_newline(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    declaration = store_declaration(
        tmp_path / "newline-sha.json",
        body={
            "path": _STORE_BRIDGE_PATH,
            "sha256": SYNTH_STORE_SHA256 + "\n",
            "hashAlgorithm": _STORE_HASH_ALGORITHM,
        },
    )
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:sha256" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_non_string_sha256(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    text = (
        '{"path":"Contents/MacOS/ScribeStorePipeBridge",'
        '"sha256":1,'
        '"hashAlgorithm":"macho-store-v1"}'
    )
    declaration = store_declaration(tmp_path / "num-sha.json", text=text)
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:sha256" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})


def test_refuse_store_declaration_too_large(tmp_path, capsys):
    pin = write_pin(tmp_path / "pin.tf")
    out = tmp_path / "out.json"
    padding = "x" * (_STORE_DECLARATION_MAX_BYTES + 1)
    text = (
        '{"path":"Contents/MacOS/ScribeStorePipeBridge",'
        f'"sha256":"{SYNTH_STORE_SHA256}",'
        '"hashAlgorithm":"macho-store-v1",'
        f'"pad":"{padding}"' + "}"
    )
    assert len(text.encode()) > _STORE_DECLARATION_MAX_BYTES
    declaration = store_declaration(tmp_path / "large.json", text=text)
    code, _decl = run_store_writer(tmp_path, pin=pin, out=out, declaration=declaration)
    assert code == 1
    captured = capsys.readouterr()
    assert "refuse:store_bridge_declaration:too_large" in captured.err
    assert not out.exists()
    assert_no_fixture_values(captured.out + captured.err, {})
