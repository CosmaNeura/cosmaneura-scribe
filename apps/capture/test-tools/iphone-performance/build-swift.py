#!/usr/bin/env python3
"""Build/run the actual native recording host with offline synthetic fixtures."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

TOOL = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, default=TOOL.parents[3])
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo, out = args.checkout.resolve(), args.output.resolve()
    if out == repo or repo in out.parents:
        parser.error("Keep generated performance artifacts outside the checkout.")
    target = out / "swift"
    target.mkdir(parents=True, exist_ok=False)
    specification = importlib.util.spec_from_file_location(
        "native_checks", repo / "scripts/check-native-recording-run.py"
    )
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    fixture = repo / "scripts/standalone-provider/check-native-recording-host.swift"
    # Expose only the test's in-memory fixture owners to the separate timer.
    # Product sources are compiled unchanged; no OS source/Keychain is used.
    (target / "host-fixture.swift").write_text(fixture.read_text().replace("private ", ""))
    native_provider = repo / "scripts/standalone-provider/check-native-provider.swift"
    sources = [fixture, native_provider, *module.BRIDGE]
    sources += [path for _, paths in module.MODULES for path in paths]
    inventory = {
        str(path.relative_to(repo)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sources
    }
    provenance = {
        "commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True
        ).strip(),
        "inputs": inventory,
        "host": "macOS Swift; not physical iOS",
        "microphone": False,
        "network": False,
        "fixture_sha256": hashlib.sha256((TOOL / "timing.swift").read_bytes()).hexdigest(),
    }
    (target / "SOURCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
    results = []

    def run(name: str, command: list[str]) -> None:
        timeout = 60 if name == "timing" else 600
        timed_out = False
        with (target / f"{name}.log").open("w") as stream:
            try:
                result = subprocess.run(
                    command, cwd=repo, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout
                )
                exit_code = result.returncode
            except subprocess.TimeoutExpired:
                exit_code, timed_out = 124, True
                stream.write(f"\nSynthetic lab command exceeded {timeout} seconds.\n")
        results.append({"name": name, "command": command, "exit_code": exit_code,
                        "timeout_seconds": timeout, "timed_out": timed_out})
        (target / "CHECKS.json").write_text(json.dumps(results, indent=2) + "\n")
        print(name, exit_code, flush=True)
        if exit_code:
            raise SystemExit(exit_code)

    common = [
        "xcrun", "swiftc", "-swift-version", "6", "-module-cache-path",
        str(target / "cache"), "-I", str(target),
    ]
    libraries: list[str] = []
    for name, paths in module.MODULES:
        run(name, common + [
            "-emit-module", "-module-name", name, "-emit-module-path",
            str(target / f"{name}.swiftmodule"), "-O", "-enable-testing",
            "-emit-library", "-o", str(target / f"lib{name}.dylib"),
            "-L", str(target), *libraries, *map(str, paths),
        ])
        libraries.append(f"-l{name}")
    run("build", common + [
        "-O", "-parse-as-library", "-D", "NATIVE_BINDING_CHECKS", "-L", str(target),
        *libraries, "-Xlinker", "-rpath", "-Xlinker", str(target), "-o", str(target / "timing"),
        *map(str, module.BRIDGE), str(native_provider), str(target / "host-fixture.swift"),
        str(TOOL / "timing.swift"),
    ])
    for path in sources:
        if hashlib.sha256(path.read_bytes()).hexdigest() != inventory[str(path.relative_to(repo))]:
            raise RuntimeError("Native source changed during the build; discard this measurement.")
    run("timing", [str(target / "timing")])


if __name__ == "__main__":
    main()
