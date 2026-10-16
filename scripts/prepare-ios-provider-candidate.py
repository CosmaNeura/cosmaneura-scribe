"""Prepare a disabled local iOS review source from explicit verified build inputs.

Copies first-party iOS scaffolding, current assembled native packages and a built
renderer into a new directory. Does not sign, install, launch or enable an account.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import plistlib
import shutil
from pathlib import Path, PurePosixPath


def prepare(output: Path, native_source: Path, renderer: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    receipt = json.loads((native_source / "source-manifest.json").read_text())
    for relative, expected in receipt["files"].items():
        reference = PurePosixPath(relative)
        if reference.is_absolute() or ".." in reference.parts or "\\" in relative:
            raise ValueError("Assembled native source path is invalid")
        path = native_source / relative
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("Assembled native source changed")
    if not (renderer / "index.html").is_file() or output.exists():
        raise ValueError("Built renderer and a new review output directory are required")
    output.mkdir(parents=True, mode=0o700)
    capture = output / "apps/capture"
    shutil.copytree(repo / "apps/capture/ios", capture / "ios",
                    ignore=shutil.ignore_patterns("xcuserdata", ".swiftpm", "Package.resolved"))
    plugins = capture / "native-plugins"
    for name in ("cosmas-native-auth", "ios-pcm-capture", "ios-pcm-capacitor", "native-recording", "secure-queue"):
        shutil.copytree(native_source / name, plugins / name)
    app = capture / "ios/App/App"
    shutil.copytree(renderer, app / "public")
    profile_path = app / "Info.plist"
    profile = plistlib.loads(profile_path.read_bytes())
    profile["CosmasNativeAuth"] = {"enabled": False}
    profile["ScribeProviderApplication"] = {"enabled": False, "uploadOrigins": []}
    profile_path.write_bytes(plistlib.dumps(profile, sort_keys=False))
    (app / "config.xml").write_text('<?xml version="1.0"?><widget id="com.cosmaneura.capture" version="1.0"/>\n')
    (app / "capacitor.config.json").write_text(json.dumps({
        "appId": "com.cosmaneura.capture", "appName": "Scribe", "webDir": "public", "loggingBehavior": "none",
        "packageClassList": ["SecureQueuePlugin", "CosmasWorkspaceAuthPlugin", "IOSPCMCapacitorPlugin"],
    }, indent=2) + "\n")
    package = capture / "ios/App/CapApp-SPM/Package.swift"
    source = package.read_text()
    dependency = '        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.1"),'
    product = '                .product(name: "Capacitor", package: "capacitor-swift-pm"),'
    if source.count(dependency) != 1 or source.count(product) != 1:
        raise ValueError("Capacitor source scaffold changed")
    source = source.replace(dependency, dependency + '\n'
        '        .package(name: "CosmasNativeAuthQualification", path: "../../../native-plugins/cosmas-native-auth"),\n'
        '        .package(name: "CosmaneuraIOSPCMCapacitor", path: "../../../native-plugins/ios-pcm-capacitor"),')
    source = source.replace(product, product + '\n'
        '                .product(name: "CosmasWorkspaceAuthPlugin", package: "CosmasNativeAuthQualification"),\n'
        '                .product(name: "CosmaneuraIOSPCMCapacitor", package: "CosmaneuraIOSPCMCapacitor"),')
    package.write_text(source)
    # Explicit native class references prevent linker stripping, and registration
    # uses the same native owners as the qualified provider bridge.
    delegate = app / "SceneDelegate.swift"
    source = delegate.read_text().replace("import Capacitor", "import Capacitor\nimport CosmasWorkspaceAuthPlugin\nimport CosmaneuraIOSPCMCapacitor")
    source = source.replace("CAPBridgeViewController()", "ScribeReviewBridgeViewController()")
    source += "\nclass ScribeReviewBridgeViewController: CAPBridgeViewController {\n"
    source += "  override func capacitorDidLoad() {\n"
    source += "    bridge?.registerPluginInstance(CosmasWorkspaceAuthPlugin())\n"
    source += "    bridge?.registerPluginInstance(IOSPCMCapacitorPlugin())\n  }\n}\n"
    delegate.write_text(source)
    files = {path.relative_to(output).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(output.rglob("*")) if path.is_file()}
    (output / "candidate-source.json").write_text(json.dumps({
        "schema": 1, "files_sha256": files, "bundle_identifier": "com.cosmaneura.capture",
        "enabled": False, "signed": False, "installed": False,
    }, indent=2) + "\n")
    print(json.dumps({"output": str(output), "files": len(files), "enabled": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--native-source", type=Path, required=True)
    parser.add_argument("--renderer", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.output.resolve(), args.native_source.resolve(), args.renderer.resolve())
