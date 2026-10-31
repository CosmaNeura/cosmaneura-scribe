"""Synthetic files only: native helpers are never executed or installed."""

import argparse
import importlib.util
import json
import plistlib
from pathlib import Path

import pytest
from test_production_composition import profile_input

ASSEMBLER = Path(__file__).resolve().parents[1] / "assemble-standalone-provider.py"


def production_fixture(tmp_path: Path, *, enabled=True):
    spec = importlib.util.spec_from_file_location("production_provider_assembly", ASSEMBLER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("desktop", "auth", "audio", "renderer"):
        (tmp_path / name).mkdir()
    value = profile_input()
    for role, executable in (
        ("auth", "ScribeDesktopProvider"),
        ("audio", "ScribeDesktopAudioHelper"),
        ("presentation", "ScribeProviderPresentationHelper"),
    ):
        source = tmp_path / ("auth" if role == "auth" else "audio") / executable
        source.write_text("synthetic inert " + role)
        value["desktop_helpers"][role] = {
            "path": "native/" + executable + ".app/Contents/MacOS/" + executable,
            "sha256": module.digest(source),
        }
    (tmp_path / "auth/ScribeDesktopProvider_ClerkKit.bundle").mkdir()
    inputs = tmp_path / "production.json"
    inputs.write_text(json.dumps(value))
    repo = ASSEMBLER.parents[1]
    native_paths = [
        "scripts/standalone-provider/DesktopProviderMain.swift",
        "scripts/standalone-provider/ProviderNativeTransport.swift",
        *[
            "apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth/" + name
            for name in ("NativeClerkConfiguration.swift", "NativeTokenPolicy.swift")
        ],
    ]
    build = {
        "production_organization_compiled": True,
        "command": ["xcrun", "swift", "build", "-Xswiftc", "-DSCRIBE_PRODUCTION_ORGANIZATION"],
        "source_sha256": {path: module.digest(repo / path) for path in native_paths},
    }
    build_path = tmp_path / "build-inputs.json"
    build_path.write_text(json.dumps(build))
    args = argparse.Namespace(
        output=tmp_path / "candidate",
        desktop_host=tmp_path / "desktop",
        auth_build=tmp_path / "auth",
        audio_build=tmp_path / "audio",
        ios_renderer=tmp_path / "renderer",
        ios_profile=None,
        production_inputs=inputs,
        production_native_build_receipt=build_path,
        enable_production_clients=enabled,
    )
    return module, args, value, build


@pytest.mark.parametrize("enabled", [False, True])
def test_production_assembly_binds_profiles_to_exact_native_helpers(tmp_path: Path, enabled):
    module, args, value, _build = production_fixture(tmp_path, enabled=enabled)
    original = args.production_inputs.read_bytes()
    module.assemble(args)
    ios = plistlib.loads((args.output / "ios/StandaloneBuildProfile.plist").read_bytes())
    desktop = json.loads((args.output / "desktop/provider-profile.json").read_bytes())
    auth = plistlib.loads(
        (args.output / "desktop/native/ScribeDesktopProvider.app/Contents/Info.plist").read_bytes()
    )
    receipt = json.loads((args.output / "assembly.json").read_bytes())
    assert ios["CosmasNativeAuth"]["enabled"] is enabled
    assert ios["ScribeProviderApplication"] == {
        "profile": "core-production-organization-v1",
        "enabled": enabled,
        "coreOrigin": "https://app.cosmaneura.com",
        "uploadOrigins": [value["client"]["upload_origin"]],
    }
    assert desktop["schema"] == 2 and desktop["enabled"] is enabled
    assert desktop["workspaceId"] == value["client"]["workspace_id"]
    assert auth["CosmasNativeAuth"] == ios["CosmasNativeAuth"]
    assert ios["ScribeProviderReceiver"] == auth["ScribeProviderReceiver"]
    for role in ("auth", "audio", "presentation"):
        helper = desktop[role]
        assert module.digest(args.output / "desktop" / helper["path"]) == helper["sha256"]
    assert receipt["enabled"] is enabled and receipt["production_qualified"] is False
    assert receipt["ios_production_compile_required"] is True
    assert receipt["installed"] is False and receipt["launched"] is False
    assert args.production_inputs.read_bytes() == original
    assert value["receiver"]["enabled"] is False


@pytest.mark.parametrize(
    "change", ["helper", "compile", "lab", "source", "receipt", "mixed", "active-receiver"]
)
def test_production_assembly_rejects_unbound_or_mixed_inputs_before_copy(tmp_path: Path, change):
    module, args, value, build = production_fixture(tmp_path)
    if change == "helper":
        value["desktop_helpers"]["auth"]["sha256"] = "0" * 64
    elif change == "compile":
        build["production_organization_compiled"] = False
    elif change == "lab":
        build["command"].append("-DSCRIBE_VIRTUAL_LAB_NETWORK")
    elif change == "source":
        build["source_sha256"]["scripts/standalone-provider/DesktopProviderMain.swift"] = "0" * 64
    elif change == "receipt":
        args.production_native_build_receipt = None
    elif change == "mixed":
        args.ios_profile = tmp_path / "staging-profile.plist"
    elif change == "active-receiver":
        value["receiver"]["enabled"] = True
    args.production_inputs.write_text(json.dumps(value))
    if args.production_native_build_receipt:
        args.production_native_build_receipt.write_text(json.dumps(build))
    with pytest.raises(ValueError):
        module.assemble(args)
    assert not args.output.exists()


@pytest.mark.parametrize("modes", [None, ["fetch"], ["audio", "fetch"]])
def test_audio_declaration_preserves_disabled_profile_and_identity(tmp_path: Path, modes):
    spec = importlib.util.spec_from_file_location("provider_assembly", ASSEMBLER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("desktop", "auth", "audio", "renderer"):
        (tmp_path / name).mkdir()
    for parent, executable in (
        ("auth", "ScribeDesktopProvider"),
        ("audio", "ScribeDesktopAudioHelper"),
        ("audio", "ScribeProviderPresentationHelper"),
    ):
        (tmp_path / parent / executable).write_text("synthetic inert fixture")
    (tmp_path / "auth/ScribeDesktopProvider_ClerkKit.bundle").mkdir()
    profile = {
        "CFBundleIdentifier": "com.cosmaneura.scribe.beta",
        "CosmasNativeAuth": {
            "enabled": False,
            "frontendOrigin": "https://resolved-emu-53.clerk.accounts.dev",
        },
        "ScribeProviderReceiver": {"profile": "core-staging-https-v1"},
    }
    if modes is not None:
        profile["UIBackgroundModes"] = modes
    original = plistlib.dumps(profile)
    (tmp_path / "profile.plist").write_bytes(original)
    args = argparse.Namespace(
        output=tmp_path / "candidate",
        desktop_host=tmp_path / "desktop",
        auth_build=tmp_path / "auth",
        audio_build=tmp_path / "audio",
        ios_renderer=tmp_path / "renderer",
        ios_profile=tmp_path / "profile.plist",
    )
    module.assemble(args)
    produced = plistlib.loads((args.output / "ios/StandaloneBuildProfile.plist").read_bytes())
    assert produced["UIBackgroundModes"] == sorted(set((modes or []) + ["audio"]))
    assert produced["CosmasNativeAuth"] == profile["CosmasNativeAuth"]
    assert produced["CFBundleIdentifier"] == profile["CFBundleIdentifier"]
    assert produced["ScribeProviderApplication"] == {"enabled": False, "uploadOrigins": []}
    assert json.loads((args.output / "assembly.json").read_text())["installed"] is False
    assert (tmp_path / "profile.plist").read_bytes() == original
    with pytest.raises(FileExistsError):
        module.assemble(args)


@pytest.mark.parametrize(
    "changed", ["ProviderNativeTransport.swift", "NativeProviderConnection.swift"]
)
def test_native_assembly_rejects_mobile_desktop_contract_drift(tmp_path: Path, changed):
    assembler = ASSEMBLER.with_name("assemble-native-source.py")
    spec = importlib.util.spec_from_file_location("native_assembly", assembler)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    repo = tmp_path / "repo"
    plugin = repo / "apps/capture/native-plugins/cosmas-native-auth"
    bridge = plugin / "Bridge"
    standalone = repo / "scripts/standalone-provider"
    bridge.mkdir(parents=True)
    standalone.mkdir(parents=True)
    clerk = tmp_path / "empty-synthetic-sdk"
    clerk.mkdir()
    (plugin / "clerk-source-lock.json").write_text('{"files": {}}')
    for name in ("ProviderNativeTransport.swift", "NativeProviderConnection.swift"):
        (bridge / name).write_text("synthetic mobile contract")
        (standalone / name).write_text("drift" if name == changed else "synthetic mobile contract")
    module.__file__ = str(repo / "scripts/assemble-native-source.py")
    output = tmp_path / "candidate"
    with pytest.raises(ValueError, match=changed):
        module.assemble(output, clerk)
    assert not output.exists()
