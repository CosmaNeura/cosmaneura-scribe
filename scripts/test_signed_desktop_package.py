"""Regress the observed stale pin and dropped-claims packaging failures."""

import hashlib
import json
import plistlib
import struct
import tempfile
import unittest
from pathlib import Path

from check_signed_desktop_package import PROVIDER_CLAIMS, check_helper_pins, provider_claims


def signature(
    claims: dict[str, object] | None = None,
    *,
    pretty: bool = False,
    duplicate: bool = False,
    der: bool = True,
) -> bytes:
    entries: list[tuple[int, bytes]] = []
    if claims is not None:
        value = b"[Dict]\n\t[Key] keychain-access-groups\n" if pretty else plistlib.dumps(claims)
        entries.append((5, struct.pack(">II", 0xFADE7171, len(value) + 8) + value))
    if duplicate:
        entries.append(entries[0])
    if der:
        entries.append((7, struct.pack(">II", 0xFADE7172, 8)))
    offset = 12 + len(entries) * 8
    indexes, blobs = b"", b""
    for slot, blob in entries:
        indexes += struct.pack(">II", slot, offset)
        blobs += blob
        offset += len(blob)
    signed = struct.pack(">III", 0xFADE0CC0, offset, len(entries)) + indexes + blobs
    header = struct.pack("<8I", 0xFEEDFACF, 0, 0, 0, 1, 16, 0, 0)
    return header + struct.pack("<4I", 0x1D, 16, 48, len(signed)) + signed


class SignedDesktopPackageTests(unittest.TestCase):
    def test_exact_preexisting_claims(self) -> None:
        self.assertEqual(provider_claims(signature(PROVIDER_CLAIMS)), PROVIDER_CLAIMS)

    def test_dropped_claims_cannot_pass_as_empty(self) -> None:
        with self.assertRaises(ValueError):
            provider_claims(signature())

    def test_pretty_codesign_output_is_not_a_plist(self) -> None:
        with self.assertRaises(ValueError):
            provider_claims(signature(PROVIDER_CLAIMS, pretty=True))

    def test_extra_or_wrong_access_group_is_refused(self) -> None:
        for group in (
            ["other.app"],
            ["JVV65668U6.com.cosmaneura.scribe.beta.desktop.auth", "other.app"],
        ):
            with self.subTest(group=group), self.assertRaises(ValueError):
                provider_claims(signature({**PROVIDER_CLAIMS, "keychain-access-groups": group}))

    def test_truncated_duplicate_and_missing_der_claims_are_refused(self) -> None:
        for data in (
            signature(PROVIDER_CLAIMS)[:-1],
            signature(PROVIDER_CLAIMS, duplicate=True),
            signature(PROVIDER_CLAIMS, der=False),
        ):
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                provider_claims(data)

    def test_stale_signed_helper_pin(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = root / "helper"
            helper.write_bytes(b"qualified signed helper")
            helper.chmod(0o700)
            profile = {
                kind: {"path": "helper", "sha256": hashlib.sha256(helper.read_bytes()).hexdigest()}
                for kind in ("auth", "audio", "presentation")
            }
            (root / "provider-profile.json").write_text(json.dumps(profile))
            self.assertEqual(check_helper_pins(root), helper)
            helper.write_bytes(b"new qualified signed helper")
            with self.assertRaisesRegex(ValueError, "helper_pin_mismatch"):
                check_helper_pins(root)

    def test_pin_cannot_redirect_outside_reviewed_package(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for path in ("../helper", "/tmp/helper", "native//helper", "native\\helper"):
                (root / "provider-profile.json").write_text(
                    json.dumps({"auth": {"path": path, "sha256": "0" * 64}})
                )
                with self.subTest(path=path), self.assertRaises(ValueError):
                    check_helper_pins(root)


if __name__ == "__main__":
    unittest.main()
