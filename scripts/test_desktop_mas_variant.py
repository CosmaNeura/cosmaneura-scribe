"""Pure rejection checks for the dormant store build boundary; no Apple tools."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from check_signed_desktop_package import HOST_CLAIMS, PROVIDER_CLAIMS, signed_claims
from test_signed_desktop_package import signature

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("mas_variant", HERE / "prepare-desktop-mas-variant.py")
assert SPEC is not None and SPEC.loader is not None
MAS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MAS)


class DesktopMasVariantTests(unittest.TestCase):
    def test_draft_store_claims_cannot_pass_the_existing_direct_distribution_checker(self):
        for name, expected in (("parent", HOST_CLAIMS), ("native-auth", PROVIDER_CLAIMS)):
            with self.subTest(name=name), self.assertRaises(ValueError):
                signed_claims(signature(MAS.draft_claims()[name]), expected)

    def test_native_credentials_remain_exclusively_in_the_existing_auth_group(self):
        claims = MAS.draft_claims()
        self.assertEqual(claims["native-auth"]["keychain-access-groups"], PROVIDER_CLAIMS["keychain-access-groups"])
        for name, value in claims.items():
            if name != "native-auth":
                self.assertNotIn("keychain-access-groups", value)
            self.assertFalse(any("temporary-exception" in key or ".files." in key for key in value))
        self.assertEqual(claims["electron-child"], {"com.apple.security.app-sandbox": True, "com.apple.security.inherit": True})

    def test_changed_or_missing_clerk_dependency_cannot_create_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); vendor = root / "vendor"; vendor.mkdir(); (vendor / "wrong.swift").write_text("// synthetic")
            output = root / "output"
            with self.assertRaises(ValueError):
                MAS.prepare(output, vendor)
            self.assertFalse(output.exists())

    def test_existing_output_is_preserved_before_dependency_inspection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); output = root / "output"; output.mkdir(); marker = output / "prior.json"
            marker.write_text(json.dumps({"preserved": True}))
            with self.assertRaises(ValueError):
                MAS.prepare(output, root / "absent-vendor")
            self.assertEqual(json.loads(marker.read_text()), {"preserved": True})


if __name__ == "__main__":
    unittest.main()
