"""Exercise the actual audio-helper entry point without permissions or capture.

Only its imported ScribeDesktopAudio module is a test stand-in. The product
Main.swift is compiled unchanged, in a new retained temporary directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import tempfile
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(output: Path) -> int:
    repo = Path(__file__).resolve().parents[2]
    output = output.resolve()
    if not any(
        output.is_relative_to(root)
        for root in (Path("/private/tmp"), Path(tempfile.gettempdir()).resolve())
    ):
        raise ValueError("A new owned temporary output directory is required")
    output.mkdir(mode=0o700)
    main = repo / (
        "apps/desktop-companion/native/ScribeDesktopAudio/"
        "Sources/ScribeDesktopAudioHelper/Main.swift"
    )
    fixture = repo / "scripts/desktop-native/appkit-bootstrap-fixture.swift"
    copied_main = output / "Main.swift"
    copied_fixture = output / fixture.name
    copied_main.write_bytes(main.read_bytes())
    copied_fixture.write_bytes(fixture.read_bytes())
    common = [
        "xcrun",
        "swiftc",
        "-swift-version",
        "6",
        "-parse-as-library",
        "-target",
        f"{platform.machine()}-apple-macos14.2",
        "-module-cache-path",
        str(output / "modules"),
    ]
    library = output / "libScribeDesktopAudio.dylib"
    executable = output / "bootstrap-fixture"
    commands = [
        [
            *common,
            "-emit-library",
            "-emit-module",
            "-module-name",
            "ScribeDesktopAudio",
            "-emit-module-path",
            str(output / "ScribeDesktopAudio.swiftmodule"),
            str(copied_fixture),
            "-o",
            str(library),
        ],
        [
            *common,
            "-I",
            str(output),
            "-L",
            str(output),
            "-lScribeDesktopAudio",
            "-Xlinker",
            "-rpath",
            "-Xlinker",
            str(output),
            str(copied_main),
            "-o",
            str(executable),
        ],
    ]
    with (output / "build.log").open("w") as log:
        for command in commands:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=120)
    cases = [
        (["--availability-v1"], 0, {"mode": "availability", "application_ready": True}),
        (
            ["--capture-v2"],
            0,
            {
                "mode": "capture",
                "application_ready": True,
                "enabled": True,
                "allows_renewal": False,
            },
        ),
        (
            ["--capture-v3"],
            0,
            {"mode": "capture", "application_ready": True, "enabled": True, "allows_renewal": True},
        ),
        (["--invalid-fixture-argument"], 64, None),
    ]
    results: list[dict[str, object]] = []
    all_passed = True
    for arguments, expected_code, expected in cases:
        # Explicit permission mode is deliberately not invoked. AppKit is
        # headless; all permission/source methods used here are fixture methods.
        result = subprocess.run(
            [str(executable), *arguments],
            cwd=output,
            env={},
            capture_output=True,
            text=True,
            timeout=10,
        )
        observed = json.loads(result.stdout) if result.stdout else None
        passed = result.returncode == expected_code and observed == expected
        all_passed = all_passed and passed
        results.append(
            {
                "arguments": arguments,
                "returncode": result.returncode,
                "observed": observed,
                "passed": passed,
            }
        )
    exit_code = 0 if all_passed else 1
    receipt = {
        "source_commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True
        ).strip(),
        "inputs": {path.relative_to(repo).as_posix(): digest(path) for path in (main, fixture)},
        "commands": commands,
        "executable_sha256": digest(executable),
        "fixture_library_sha256": digest(library),
        "cases": results,
        "physical_audio_used": False,
        "permission_queries_or_prompts_used": False,
        "screen_filter_exercised": False,
        "exit_code": exit_code,
    }
    (output / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"output": str(output), "cases": results, "exit_code": receipt["exit_code"]}))
    return exit_code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "output", type=Path, help="Fresh temporary directory; retained after the run"
    )
    raise SystemExit(run(parser.parse_args().output))
