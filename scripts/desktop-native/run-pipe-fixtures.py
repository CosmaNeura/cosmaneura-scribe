"""Compile and run synthetic desktop pipe tests without installed source custody.

Only the assembled directory-provider function changes. The actual coordinator,
anchor/epoch validation, file locks, capture lease and pipe host remain intact.
The invented PCM executable never constructs a physical audio source.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import selectors
import subprocess
import tempfile
from pathlib import Path
from typing import cast


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(output: Path, node: Path) -> int:
    repo = Path(__file__).resolve().parents[2]
    node_version = subprocess.check_output([str(node.resolve()), "--version"], text=True).strip()
    if not node_version.startswith("v24."):
        raise ValueError("Installed Node 24 is required")
    output = output.resolve()
    if not any(output.is_relative_to(root) for root in (
        Path("/private/tmp"), Path(tempfile.gettempdir()).resolve()
    )) or any(ord(char) < 32 for char in str(output)):
        raise ValueError("A new owned temporary output directory is required")
    output.mkdir(mode=0o700)
    fence_directory = output / "SourceFence"
    fence_directory.mkdir(mode=0o700)
    assembly = output / "sources"
    assembly.mkdir()
    source_root = (
        repo / "apps/desktop-companion/native/ScribeDesktopAudio/Sources/ScribeDesktopAudio"
    )
    inputs: dict[str, dict[str, str]] = {}
    sources: list[str] = []
    for source in sorted(source_root.glob("*.swift")):
        if source.is_symlink():
            raise ValueError("Ordinary local source files are required")
        target = assembly / source.name
        data = source.read_text()
        if source.name == "NativeCaptureProcessFence.swift":
            marker = "func nativeDesktopFenceDirectory() throws -> String {"
            if data.count(marker) != 1 or not data.rstrip().endswith("return path\n}"):
                raise ValueError("Review changed directory-provider boundaries before assembly")
            # This function is the final declaration. Preserve every preceding
            # coordinator/lease/lock byte and bind the replacement at compile time.
            prefix, _ = data.split(marker)
            data = prefix + marker + "\n    return " + json.dumps(str(fence_directory)) + "\n}\n"
        target.write_text(data)
        inputs[source.relative_to(repo).as_posix()] = {
            "source_sha256": digest(source), "assembled_sha256": digest(target)
        }
        sources.append(str(target))
    fixture = repo / "scripts/desktop-native/pipe-fixture.swift"
    fixture_copy = assembly / fixture.name
    fixture_copy.write_bytes(fixture.read_bytes())
    inputs[fixture.relative_to(repo).as_posix()] = {
        "source_sha256": digest(fixture), "assembled_sha256": digest(fixture_copy)
    }
    sources.append(str(fixture_copy))
    executable = output / "pipe-fixture"
    build = ["xcrun", "swiftc", "-swift-version", "6", "-parse-as-library",
             "-target", f"{platform.machine()}-apple-macos14.2",
             "-module-cache-path", str(output / "modules"), *sources, "-o", str(executable)]
    with (output / "build.log").open("w") as log:
        subprocess.run(build, stdout=log, stderr=subprocess.STDOUT, check=True)
    manifest = {
        "source_commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True
        ).strip(),
        "inputs": inputs, "build_command": build,
        "executable_sha256": digest(executable),
        "fence_directory": str(fence_directory),
        "installed_custody_used": False, "physical_audio_used": False,
        "retained_output": True,
    }
    (output / "build-inputs.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # A separate process holds the real coordinator lock/epoch throughout all
    # selected tests, including SIGKILL/WAL recovery in their own child process.
    with (output / "coordinator.log").open("w") as errors:
        coordinator = subprocess.Popen(
            [str(executable), "--fixture-fence-v1"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=errors, env={},
        )
        try:
            assert coordinator.stdout is not None
            with selectors.DefaultSelector() as selector:
                selector.register(coordinator.stdout, selectors.EVENT_READ)
                if not selector.select(timeout=10):
                    raise RuntimeError("Synthetic coordinator did not issue its ticket")
            raw_ticket: object = json.loads(coordinator.stdout.readline(2048))
            if not isinstance(raw_ticket, dict):
                raise RuntimeError("Synthetic coordinator issued an invalid ticket")
            ticket = cast(dict[str, object], raw_ticket)
            if set(ticket) != {
                "epoch", "coordinatorDevice", "coordinatorInode", "captureDevice", "captureInode"
            } or not all(isinstance(value, str) for value in ticket.values()):
                raise RuntimeError("Synthetic coordinator issued an invalid ticket")
            environment = {**os.environ, "SCRIBE_DESKTOP_PIPE_FIXTURE": str(executable),
                           "SCRIBE_DESKTOP_PIPE_FENCE": json.dumps(ticket)}
            command = [str(node.resolve()), str(repo / "node_modules/vitest/vitest.mjs"),
                       "run", "src/native-process-driver.test.ts", "src/provider-recorder.test.ts",
                       "src/durable-store.test.ts", "--reporter=verbose"]
            with (output / "tests.log").open("w") as log:
                result = subprocess.run(
                    command, cwd=repo / "apps/desktop-companion", env=environment,
                    stdout=log, stderr=subprocess.STDOUT, timeout=180,
                )
            if coordinator.poll() is not None:
                raise RuntimeError("Synthetic coordinator exited before test completion")
            receipt = {"command": command, "node_version": node_version,
                       "exit_code": result.returncode,
                       "log_sha256": digest(output / "tests.log"),
                       "build_inputs_sha256": digest(output / "build-inputs.json"),
                       "coordinator_alive_through_test_completion": True}
            (output / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print(json.dumps({"output": str(output), **receipt}))
            return result.returncode
        finally:
            if coordinator.stdin is not None:
                coordinator.stdin.close()
            try:
                coordinator.wait(timeout=5)
            except subprocess.TimeoutExpired:
                coordinator.kill()
                coordinator.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "output", type=Path, help="Fresh temporary directory; retained after the run"
    )
    parser.add_argument("--node", type=Path, required=True, help="Installed Node 24 executable")
    arguments = parser.parse_args()
    raise SystemExit(run(arguments.output, arguments.node))
