"""Offline packaging regressions: inert helpers and synthetic configuration only."""

import argparse
import importlib.util
import json
import os
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from packaging_guard import (
    PRODUCTION_CORE,
    PRODUCTION_DEFINE,
    STAGING_CORE,
    UNLOCK_ENV,
    environment_marker,
    preflight_tree,
    refuse_live_payload,
    require_founder_unlock,
    require_store_application_auth_enabled,
    require_store_auth_enabled,
)
from prepare_production_profiles import prepare, project
from test_production_composition import profile_input
from test_provider_assembly import ASSEMBLER, production_fixture

COMPILE_ENV = (
    "SWIFTFLAGS",
    "OTHER_SWIFT_FLAGS",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS",
    "CFLAGS",
    "CPPFLAGS",
    "CXXFLAGS",
    "LDFLAGS",
)


@pytest.fixture(autouse=True)
def clean_packaging_environment(monkeypatch):
    for name in (*COMPILE_ENV, UNLOCK_ENV):
        monkeypatch.delenv(name, raising=False)


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ASSEMBLER.with_name(name))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def staging_fixture(tmp_path):
    module = load_script("assemble-standalone-provider.py")
    for name in ("desktop", "auth", "audio", "renderer"):
        (tmp_path / name).mkdir()
    for parent, executable in (
        ("auth", "ScribeDesktopProvider"),
        ("audio", "ScribeDesktopAudioHelper"),
        ("audio", "ScribeProviderPresentationHelper"),
    ):
        (tmp_path / parent / executable).write_text("synthetic inert helper")
    (tmp_path / "auth/ScribeDesktopProvider_ClerkKit.bundle").mkdir()
    profile = {
        "CFBundleIdentifier": "com.cosmaneura.scribe.beta",
        "CosmasNativeAuth": {
            "enabled": False,
            "frontendOrigin": "https://resolved-emu-53.clerk.accounts.dev",
            "publishableKey": "pk_test_synthetic",
        },
        "ScribeProviderReceiver": {"profile": "core-staging-https-v1"},
        "ScribeProviderApplication": {"enabled": False, "coreOrigin": STAGING_CORE},
    }
    path = tmp_path / "profile.plist"
    path.write_bytes(plistlib.dumps(profile))
    args = argparse.Namespace(
        output=tmp_path / "candidate",
        desktop_host=tmp_path / "desktop",
        auth_build=tmp_path / "auth",
        audio_build=tmp_path / "audio",
        ios_renderer=tmp_path / "renderer",
        ios_profile=path,
    )
    return module, args, profile


def cli_arguments(args):
    return [
        part
        for name in (
            "output",
            "desktop_host",
            "auth_build",
            "audio_build",
            "ios_renderer",
        )
        for part in ("--" + name.replace("_", "-"), str(getattr(args, name)))
    ]


def test_clean_staging_assembly_is_disabled_and_stamps_s(tmp_path):
    module, args, _profile = staging_fixture(tmp_path)
    original = args.ios_profile.read_bytes()
    module.assemble(args)
    desktop = json.loads((args.output / "desktop/provider-profile.json").read_bytes())
    ios = plistlib.loads((args.output / "ios/StandaloneBuildProfile.plist").read_bytes())
    assert desktop["coreOrigin"] == STAGING_CORE and desktop["enabled"] is False
    assert ios["CFBundleDisplayName"] == "Scribe S"
    assert ios["CosmasNativeAuth"]["frontendOrigin"].startswith("https://resolved-emu-53.")
    assert ios["CosmasNativeAuth"]["publishableKey"].startswith("pk_test_")
    assert ios["ScribeProviderReceiver"]["profile"] == "core-staging-https-v1"
    assert ios["ScribeProviderApplication"] == {"enabled": False, "uploadOrigins": []}
    assert args.ios_profile.read_bytes() == original


