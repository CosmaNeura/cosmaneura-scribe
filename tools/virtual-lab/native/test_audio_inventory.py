"""Execute the compiled helper's retired modes without opening an audio device."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


class InventoryOnly(unittest.TestCase):
    def test_compiled_helper_rejects_mutating_modes_before_config_access(self):
        with tempfile.TemporaryDirectory(prefix="scribe-inventory-test-") as directory:
            root = Path(directory)
            executable = root / "audio"
            subprocess.run(["xcrun", "swiftc", "-module-cache-path", str(root / "cache"),
                            str(Path(__file__).with_name("audio.swift")), "-o", str(executable)],
                           check=True, capture_output=True, timeout=120)
            for mode in ("play", "probe", "unknown"):
                result = subprocess.run([str(executable), mode, str(root / "does-not-exist.json")],
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout),
                                 {"passed": False, "reason": "read-only-inventory-required"})


if __name__ == "__main__":
    unittest.main()
