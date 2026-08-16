from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import NoReturn

SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
LINEAGE_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _fail() -> NoReturn:
    raise SystemExit(1)


def _load(path: str) -> object:
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def _read_field(path: str, field: str, expected_type: str) -> None:
    document = _load(path)
    if not isinstance(document, dict) or field not in document:
        _fail()
    value = document[field]
    if expected_type == "string" and type(value) is str:
        print(value)
        return
    if expected_type == "integer" and type(value) is int:
        print(value)
        return
    _fail()


def _write_manifest(path: str, plan_sha256: str, state_lineage: str, state_serial: str) -> None:
    if not SHA256_PATTERN.fullmatch(plan_sha256):
        _fail()
    if not LINEAGE_PATTERN.fullmatch(state_lineage):
        _fail()
    if not state_serial.isdigit():
        _fail()
    document = {
        "format_version": 1,
        "plan_sha256": plan_sha256,
        "state_lineage": state_lineage,
        "state_serial": int(state_serial),
    }
    Path(path).write_text(
        json.dumps(document, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main(arguments: list[str]) -> None:
    try:
        if len(arguments) == 4 and arguments[0] == "read-field":
            _read_field(arguments[1], arguments[2], arguments[3])
            return
        if len(arguments) == 5 and arguments[0] == "write-manifest":
            _write_manifest(*arguments[1:])
            return
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        _fail()
    _fail()


if __name__ == "__main__":
    main(sys.argv[1:])