@pytest.mark.parametrize("binary", [False, True])
@pytest.mark.parametrize("poison", ["core", "clerk", "key"])
def test_staging_profile_live_markers_fail_before_output(tmp_path, poison, binary):
    module, args, profile = staging_fixture(tmp_path)
    if poison == "core":
        profile["ScribeProviderApplication"]["coreOrigin"] = PRODUCTION_CORE
    elif poison == "clerk":
        profile["CosmasNativeAuth"]["frontendOrigin"] = "https://clerk.cosmaneura.com"
    else:
        profile["CosmasNativeAuth"]["publishableKey"] = "pk_" + "live_synthetic-not-a-key"
    args.ios_profile.write_bytes(
        plistlib.dumps(
            profile,
            fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML,
        )
    )
    with pytest.raises(ValueError, match="Staging packaging refused") as error:
        module.assemble(args)
    assert "synthetic-not-a-key" not in str(error.value)
    assert not args.output.exists()


@pytest.mark.parametrize(
    "destination",
    [
        "desktop/profile.json",
        "renderer/Info.plist",
        "auth/ScribeDesktopProvider_ClerkKit.bundle/auth.json",
        "auth/build-inputs.json",
        "audio/build-inputs.json",
    ],
)
def test_copied_configuration_and_native_receipts_are_checked(tmp_path, destination):
    module, args, _profile = staging_fixture(tmp_path)
    path = tmp_path / destination
    payload = {"coreOrigin": PRODUCTION_CORE}
    if path.name == "build-inputs.json":
        payload = {"command": ["-Xswiftc", "-D", PRODUCTION_DEFINE]}
    path.write_bytes(
        plistlib.dumps(payload)
        if path.suffix == ".plist"
        else json.dumps(payload).replace("/", "\\/").encode()
    )
    with pytest.raises(ValueError, match="Staging packaging refused"):
        module.assemble(args)
    assert not args.output.exists()


def test_symlinked_copied_directory_cannot_hide_live_metadata(tmp_path):
    module, args, _profile = staging_fixture(tmp_path)
    linked = tmp_path / "synthetic-linked-resources"
    linked.mkdir()
    (linked / "auth.json").write_text(
        json.dumps(
            {
                "frontendOrigin": "https://clerk.cosmaneura.com",
            }
        )
    )
    (args.desktop_host / "resources").symlink_to(linked, target_is_directory=True)
    with pytest.raises(ValueError, match="Staging packaging refused"):
        module.assemble(args)
    assert not args.output.exists()


def test_symbolic_configuration_file_is_refused(tmp_path):
    source = tmp_path / "synthetic.json"
    source.write_text(json.dumps({"coreOrigin": STAGING_CORE}))
    linked = tmp_path / "linked.json"
    linked.symlink_to(source)
    with pytest.raises(ValueError, match="symbolic configuration"):
        preflight_tree(linked, "synthetic configuration")


def test_duplicate_plist_cannot_hide_an_escaped_live_marker(tmp_path):
    module, args, _profile = staging_fixture(tmp_path)
    source = args.ios_profile.read_text()
    source = source.replace(
        "<dict>",
        "<dict><key>overwritten</key><string>https:&#47;&#47;app.cosmaneura.com</string>"
        "<key>overwritten</key><string>synthetic-clean</string>",
        1,
    )
    args.ios_profile.write_text(source)
    assert plistlib.loads(source.encode())["overwritten"] == "synthetic-clean"
    with pytest.raises(ValueError, match="Staging packaging refused"):
        module.assemble(args)
    assert not args.output.exists()


def test_duplicate_json_cannot_hide_an_escaped_live_marker(tmp_path):
    path = tmp_path / "profile.json"
    path.write_text(
        '{"coreOrigin":"https:\\u002f\\u002fapp.cosmaneura.com",'
        '"coreOrigin":"https://staging-app.cosmaneura.com"}'
    )
    with pytest.raises(ValueError, match="duplicate configuration"):
        preflight_tree(path, "synthetic profile")


@pytest.mark.parametrize("variable", COMPILE_ENV)
def test_compile_environment_cannot_enable_production_in_staging(tmp_path, monkeypatch, variable):
    module, args, _profile = staging_fixture(tmp_path)
    monkeypatch.setenv(variable, "-D" + PRODUCTION_DEFINE)
    with pytest.raises(ValueError, match="production compile definition"):
        module.assemble(args)
    assert not args.output.exists()


