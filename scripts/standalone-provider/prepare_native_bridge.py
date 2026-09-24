"""Prepare a separate native bridge source copy, never an installed app update.

The retained session owner is reused unchanged. No standalone bundle identity,
callback, Keychain profile, credential or endpoint is invented or activated.
"""

import argparse
import hashlib
import json
from pathlib import Path


def prepare(root: Path, native_auth: Path) -> None:
    destination = root / "provider-bridge"
    if destination.exists() or not root.is_dir():
        raise ValueError("New owned bridge directory required")
    bridge = native_auth / "Bridge"
    files = {p.name: p.read_bytes() for p in bridge.glob("*.swift")}
    source = files["CosmasWorkspaceAuthPlugin.swift"].decode()

    def registration(name: str) -> str:
        return f'        CAPPluginMethod(name: "{name}", returnType: CAPPluginReturnPromise),'

    # Do not expose the retained credential-returning or W13-only catalog methods
    # in the prepared provider bridge. Their native implementation remains intact.
    for name in ("getToken", "getWorkspaceCatalog"):
        marker = registration(name)
        if source.count(marker) != 1:
            raise ValueError("Qualified native bridge changed")
        source = source.replace(marker, "")
    observation = "        auth?.onChange = { [weak self] state in"
    replacements = {
        registration("signOut"): "\n".join(
            registration(name)
            for name in (
                "signOut",
                "getProviderState",
                "providerRequest",
                "cancelProviderRequest",
            )
        ),
        "    private var auth: NativeWorkspaceAuth?": "    private var auth: NativeWorkspaceAuth?\n"
        "    private var providerConnection: NativeProviderConnection?",
        observation: observation + "\n            self?.providerConnection?.authChanged(state)",
        "    @MainActor private static func payload": Path(__file__)
        .with_name("provider-methods.swift")
        .read_text()
        + "    @MainActor private static func payload",
    }
    for marker, replacement in replacements.items():
        if source.count(marker) != 1:
            raise ValueError("Qualified native bridge changed")
        source = source.replace(marker, replacement)
    source_hashes = {
        str(p.relative_to(native_auth)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((native_auth / "Sources").rglob("*.swift"))
    }
    root.chmod(0o700)
    destination.mkdir()
    for name, data in files.items():
        (destination / name).write_bytes(data)
    (destination / "CosmasWorkspaceAuthPlugin.swift").write_text(source)
    for name in ("NativeProviderConnection.swift", "ProviderNativeTransport.swift"):
        (destination / name).write_bytes(Path(__file__).with_name(name).read_bytes())
    (root / "native-provider-source-manifest.json").write_text(
        json.dumps(
            {
                "source_directory": str(native_auth),
                "unchanged_auth_sources": source_hashes,
                "input_bridge": {
                    name: hashlib.sha256(data).hexdigest() for name, data in files.items()
                },
                "prepared_bridge": {
                    p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sorted(destination.glob("*.swift"))
                },
                "registered_methods": [
                    "getState",
                    "signIn",
                "signOut",
                "getProviderState",
                "providerRequest",
                    "cancelProviderRequest",
                ],
                "app_identity_configured": False,
                "endpoint_configured": False,
                "app_built_or_installed": False,
                "auth_policy_changed": False,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--native-auth", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.root.resolve(), args.native_auth.resolve())
    print("Prepared native provider bridge source; auth inputs and installed apps unchanged.")
