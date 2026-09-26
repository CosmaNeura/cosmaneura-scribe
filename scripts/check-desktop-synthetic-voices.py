"""Generate two consented fictional voices and check the native meeting mixer.

Reuses macOS speech synthesis and the existing native test target. No playback,
microphone, camera, screen capture, meeting, account or network client is opened.
This validates native speech preservation, not live Zoom/Chrome capture.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path


def check(output: Path) -> None:
    repo = Path(__file__).resolve().parents[1]
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    consent: dict[str, object] = {
        "schema": 1,
        "generator": "macos-say-synthetic-v1",
        "synthetic_only": True,
        "all_parties_consented": True,
        "files": {},
    }
    # Record synthetic consent before any audio is generated or processed.
    manifest = output / "synthetic-consent.json"
    manifest.write_text(json.dumps(consent, indent=2) + "\n")
    phrases = [
        ("provider", "Samantha", 44_100, "Synthetic provider. How did you sleep this week?"),
        (
            "patient-48000",
            "Daniel",
            48_000,
            "Synthetic patient. I slept better on Tuesday and Wednesday.",
        ),
        (
            "patient-32000",
            "Daniel",
            32_000,
            "Synthetic patient. I slept better on Tuesday and Wednesday.",
        ),
    ]
    files = {}
    for name, voice, rate, text in phrases:
        target = output / (name + ".caf")
        result = subprocess.run(
            [
                "/usr/bin/say",
                "-v",
                voice,
                "--file-format=caff",
                f"--data-format=LEF32@{rate}",
                "-o",
                str(target),
                text,
            ],
            capture_output=True,
            timeout=60,
            check=False,
        )
        if result.returncode != 0 or not target.is_file():
            raise RuntimeError("Synthetic speech generation failed; no capture attempted")
        size = target.stat().st_size
        if not 1_024 < size < 8_000_000:
            raise RuntimeError("Synthetic speech fixture size is invalid")
        files[target.name] = {
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "sample_rate": rate,
            "voice": voice,
        }
    consent["files"] = files
    manifest.write_text(json.dumps(consent, indent=2) + "\n")
    command = [
        "xcrun",
        "swift",
        "test",
        "--disable-sandbox",
        "--package-path",
        "apps/desktop-companion/native/ScribeDesktopAudio",
        "--scratch-path",
        str(output / "swift-build"),
        "--cache-path",
        str(output / "swift-cache"),
        "--config-path",
        str(output / "swift-configuration"),
        "--security-path",
        str(output / "swift-security"),
        "--filter",
        "generatedSpeechSurvivesNativeMeetingMix",
    ]
    log = output / "native-speech-check.log"
    with log.open("w") as stream:
        result = subprocess.run(
            command,
            cwd=repo,
            stdout=stream,
            stderr=subprocess.STDOUT,
            env={
                **os.environ,
                "SCRIBE_SYNTHETIC_SPEECH_DIRECTORY": str(output),
                "CLANG_MODULE_CACHE_PATH": str(output / "modules"),
                "SWIFTPM_MODULECACHE_OVERRIDE": str(output / "modules"),
            },
            timeout=300,
            check=False,
        )
    cases_passed = (
        "generatedSpeechSurvivesNativeMeetingMix(systemRate:) with 2 test cases passed"
        in log.read_text()
    )
    receipt = {
        "source_commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True
        ).strip(),
        "command": command,
        "exit_code": result.returncode,
        "two_speech_cases_passed": cases_passed,
        "working_tree_clean": not subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=repo, text=True
        ).strip(),
        "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "log_sha256": hashlib.sha256(log.read_bytes()).hexdigest(),
        "microphone_opened": False,
        "live_zoom_or_chrome": False,
    }
    (output / "CHECKS.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if result.returncode or not cases_passed:
        raise RuntimeError("Native synthetic speech check failed; inspect its local log")
    print(json.dumps({"native_speech_check": "passed", "live_meeting_capture": "not_tested"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New directory for synthetic-only evidence")
    check(parser.parse_args().output)