@pytest.mark.parametrize(
    "payload",
    [
        {"production_organization_compiled": True},
        {"nested": [b"https://clerk.cosmaneura.com"]},
        {"command": ["-D", PRODUCTION_DEFINE]},
    ],
)
def test_payload_preflight_checks_nested_and_compiled_markers(payload):
    with pytest.raises(ValueError, match="Staging packaging refused"):
        refuse_live_payload(payload, "synthetic fixture")


@pytest.mark.parametrize("environment", [None, "0", "1"])
@pytest.mark.parametrize("deliberate", [False, True])
def test_founder_unlock_requires_both_latches(monkeypatch, environment, deliberate):
    if environment is not None:
        monkeypatch.setenv(UNLOCK_ENV, environment)
    if environment == "1" and deliberate:
        require_founder_unlock(deliberate)
    else:
        with pytest.raises(ValueError, match="Production packaging locked"):
            require_founder_unlock(deliberate)


def test_environment_marker_is_bound_to_exact_core_origin():
    assert environment_marker(STAGING_CORE) == "S"
    assert environment_marker(PRODUCTION_CORE) == "P"
    with pytest.raises(ValueError, match="approved Core origin"):
        environment_marker("https://unknown.invalid")


def test_ordinary_assembler_remains_locked_even_with_founder_latches(tmp_path, monkeypatch):
    module, args, _value, _build = production_fixture(tmp_path)
    monkeypatch.setenv(UNLOCK_ENV, "1")
    with pytest.raises(ValueError, match="founder-only assemble-production-provider.py"):
        module.assemble(args)
    assert not args.output.exists()


@pytest.mark.parametrize(
    "flag",
    [
        "production_inputs",
        "enable_production_clients",
        "production_native_build_receipt",
    ],
)
def test_each_production_option_is_locked_on_default_path(tmp_path, flag):
    module, args, _profile = staging_fixture(tmp_path)
    setattr(args, flag, True if flag == "enable_production_clients" else tmp_path / "missing.json")
    with pytest.raises(ValueError, match="Production packaging locked"):
        module.assemble(args)
    assert not args.output.exists()


def test_default_assembler_cannot_omit_staging_profile(tmp_path, monkeypatch):
    module, args, _profile = staging_fixture(tmp_path)
    args.ios_profile = None
    args.i_am_john_unlocking_production = True
    monkeypatch.setenv(UNLOCK_ENV, "1")
    with pytest.raises(ValueError, match="approved, disabled P1 iOS staging profile"):
        module.assemble(args)
    assert not args.output.exists()


@pytest.mark.parametrize("deliberate,environment", [(False, None), (True, None), (False, "1")])
def test_founder_assembler_locked_without_dual_latch(
    tmp_path,
    monkeypatch,
    deliberate,
    environment,
):
    module, args, _value, _build = production_fixture(tmp_path)
    args.i_am_john_unlocking_production = deliberate
    if environment:
        monkeypatch.setenv(UNLOCK_ENV, environment)
    with pytest.raises(ValueError, match="Production packaging locked"):
        module.assemble(args, production_entry=True)
    assert not args.output.exists()


@pytest.mark.parametrize("deliberate,environment", [(False, None), (True, None), (False, "1")])
def test_native_production_build_locked_before_output(
    tmp_path,
    monkeypatch,
    deliberate,
    environment,
):
    module = load_script("build-desktop-native-provider.py")
    output = tmp_path / "native-output"
    if environment:
        monkeypatch.setenv(UNLOCK_ENV, environment)
    with pytest.raises(ValueError, match="Production packaging locked"):
        module.build(
            output,
            tmp_path / "inert-auth",
            production_organization=True,
            i_am_john_unlocking_production=deliberate,
        )
    assert not output.exists()


def test_native_default_compile_environment_is_checked_before_output(tmp_path, monkeypatch):
    module = load_script("build-desktop-native-provider.py")
    output = tmp_path / "native-output"
    monkeypatch.setenv("OTHER_SWIFT_FLAGS", "-D" + PRODUCTION_DEFINE)
    with pytest.raises(ValueError, match="production compile definition"):
        module.build(output, tmp_path / "inert-auth")
    assert not output.exists()


