"""Pure claims/output rejection checks. No compiler, service or Apple tools."""

import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


XPC = module("xpc_variant", "prepare-desktop-mas-xpc-variant.py")
BUILD = module("xpc_workers", "build-desktop-mas-xpc-workers.py")
DIRECT = module("dormant_variant", "prepare-desktop-mas-variant.py")
AUTH_BUILD = module("native_auth_build", "build-desktop-native-provider.py")


class XpcVariantTests(unittest.TestCase):
    def test_auth_build_retains_recovery_without_old_credential_admission(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            auth = base / "auth"
            for relative in (
                "Sources/CosmasNativeAuth/Stub.swift",
                "vendor/Sources/ClerkKit/Stub.swift",
                "Bridge/W13PrivateTransport.swift",
            ):
                file = auth / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("// pure builder fixture\n")
            for xpc in (False, True):
                output = base / str(xpc)
                with patch.object(AUTH_BUILD.subprocess, "run") as compiler:
                    AUTH_BUILD.build(output, auth, mac_app_store_xpc=xpc)
                compiler.assert_called_once()
                packaged = output / (
                    "package/Sources/ScribeDesktopProvider/DesktopStoreClerkAdmission.swift"
                )
                self.assertFalse(packaged.exists())
                recovery = output / "package/Sources/ScribeDesktopProvider/NativeSourceRecovery.swift"
                source = ROOT / "standalone-provider/NativeSourceRecovery.swift"
                self.assertEqual(hashlib.sha256(recovery.read_bytes()).hexdigest(),
                                 hashlib.sha256(source.read_bytes()).hexdigest())
                flags = compiler.call_args.args[0]
                self.assertEqual("-DSCRIBE_MAC_APP_STORE_XPC" in flags, xpc)

    def test_fence_group_cannot_grant_shared_keychain_or_file_exceptions(self):
        claims = XPC.xpc_claims()
        self.assertTrue(XPC.GROUP.startswith(XPC.TEAM + "."))
        self.assertFalse(XPC.GROUP.startswith("group."))
        for role, value in claims.items():
            self.assertFalse(any("temporary-exception" in key or ".files." in key for key in value))
            if role != "native-auth":
                self.assertNotIn("keychain-access-groups", value)
        self.assertEqual(claims["native-auth"]["keychain-access-groups"], [XPC.TEAM + "." + XPC.AUTH])
        self.assertNotEqual(claims["native-auth"]["keychain-access-groups"],
                            DIRECT.draft_claims()["native-auth"]["keychain-access-groups"])
        self.assertNotEqual(XPC.GROUP, XPC.TEAM + "." + XPC.PARENT)
        self.assertNotIn("com.apple.security.device.audio-input", claims["native-auth"])

    def test_spawned_bridge_has_only_inherited_sandbox(self):
        self.assertEqual(
            XPC.xpc_claims()["inherited-child"],
            {"com.apple.security.app-sandbox": True, "com.apple.security.inherit": True},
        )
        self.assertNotIn("com.apple.security.device.audio-input", XPC.xpc_claims()["parent"])

    def test_independent_services_join_user_session_and_use_cocoa_runloop(self):
        for role in ["auth", "audio", "presentation"]:
            info = XPC.service_info(role)
            expected = XPC.AUTH if role == "auth" else XPC.PARENT + "." + role
            self.assertEqual(info["CFBundleIdentifier"], expected)
            self.assertEqual(info["CFBundlePackageType"], "XPC!")
            self.assertEqual(
                info["XPCService"],
                {
                    "ServiceType": "Application",
                    "RunLoopType": "NSRunLoop",
                    "JoinExistingSession": True,
                },
            )
            self.assertNotIn("ProgramArguments", info)
            self.assertNotIn("EnvironmentVariables", info)

    def test_existing_native_build_output_is_preserved_before_compiler(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "prior"
            output.mkdir()
            marker = output / "receipt.json"
            marker.write_text("retained")
            with self.assertRaises(FileExistsError):
                BUILD.build(output, Path(tmp) / "absent-auth")
            self.assertEqual(marker.read_text(), "retained")

    def test_original_dormant_group_stays_unapproved(self):
        self.assertEqual(DIRECT.APP_GROUP_TOKEN, "UNAPPROVED_APP_GROUP_NOT_SIGNABLE")
        self.assertNotEqual(
            DIRECT.draft_claims()["parent"]["com.apple.security.application-groups"], [XPC.GROUP]
        )

    def test_profile_authorization_requires_new_auth_and_permits_only_selected_group(self):
        exact = XPC.xpc_claims()["native-auth"]
        XPC.validate_auth_profile_authorization(exact)
        wildcard = dict(exact)
        wildcard["com.apple.security.application-groups"] = [
            "group.com.cosmaneura.scribe.beta.desktop.store.profile.authorization", XPC.TEAM + ".*"]
        wildcard["keychain-access-groups"] = [XPC.TEAM + ".*"]
        XPC.validate_auth_profile_authorization(wildcard)
        for key, value in (
            ("com.apple.application-identifier", XPC.TEAM + "." + XPC.PARENT + ".auth"),
            ("com.apple.developer.team-identifier", "OTHERTEAM"),
            ("keychain-access-groups", ["*"]),
            ("com.apple.security.application-groups", [XPC.TEAM + "." + XPC.PARENT]),
            ("com.apple.security.application-groups", ["group.com.cosmaneura.scribe.beta.desktop.store.profile.authorization"]),
        ):
            rejected = dict(wildcard); rejected[key] = value
            with self.assertRaises(ValueError):
                XPC.validate_auth_profile_authorization(rejected)


if __name__ == "__main__":
    unittest.main()
