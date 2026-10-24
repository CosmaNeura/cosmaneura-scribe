"""Regression checks use invented unit waveforms, never claim actual speech proof."""

import importlib.util
import json
import math
import struct
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "fixture_evaluator", Path(__file__).with_name("evaluate.py")
)
assert SPEC and SPEC.loader
EVALUATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVALUATOR)
TONE = b"".join(struct.pack("<h", round(4000 * math.sin(i / 10))) for i in range(8000))


def write_wave(path, pcm, parameters=(1, 2, 16000)):
    with wave.open(str(path), "wb") as wav:
        wav.setparams((*parameters, 0, "NONE", "not compressed"))
        wav.writeframes(pcm)


class AudioFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "generated"

    def fake_say(self, pcm):
        def run(args, **_kwargs):
            # The consent record must exist before even this invented processor.
            consent = json.loads((self.output / "consent.json").read_text())
            self.assertTrue(consent["all_parties_consented"])
            write_wave(Path(args[args.index("-o") + 1]), pcm)
            return subprocess.CompletedProcess(args, 0)

        return run

    def generate_unit_waveform(self):
        with patch.object(EVALUATOR.subprocess, "run", side_effect=self.fake_say(TONE)):
            report = EVALUATOR.fixtures(self.output)
        self.assertEqual(report["status"], "synthetic_audio_generated")
        self.assertEqual(len(report["turn_audio"]), 6)
        self.assertTrue(
            all(
                turn["duration_ms"] == 500 and turn["rms_pcm16"] > 0
                for turn in report["turn_audio"]
            )
        )
        return EVALUATOR.load_manifest(self.output / "manifest.json")

    def rewrite_manifest(self, manifest, file):
        manifest["files"][file] = EVALUATOR.digest((self.output / file).read_bytes())
        (self.output / "manifest.json").write_text(json.dumps(manifest))

    def test_exit_zero_empty_say_fails_without_publishing_manifest(self):
        with patch.object(EVALUATOR.subprocess, "run", side_effect=self.fake_say(b"")):
            with self.assertRaises(AssertionError):
                EVALUATOR.fixtures(self.output)
        self.assertFalse((self.output / "manifest.json").exists())

    def test_exit_zero_silent_say_fails_without_publishing_manifest(self):
        with patch.object(EVALUATOR.subprocess, "run", side_effect=self.fake_say(bytes(64000))):
            with self.assertRaises(AssertionError):
                EVALUATOR.fixtures(self.output)
        self.assertFalse((self.output / "manifest.json").exists())

    def test_unit_waveform_and_exact_frames_validate(self):
        manifest = self.generate_unit_waveform()
        self.assertTrue(
            all(item["end_frame"] > item["start_frame"] for item in manifest["timeline"])
        )

    def test_silent_visit_rejected_even_with_updated_digest(self):
        manifest = self.generate_unit_waveform()
        pcm, _ = EVALUATOR.read_wave(self.output / "visit.wav", speech=True)
        write_wave(self.output / "visit.wav", bytes(len(pcm)))
        self.rewrite_manifest(manifest, "visit.wav")
        with self.assertRaises(AssertionError):
            EVALUATOR.load_manifest(self.output / "manifest.json")

    def test_invalid_wave_format_rejected_even_with_updated_digest(self):
        manifest = self.generate_unit_waveform()
        for parameters in [(1, 2, 8000), (2, 2, 16000), (1, 1, 16000)]:
            with self.subTest(parameters=parameters):
                write_wave(self.output / "visit.wav", TONE, parameters)
                self.rewrite_manifest(manifest, "visit.wav")
                with self.assertRaises(AssertionError):
                    EVALUATOR.load_manifest(self.output / "manifest.json")

    def test_empty_or_audible_silence_control_rejected(self):
        manifest = self.generate_unit_waveform()
        for pcm in [b"", TONE * 4]:
            with self.subTest(frames=len(pcm) // 2):
                write_wave(self.output / "silence.wav", pcm)
                self.rewrite_manifest(manifest, "silence.wav")
                with self.assertRaises(AssertionError):
                    EVALUATOR.load_manifest(self.output / "manifest.json")

    def test_empty_speech_interval_rejected(self):
        manifest = self.generate_unit_waveform()
        manifest["timeline"][0]["end_frame"] = 0
        (self.output / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(AssertionError):
            EVALUATOR.load_manifest(self.output / "manifest.json")

    def test_truncated_pcm_rejected_even_with_updated_digest(self):
        manifest = self.generate_unit_waveform()
        path = self.output / "visit.wav"
        path.write_bytes(path.read_bytes()[:50])
        self.rewrite_manifest(manifest, "visit.wav")
        with self.assertRaises(AssertionError):
            EVALUATOR.load_manifest(self.output / "manifest.json")


if __name__ == "__main__":
    unittest.main()
