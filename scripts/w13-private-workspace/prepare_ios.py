"""Compose a new W13 candidate, preserving all original native auth inputs."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import plistlib
import shutil
from pathlib import Path


def prepare(root: Path, retained: Path, build: int) -> None:
    if build < 3:
        raise ValueError("The observed token-request candidate requires build 3 or later")
    configuration = json.loads((root / "runtime.json").read_text())
    original = retained / "apps/capture"
    destination = root / "iphone-source/apps/capture"
    shutil.copytree(original, destination)
    bridge = destination / "native-plugins/cosmas-native-auth/Bridge"
    plugin = bridge / "CosmasWorkspaceAuthPlugin.swift"
    source = plugin.read_text()
    marker = 'CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),'
    assert source.count(marker) == 1
    source = source.replace(
        marker,
        marker
        + '\n        CAPPluginMethod(name: "getWorkspaceCatalog", '
        + "returnType: CAPPluginReturnPromise),",
    )
    marker = "    @MainActor private static func payload"
    assert source.count(marker) == 1
    source = source.replace(
        marker, Path(__file__).with_name("catalog-method.swift").read_text() + "\n" + marker
    )
    marker = "    private var auth: NativeWorkspaceAuth?"
    assert source.count(marker) == 1
    source = source.replace(
        marker, marker + "\n    private var observedDriver: W13ObservedAuthDriver?"
    )
    marker = "driver: { try ClerkKitWorkspaceDriver(configuration: configuration) },"
    assert source.count(marker) == 1
    source = source.replace(
        marker,
        "driver: {\n"
        "                        let driver = W13ObservedAuthDriver(\n"
        "                            base: try ClerkKitWorkspaceDriver("
        "configuration: configuration), policy: policy)\n"
        "                        self.observedDriver = driver\n"
        "                        return driver\n"
        "                    },",
    )
    plugin.write_text(source)
    shutil.copyfile(
        Path(__file__).with_name("W13PrivateTransport.swift"), bridge / "W13PrivateTransport.swift"
    )
    shutil.copyfile(
        Path(__file__).with_name("W13ObservedAuthDriver.swift"),
        bridge / "W13ObservedAuthDriver.swift",
    )
    info_path = destination / "ios/App/App/Info.plist"
    info = plistlib.loads(info_path.read_bytes())
    info["W13PrivateWorkspace"] = {
        "endpoint": configuration["api_origin"],
        "caDER": base64.b64encode((root / "tls/ca.der").read_bytes()).decode(),
        "leafSHA256": configuration["leaf_der_sha256"],
    }
    info["NSLocalNetworkUsageDescription"] = (
        "Connect to the private synthetic workspace on your Mac."
    )
    info_path.write_bytes(plistlib.dumps(info, sort_keys=False))
    # A new build identifier makes the replacement distinguishable on the phone.
    project = destination / "ios/App/App.xcodeproj/project.pbxproj"
    project.write_text(
        project.read_text().replace(
            "CURRENT_PROJECT_VERSION = 1;", f"CURRENT_PROJECT_VERSION = {build};"
        )
    )
    hashes = {}
    for path in sorted((original / "native-plugins/cosmas-native-auth/Sources").rglob("*.swift")):
        relative = path.relative_to(original)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert hashlib.sha256((destination / relative).read_bytes()).hexdigest() == digest
        hashes[str(relative)] = digest
    (root / "native-auth-preserved.json").write_text(json.dumps(hashes, indent=2) + "\n")
    print(f"Prepared W13 build {build} source; original native authentication files preserved.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--retained", type=Path, required=True)
    parser.add_argument("--build", type=int, required=True)
    args = parser.parse_args()
    prepare(args.root.resolve(), args.retained.resolve(), args.build)