@pytest.mark.parametrize("resource", ["vendor/Sources/ClerkKit", "Sources/CosmasNativeAuth"])
def test_native_default_resources_are_preflighted_before_output(tmp_path, resource):
    module = load_script("build-desktop-native-provider.py")
    native_auth = tmp_path / "synthetic-auth"
    resources = native_auth / resource
    resources.mkdir(parents=True)
    (resources / "Info.plist").write_bytes(plistlib.dumps({"coreOrigin": PRODUCTION_CORE}))
    output = tmp_path / "native-output"
    with pytest.raises(ValueError, match="Staging packaging refused"):
        module.build(output, native_auth)
    assert not output.exists()


@pytest.mark.parametrize("deliberate,environment", [(False, None), (True, None), (False, "1")])
def test_profile_preparation_locked_but_pure_projection_remains_available(
    tmp_path,
    monkeypatch,
    deliberate,
    environment,
):
    value = profile_input()
    assert project(value)["desktop"]["coreOrigin"] == PRODUCTION_CORE
    source = tmp_path / "synthetic-owner.json"
    source.write_text(json.dumps(value))
    output = tmp_path / "prepared"
    if environment:
        monkeypatch.setenv(UNLOCK_ENV, environment)
    with pytest.raises(ValueError, match="Production packaging locked"):
        prepare(source, output, i_am_john_unlocking_production=deliberate)
    assert not output.exists()


