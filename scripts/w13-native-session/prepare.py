"""Prepare an unactivated W13 native-session correction for owner review.

Copies owned inputs only. Does not install, launch, start a server or change Clerk.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import shutil
from pathlib import Path


def replace_once(source: str, old: str, new: str) -> str:
    if source.count(old) != 1:
        raise ValueError("Unrecognized reviewed source")
    return source.replace(old, new)


def native_observation(source: str) -> str:
    source = replace_once(
        source,
        "try policy.validate(token, identity: identity);",
        "try policy.validate(token, identity: identity, nativeSessionWithoutOrigin: true);",
    )
    return replace_once(
        source,
        'if claims["azp"] == nil || claims["azp"] is NSNull { return "app_binding_missing" }',
        'if claims["azp"] == nil || claims["azp"] is NSNull { return "policy_rejected" }',
    )


def prepare(root: Path, candidate: Path, runtime: Path) -> None:
    root.mkdir(mode=0o700, exist_ok=True)
    if any(root.iterdir()):
        raise ValueError("Preparation requires a new empty owned directory")
    manifest = json.loads((candidate / "candidate-manifest.json").read_text())
    if manifest["build"] != "3" or manifest["bundle"] != "com.cosmasos.synthetic.w13":
        raise ValueError("Requires the verified W13 build 3")
    for name, digest in manifest["files_sha256"].items():
        if hashlib.sha256((candidate / name).read_bytes()).hexdigest() != digest:
            raise ValueError("Candidate input changed")
    configuration = json.loads((runtime / "runtime.json").read_text())
    for name, digest in configuration["source_sha256"].items():
        if (
            hashlib.sha256((runtime / "server-source/cosmas_os" / name).read_bytes()).hexdigest()
            != digest
        ):
            raise ValueError("Frozen receiver input changed")
    shutil.copytree(candidate / "iphone-source", root / "iphone-source")
    shutil.copytree(runtime / "server-source", root / "server-source")
    (root / "tls").mkdir()
    shutil.copyfile(runtime / "tls/ca.der", root / "tls/ca.der")
    review = []

    def change(path: Path, revised: str) -> None:
        original = path.read_text()
        relative = path.relative_to(root)
        review.append(
            {
                "path": str(relative),
                "before_sha256": hashlib.sha256(original.encode()).hexdigest(),
                "after_sha256": hashlib.sha256(revised.encode()).hexdigest(),
            }
        )
        diff = "".join(
            difflib.unified_diff(
                original.splitlines(True),
                revised.splitlines(True),
                fromfile="before/" + str(relative),
                tofile="candidate/" + str(relative),
            )
        )
        with (root / "review.diff").open("a") as output:
            output.write(diff)
        path.write_text(revised)

    sources = (
        root
        / "iphone-source/apps/capture/native-plugins/cosmas-native-auth/Sources/CosmasNativeAuth"
    )
    path = sources / "NativeTokenPolicy.swift"
    source = replace_once(
        path.read_text(),
        "public func validate(_ token: String, identity: NativeAuthIdentity, "
        "now: Date = Date()) throws {",
        "public func validate(_ token: String, identity: NativeAuthIdentity, now: Date = Date(),\n"
        "                         nativeSessionWithoutOrigin: Bool = false) throws {\n"
        "        guard !nativeSessionWithoutOrigin || "
        "authorizedParty == NativeWorkspaceOrigin.appleWebView.rawValue\n"
        "        else { throw NativeAuthError.tokenUnavailable }",
    )
    source = replace_once(
        source,
        'claims["iss"] as? String == issuer, claims["azp"] as? String == authorizedParty,',
        'claims["iss"] as? String == issuer,\n'
        '              (claims["azp"] as? String == authorizedParty ||\n'
        '               (nativeSessionWithoutOrigin && claims["azp"] == nil)),',
    )
    change(path, source)
    path = sources / "NativeWorkspaceAuth.swift"
    source = replace_once(
        path.read_text(),
        "public func token(expectedRevision: String) async throws -> String {",
        "public func token(expectedRevision: String, "
        "nativeSessionWithoutOrigin: Bool = false) async throws -> String {",
    )
    source = replace_once(
        source,
        "try tokenPolicy.validate(token, identity: expected)",
        "try tokenPolicy.validate(token, identity: expected, "
        "nativeSessionWithoutOrigin: nativeSessionWithoutOrigin)",
    )
    change(path, source)
    path = sources.parent.parent / "Bridge/CosmasWorkspaceAuthPlugin.swift"
    source = replace_once(
        path.read_text(),
        "do { token = try await auth.token(expectedRevision: revision) }",
        "do { token = try await auth.token(expectedRevision: revision, "
        "nativeSessionWithoutOrigin: true) }",
    )
    # Only the pinned catalog operation opts in. The legacy renderer token getter stays strict.
    change(path, source)
    path = sources.parent.parent / "Bridge/W13ObservedAuthDriver.swift"
    # Observe the candidate's actual native profile so a different failure is
    # not mislabelled as the now-permitted absent browser-origin claim.
    change(path, native_observation(path.read_text()))
    path = root / "iphone-source/apps/capture/ios/App/App.xcodeproj/project.pbxproj"
    source = path.read_text()
    if source.count("CURRENT_PROJECT_VERSION = 3;") != 2:
        raise ValueError("Unexpected W13 build settings")
    change(path, source.replace("CURRENT_PROJECT_VERSION = 3;", "CURRENT_PROJECT_VERSION = 4;"))

    path = root / "server-source/cosmas_os/api/auth.py"
    source = replace_once(
        path.read_text(),
        "        start_background_refresh: bool = True,\n    ) -> None:\n",
        "        start_background_refresh: bool = True,\n"
        "        allow_native_session_without_origin: bool = False,\n    ) -> None:\n"
        "        if allow_native_session_without_origin and "
        "set(runtime_settings.authorized_parties) != {\n"
        '            "capacitor://localhost"\n'
        "        }:\n"
        '            raise RuntimeError("Native session profile requires '
        'the isolated iOS origin")\n'
        "        self._allow_native_session_without_origin = allow_native_session_without_origin\n",
    )
    source = replace_once(
        source,
        '"require": ["exp", "iat", "nbf", "iss", "sub", "sid", "azp"],',
        '"require": ["exp", "iat", "nbf", "iss", "sub", "sid"]\n'
        '                + ([] if self._allow_native_session_without_origin else ["azp"]),',
    )
    source = replace_once(
        source,
        "        if not isinstance(authorized_party, str) or authorized_party not in {\n"
        "            *self._settings.authorized_parties\n        }:",
        "        absent_native_origin = self._allow_native_session_without_origin "
        'and "azp" not in claims\n'
        "        if not absent_native_origin and (\n"
        "            not isinstance(authorized_party, str)\n"
        "            or authorized_party not in {*self._settings.authorized_parties}\n"
        "        ):",
    )
    change(path, source)
    configuration["source_sha256"]["api/auth.py"] = hashlib.sha256(path.read_bytes()).hexdigest()
    configuration["existing_runtime_root"] = str(runtime)
    configuration["native_token_profile"] = "w13-ios-native-session-v1"
    (root / "runtime.json").write_text(json.dumps(configuration, indent=2) + "\n")
    server = (runtime / "server.py").read_text()
    server = replace_once(
        server,
        'CONFIG = json.loads((ROOT / "runtime.json").read_text())',
        'CONFIG = json.loads((ROOT / "runtime.json").read_text())\n'
        'if CONFIG.get("native_token_profile") != "w13-ios-native-session-v1":\n'
        '    raise RuntimeError("Explicit native session profile required")\n'
        'DATA_ROOT = Path(CONFIG["existing_runtime_root"])',
    )
    server = server.replace('"capacitor://localhost,app://cosmas"', '"capacitor://localhost"')
    server = server.replace(
        '{"capacitor://localhost", "app://cosmas"}', '{"capacitor://localhost"}'
    )
    server = replace_once(
        server,
        "workspace_desktop_local_transport_enabled=True",
        "workspace_desktop_local_transport_enabled=False",
    )
    server = replace_once(server, 'str(ROOT / "socket")', 'str(DATA_ROOT / "socket")')
    server = replace_once(
        server,
        "verifier = ClerkTokenVerifier(settings)",
        "verifier = ClerkTokenVerifier(settings, allow_native_session_without_origin=True)",
    )
    server = replace_once(
        server, 'str(ROOT / "tls/server-key.pem")', 'str(DATA_ROOT / "tls/server-key.pem")'
    )
    server = replace_once(
        server, 'str(ROOT / "tls/server.pem")', 'str(DATA_ROOT / "tls/server.pem")'
    )
    (root / "server.py").write_text((runtime / "server.py").read_text())
    change(root / "server.py", server)
    (root / "change-review.json").write_text(
        json.dumps(
            {
                "status": "prepared_not_activated",
                "installed": False,
                "receiver_started": False,
                "scope": "W13 pinned iPhone catalog call and private iOS-only catalog receiver",
                "base_candidate": str(candidate),
                "existing_runtime": str(runtime),
                "changes": review,
            },
            indent=2,
        )
        + "\n"
    )
    print("Prepared build 4 and iOS-only receiver; neither installed nor activated.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.root.resolve(), args.candidate.resolve(), args.runtime.resolve())
