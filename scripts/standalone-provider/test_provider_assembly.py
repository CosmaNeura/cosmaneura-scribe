"""Synthetic files only: native helpers are never executed or installed."""

import argparse
import importlib.util
import json
import plistlib
from pathlib import Path

import pytest

ASSEMBLER = Path(__file__).resolve().parents[1] / "assemble-standalone-provider.py"


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
