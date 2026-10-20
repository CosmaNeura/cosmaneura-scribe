"""Owned dummy-file placement tests; no compiler, signing, app or XPC actions."""

import hashlib
import importlib.util
import stat
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "store_bridge_placement",
    Path(__file__).resolve().parent / "prepare-desktop-mas-xpc-variant.py",
)
XPC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(XPC)


class StoreBridgePlacementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="scribe-bridge-placement-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.application = self.root / "Synthetic.app"
        self.macos = self.application / "Contents/MacOS"
        self.macos.mkdir(parents=True)
        self.source = self.root / "unsigned-bridge"
        self.payload = b"synthetic unsigned bridge bytes; never executed\n"
        self.source.write_bytes(self.payload)
        self.source.chmod(0o600)
        self.target = self.macos / "ScribeStorePipeBridge"
        self.old = self.application / "Contents/Resources/app/native/ScribeStorePipeBridge"

    def test_actual_placement_returns_fixed_declaration_matching_bytes_and_mode(self):
        declaration = XPC.place_store_bridge(self.application, self.source)
        self.assertEqual(declaration, {
            "path": "Contents/MacOS/ScribeStorePipeBridge",
            "sha256": hashlib.sha256(self.payload).hexdigest(),
        })
        self.assertEqual(self.target.relative_to(self.application).as_posix(), declaration["path"])
        self.assertEqual(self.target.read_bytes(), self.payload)
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o755)
        self.assertEqual(self.source.read_bytes(), self.payload)
        self.assertEqual(stat.S_IMODE(self.source.stat().st_mode), 0o600)
        self.assertFalse(self.old.exists())

    def test_existing_target_is_never_overwritten(self):
        self.target.write_bytes(b"previous synthetic target")
        with self.assertRaises(FileExistsError):
            XPC.place_store_bridge(self.application, self.source)
        self.assertEqual(self.target.read_bytes(), b"previous synthetic target")

    def test_target_symlink_does_not_modify_its_destination(self):
        destination = self.root / "untouched"
        destination.write_bytes(b"untouched synthetic bytes")
        self.target.symlink_to(destination)
        with self.assertRaises(FileExistsError):
            XPC.place_store_bridge(self.application, self.source)
        self.assertEqual(destination.read_bytes(), b"untouched synthetic bytes")
        self.assertTrue(self.target.is_symlink())

    def test_stale_resource_copy_is_refused_before_new_write(self):
        self.old.parent.mkdir(parents=True)
        self.old.write_bytes(b"old synthetic resource bridge")
        with self.assertRaises(ValueError):
            XPC.place_store_bridge(self.application, self.source)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.old.read_bytes(), b"old synthetic resource bridge")

    def test_dangling_stale_resource_link_is_also_refused(self):
        self.old.parent.mkdir(parents=True)
        self.old.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            XPC.place_store_bridge(self.application, self.source)
        self.assertFalse(self.target.exists())
        self.assertTrue(self.old.is_symlink())

    def test_source_alias_is_refused_without_reading_or_writing_target(self):
        alias = self.root / "source-alias"
        alias.symlink_to(self.source)
        with self.assertRaises(ValueError):
            XPC.place_store_bridge(self.application, alias)
        self.assertFalse(self.target.exists())

    def test_linked_macos_directory_is_refused(self):
        self.macos.rmdir()
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        self.macos.symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(ValueError):
            XPC.place_store_bridge(self.application, self.source)
        self.assertFalse((elsewhere / "ScribeStorePipeBridge").exists())

    def test_noncanonical_app_alias_is_refused(self):
        alias = self.root / "Alias.app"
        alias.symlink_to(self.application, target_is_directory=True)
        with self.assertRaises(ValueError):
            XPC.place_store_bridge(alias, self.source)
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
