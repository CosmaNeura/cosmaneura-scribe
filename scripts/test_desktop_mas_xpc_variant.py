"""Pure claims/output rejection checks. No compiler, service or Apple tools."""

import hashlib
import importlib.util
import re
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
    def test_bridge_failure_diagnostics_have_only_closed_numeric_source_tokens(self):
        source = (ROOT.parent / "apps/desktop-companion/native/ScribeDesktopStoreBridge/StorePipeBridge.c").read_text()
        self.assertEqual(re.findall(r'"SCRIBE_STORE_BRIDGE:([^"\n]*)"', source),
                         [str(code) + r"\n" for code in range(1, 13)])
        diagnostic = source[source.index("static void bridge_diagnostic"):
                            source.index("static unsigned bridge_xpc_error_diagnostic")]
        self.assertIn("code > 0 && code < sizeof(markers) / sizeof(markers[0])", diagnostic)
        self.assertEqual(diagnostic.count("write(STDERR_FILENO, markers[code], strlen(markers[code]))"), 1)
        self.assertNotIn("STDOUT_FILENO", diagnostic)
        self.assertNotIn("fprintf", diagnostic)
        self.assertNotIn("xpc_copy_description", source)
        classification = source[source.index("static unsigned bridge_xpc_error_diagnostic"):
                                source.index("/* The inherited shim")]
        self.assertIn("if (error == XPC_ERROR_CONNECTION_INVALID) return 10;", classification)
        self.assertIn("if (error == XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT) return 11;", classification)
        self.assertIn("return 9;", classification)
        self.assertIn("bridge_diagnostic(bridge_xpc_error_diagnostic(event)); _exit(70);", source)
        self.assertIn("bridge_diagnostic(bridge_xpc_error_diagnostic(reply)); _exit(70);", source)
        self.assertIn("_exit(code >= 0 && code <= 255 ? (int)code : 70);", source)

    def test_bridge_diagnostics_preserve_exact_parent_authority_and_stop_source(self):
        source = (ROOT.parent / "apps/desktop-companion/native/ScribeDesktopStoreBridge/StorePipeBridge.c").read_text()
        parent = source[source.index("static bool parent_is_store_host"):source.index("\nint main")]
        cleanup = source[source.index("    xpc_release(message);"):]
        self.assertEqual(hashlib.sha256(parent.encode()).hexdigest(),
                         "1ddd3fb2218766e20607571f11782b9c09e7d2c8ea8a1afe7b19ebae2f77f57f")
        self.assertEqual(hashlib.sha256(cleanup.encode()).hexdigest(),
                         "5732f25fd801cc318489d567ce90f594596f7480534e0e807cafcc193306692b")

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
        self.assertEqual(XPC.GROUP, XPC.TEAM + "." + XPC.PARENT)
        self.assertNotEqual(XPC.GROUP, XPC.TEAM + "." + DIRECT.PARENT)
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
            expected = XPC.AUTH if role == "auth" else XPC.HELPER_BASE + "." + role
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

    def test_store_parent_namespace_does_not_rename_native_helpers(self):
        self.assertEqual(XPC.PARENT, "com.cosmaneura.scribe.beta.desktop.store")
        self.assertEqual(DIRECT.PARENT, "com.cosmaneura.scribe.beta.desktop")
        self.assertEqual(XPC.AUTH, "com.cosmaneura.scribe.beta.desktop.store.auth")
        claims = XPC.xpc_claims()
        self.assertEqual(claims["parent"]["com.apple.application-identifier"], XPC.GROUP)
        for role, bundle in (
            ("auth", XPC.AUTH),
            ("audio", "com.cosmaneura.scribe.beta.desktop.audio"),
            ("presentation", "com.cosmaneura.scribe.beta.desktop.presentation"),
        ):
            self.assertEqual(XPC.service_info(role)["CFBundleIdentifier"], bundle)
            self.assertEqual(claims["native-" + role]["com.apple.application-identifier"],
                             XPC.TEAM + "." + bundle)
            self.assertEqual(claims["native-" + role]["com.apple.security.application-groups"], [XPC.GROUP])

    def test_profile_authorization_requires_new_auth_and_permits_only_selected_group(self):
        exact = XPC.xpc_claims()["native-auth"]
        XPC.validate_auth_profile_authorization(exact)
        wildcard = dict(exact)
        wildcard["com.apple.security.application-groups"] = [
            "group.com.cosmaneura.scribe.beta.desktop.store.profile.authorization", XPC.TEAM + ".*"]
        wildcard["keychain-access-groups"] = [XPC.TEAM + ".*"]
        XPC.validate_auth_profile_authorization(wildcard)
        for key, value in (
            ("com.apple.application-identifier", XPC.TEAM + "." + DIRECT.PARENT + ".auth"),
            ("com.apple.developer.team-identifier", "OTHERTEAM"),
            ("keychain-access-groups", ["*"]),
            ("com.apple.security.application-groups", [XPC.TEAM + "." + DIRECT.PARENT]),
            ("com.apple.security.application-groups", ["group.com.cosmaneura.scribe.beta.desktop.store.profile.authorization"]),
        ):
            rejected = dict(wildcard); rejected[key] = value
            with self.assertRaises(ValueError):
                XPC.validate_auth_profile_authorization(rejected)


if __name__ == "__main__":
    unittest.main()
