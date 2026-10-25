"""Execute the compiled helper's retired modes without opening an audio device."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


class InventoryOnly(unittest.TestCase):
    def test_compiled_session_observation_requires_correlated_os_identity(self):
        with tempfile.TemporaryDirectory(prefix="scribe-session-inventory-test-") as directory:
            root = Path(directory)
            executable = root / "session-observation"
            compiled = subprocess.run(["xcrun", "swiftc", "-D", "SCRIBE_LAB_SESSION_TESTS", "-parse-as-library",
                            "-module-cache-path", str(root / "cache"),
                            str(Path(__file__).with_name("audio.swift")),
                            str(Path(__file__).with_name("session-observation.test.swift")), "-o", str(executable)],
                           capture_output=True, text=True, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, check=True, timeout=5)
            self.assertEqual(json.loads(result.stdout), {"passed": True, "checks": 32, "nativeAudioOpened": False})

    def test_compiled_helper_rejects_mutating_modes_before_config_access(self):
        with tempfile.TemporaryDirectory(prefix="scribe-inventory-test-") as directory:
            root = Path(directory)
            executable = root / "audio"
            compiled = subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-module-cache-path", str(root / "cache"),
                            str(Path(__file__).with_name("audio.swift")), "-o", str(executable)],
                           capture_output=True, text=True, timeout=120)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            for mode in ("play", "probe", "unknown"):
                result = subprocess.run([str(executable), mode, str(root / "does-not-exist.json")],
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout),
                                 {"passed": False, "reason": "read-only-inventory-required"})


if __name__ == "__main__":
    unittest.main()