def test_cli_poisoned_staging_exits_nonzero_and_leaves_no_payload(tmp_path):
    _module, args, profile = staging_fixture(tmp_path)
    profile["CosmasNativeAuth"]["frontendOrigin"] = "https://clerk.cosmaneura.com"
    args.ios_profile.write_bytes(plistlib.dumps(profile))
    result = subprocess.run(
        [
            sys.executable,
            str(ASSEMBLER),
            *cli_arguments(args),
            "--ios-profile",
            str(args.ios_profile),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "Staging packaging refused: live Clerk marker in iOS profile" in result.stderr
    assert not args.output.exists()


def test_ordinary_cli_cannot_select_production_inputs(tmp_path):
    _module, args, _value, _build = production_fixture(tmp_path)
    result = subprocess.run(
        [
            sys.executable,
            str(ASSEMBLER),
            *cli_arguments(args),
            "--production-inputs",
            str(args.production_inputs),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0 and "Production packaging locked" in result.stderr
    assert not args.output.exists()


@pytest.mark.parametrize("deliberate,environment", [(False, None), (True, None), (False, "1")])
def test_founder_cli_missing_latch_fails_without_output(tmp_path, deliberate, environment):
    _module, args, _value, _build = production_fixture(tmp_path)
    command = [
        sys.executable,
        str(ASSEMBLER.with_name("assemble-production-provider.py")),
        *cli_arguments(args),
        "--production-inputs",
        str(args.production_inputs),
    ]
    if deliberate:
        command.append("--i-am-john-unlocking-production")
    env = {**os.environ}
    if environment:
        env[UNLOCK_ENV] = environment
    result = subprocess.run(command, env=env, capture_output=True, text=True, check=False)
    assert result.returncode != 0 and "Production packaging locked" in result.stderr
    assert not args.output.exists()


@pytest.mark.parametrize("poison", [None, "host", "electron", "native-receipt"])
def test_disabled_desktop_candidate_preflights_synthetic_verified_inputs(poison):
    module = load_script("assemble-disabled-desktop-candidate.py")
    with tempfile.TemporaryDirectory(prefix="scribe-disabled-guard-", dir="/private/tmp") as root:
        base = Path(root)
        runtime = base / "Electron.app"
        (runtime / "Contents/Resources").mkdir(parents=True)
        (runtime / "Contents/Info.plist").write_bytes(
            plistlib.dumps(
                {
                    "CFBundleShortVersionString": "44.9.1",
                }
            )
        )
        runtime_receipt = base / "runtime-receipt.json"
        runtime_receipt.write_text(
            json.dumps(
                {
                    "electron_version": "44.9.1",
                    "official_checksum_matches": True,
                    "archive_paths_validated": True,
                    "archive_sha256": "0" * 64,
                }
            )
        )
        host = base / "host"
        (host / "renderer").mkdir(parents=True)
        for name in ("provider-capture.js", "provider-capture.css"):
            (host / "renderer" / name).write_text("synthetic inert renderer")
        (host / "Scribe.icns").write_bytes(b"synthetic icon")
        (host / "package.json").write_text(json.dumps({"version": "1.0.0"}))
        (host / "release-metadata.json").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "displayName": "Cosmaneura Scribe for Mac",
                    "distribution": "Direct beta",
                    "marketingVersion": "1.0.0",
                    "build": "95",
                }
            )
        )
        (host / "host-build.json").write_text(
            json.dumps(
                {
                    "installed": False,
                    "signed": False,
                    "launch_ready": False,
                    "artifacts_sha256": {"Scribe.icns": module.digest(host / "Scribe.icns")},
                    "source_sha256": {"synthetic": "0" * 64},
                }
            )
        )
        auth, audio = base / "auth", base / "audio"
        auth.mkdir()
        audio.mkdir()
        for parent, executable in (
            (auth, "ScribeDesktopProvider"),
            (audio, "ScribeDesktopAudioHelper"),
            (audio, "ScribeProviderPresentationHelper"),
        ):
            (parent / executable).write_text("synthetic inert helper")
        (auth / "ScribeDesktopProvider_ClerkKit.bundle").mkdir()
        if poison in {"host", "electron"}:
            destination = host if poison == "host" else runtime / "Contents/Resources"
            (destination / "auth.json").write_text(json.dumps({"coreOrigin": PRODUCTION_CORE}))
        elif poison == "native-receipt":
            (auth / "build-inputs.json").write_text(
                json.dumps(
                    {
                        "production_organization_compiled": True,
                    }
                )
            )
        args = argparse.Namespace(
            output=base / "candidate",
            electron_app=runtime,
            runtime_receipt=runtime_receipt,
            desktop_host=host,
            auth_build=auth,
            audio_build=audio,
            expected_js_sha256=module.digest(host / "renderer/provider-capture.js"),
            expected_css_sha256=module.digest(host / "renderer/provider-capture.css"),
        )
        if poison:
            with pytest.raises(ValueError, match="Staging packaging refused"):
                module.assemble(args)
            assert not args.output.exists()
        else:
            module.assemble(args)
            app = args.output / "Cosmaneura Scribe for Mac.app"
            profile = json.loads((app / "Contents/Resources/app/provider-profile.json").read_text())
            assert profile["coreOrigin"] == STAGING_CORE and profile["enabled"] is False
            info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
            assert info["CFBundleDisplayName"].endswith(" S")


@pytest.mark.parametrize("poison", ["scaffold", "renderer", "compile", "native-plugin"])
def test_ios_candidate_preflight_runs_before_native_receipts(tmp_path, monkeypatch, poison):
    module = load_script("prepare-ios-provider-candidate.py")
    # Redirect only this loaded script to a complete synthetic scaffold root.
    repo = tmp_path / "synthetic-repo"
    scaffold = repo / "apps/capture/ios"
    scaffold.mkdir(parents=True)
    module.__file__ = str(repo / "scripts/prepare-ios-provider-candidate.py")
    renderer = tmp_path / "renderer"
    renderer.mkdir()
    native_source = tmp_path / "synthetic-native-source"
    if poison == "compile":
        monkeypatch.setenv("SWIFT_ACTIVE_COMPILATION_CONDITIONS", PRODUCTION_DEFINE)
    else:
        destination = scaffold if poison == "scaffold" else renderer
        if poison == "native-plugin":
            destination = native_source / "cosmas-native-auth"
            destination.mkdir(parents=True)
        (destination / "Info.plist").write_bytes(
            plistlib.dumps(
                {
                    "CosmasNativeAuth": {"frontendOrigin": "https://clerk.cosmaneura.com"},
                }
            )
        )
    output = tmp_path / "ios-candidate"
    with pytest.raises(ValueError, match="Staging packaging refused"):
        module.prepare(output, native_source, renderer)
    assert not output.exists()


@pytest.mark.parametrize("poison", ["compile", "manifest", "native-metadata"])
def test_store_workers_preflight_before_output_or_subprocess(tmp_path, monkeypatch, poison):
    module = load_script("build-desktop-mas-xpc-workers.py")
    repo = tmp_path / "synthetic-repo"
    audio = repo / "apps/desktop-companion/native/ScribeDesktopAudio"
    audio.mkdir(parents=True)
    native_auth = tmp_path / "synthetic-auth"
    native_auth.mkdir()
    module.__file__ = str(repo / "scripts/build-desktop-mas-xpc-workers.py")
    if poison == "compile":
        monkeypatch.setenv("OTHER_SWIFT_FLAGS", "-D" + PRODUCTION_DEFINE)
    elif poison == "manifest":
        (audio / "Package.swift").write_text('synthetic .define("' + PRODUCTION_DEFINE + '")')
    else:
        (native_auth / "Info.plist").write_bytes(plistlib.dumps({"coreOrigin": PRODUCTION_CORE}))

    def unexpected_build(*_args, **_kwargs):
        raise AssertionError("No native build subprocess may run in this synthetic preflight test")

    monkeypatch.setattr(module.subprocess, "run", unexpected_build)
    output = tmp_path / "store-workers"
    with pytest.raises(ValueError, match="Staging packaging refused"):
        module.build(output, native_auth)
    assert not output.exists()


def test_store_auth_enabled_guard_accepts_only_enabled_packages():
    profile = {
        "schema": 1,
        "enabled": True,
        "coreOrigin": STAGING_CORE,
        "uploadOrigins": ["https://synthblob01.blob.core.windows.net"],
    }
    auth = {"CosmasNativeAuth": {"enabled": True}}
    require_store_auth_enabled(profile, auth)
    for bad in (
        ({**profile, "enabled": False}, auth),
        (profile, {"CosmasNativeAuth": {"enabled": False}}),
        (profile, {}),
        ("not-a-dict", auth),
    ):
        with pytest.raises(ValueError, match="enabled=true"):
            require_store_auth_enabled(*bad)


def _store_app_fixture(tmp_path: Path, *, auth_layout: str, enabled: bool = True) -> Path:
    application = tmp_path / "Synthetic Store.app"
    resources = application / "Contents/Resources/app"
    resources.mkdir(parents=True)
    (resources / "provider-profile.json").write_text(
        json.dumps({
            "schema": 1,
            "enabled": True,
            "coreOrigin": STAGING_CORE,
            "uploadOrigins": ["https://synthblob01.blob.core.windows.net"],
        }) + "\n"
    )
    auth_plist = {"CosmasNativeAuth": {"enabled": enabled}}
    if auth_layout == "native":
        path = resources / "native/ScribeDesktopProvider.app/Contents/Info.plist"
    elif auth_layout == "xpc":
        path = application / "Contents/XPCServices/ScribeDesktopProvider.xpc/Contents/Info.plist"
    elif auth_layout == "both":
        native = resources / "native/ScribeDesktopProvider.app/Contents/Info.plist"
        xpc = application / "Contents/XPCServices/ScribeDesktopProvider.xpc/Contents/Info.plist"
        native.parent.mkdir(parents=True)
        xpc.parent.mkdir(parents=True)
        native.write_bytes(plistlib.dumps(auth_plist))
        xpc.write_bytes(plistlib.dumps(auth_plist))
        return application
    elif auth_layout == "missing":
        return application
    else:
        raise AssertionError(auth_layout)
    path.parent.mkdir(parents=True)
    path.write_bytes(plistlib.dumps(auth_plist))
    return application


@pytest.mark.parametrize("auth_layout", ["native", "xpc"])
def test_store_application_auth_guard_accepts_exact_layouts(tmp_path, auth_layout):
    require_store_application_auth_enabled(_store_app_fixture(tmp_path, auth_layout=auth_layout))


def test_store_application_auth_guard_refuses_disabled_auth(tmp_path):
    with pytest.raises(ValueError, match="enabled=true"):
        require_store_application_auth_enabled(
            _store_app_fixture(tmp_path, auth_layout="native", enabled=False)
        )


def test_store_application_auth_guard_refuses_missing_auth_plist(tmp_path):
    with pytest.raises(ValueError, match="CosmasNativeAuth Info.plist"):
        require_store_application_auth_enabled(_store_app_fixture(tmp_path, auth_layout="missing"))


def test_store_application_auth_guard_refuses_ambiguous_auth_plist(tmp_path):
    with pytest.raises(ValueError, match="ambiguous"):
        require_store_application_auth_enabled(_store_app_fixture(tmp_path, auth_layout="both"))
