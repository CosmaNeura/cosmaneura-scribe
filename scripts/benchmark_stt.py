from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from cosmaneura_scribe.settings import get_settings
from cosmaneura_scribe.transcription import build_speech_to_text_provider
from cosmaneura_scribe.transcription_benchmark import (
    encode_results,
    load_manifest,
    run_benchmark,
)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark configured STT against an explicitly de-identified local manifest."
    )
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


async def _run(manifest_path: Path, output_path: Path) -> int:
    provider = build_speech_to_text_provider(get_settings())
    try:
        manifest = load_manifest(manifest_path)
        results = await run_benchmark(manifest, provider)
        await asyncio.to_thread(
            output_path.write_text,
            encode_results(results),
            encoding="utf-8",
        )
    finally:
        await provider.close()
    print(json.dumps({"case_count": len(results), "result": "passed"}, sort_keys=True))
    return 0


def main() -> int:
    arguments = _arguments()
    try:
        return asyncio.run(_run(arguments.manifest, arguments.output))
    except Exception:
        print(
            json.dumps({"code": "benchmark_failed", "result": "failed"}, sort_keys=True),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
