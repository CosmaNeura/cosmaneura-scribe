from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
from datetime import UTC, datetime
from enum import Enum
from typing import cast
from uuid import UUID

from pydantic import BaseModel

type CanonicalValue = (
    None | bool | int | float | str | list["CanonicalValue"] | dict[str, "CanonicalValue"]
)


def canonical_json_bytes(value: object) -> bytes:
    normalized = _normalize(value)
    return json.dumps(
        normalized,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _normalize(value: object) -> CanonicalValue:
    if isinstance(value, BaseModel):
        return _normalize(value.model_dump(mode="python"))
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Canonical datetimes must include a UTC offset")
        return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Enum):
        return _normalize(value.value)
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Canonical numbers must be finite")
        return value
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        if any(not isinstance(key, str) for key in mapping):
            raise TypeError("Canonical mapping keys must be strings")
        keys = sorted(cast(str, key) for key in mapping)
        return {key: _normalize(mapping[key]) for key in keys}
    if isinstance(value, (set, frozenset)):
        unordered = cast(set[object] | frozenset[object], value)
        normalized = [_normalize(item) for item in unordered]
        return sorted(normalized, key=_sort_key)
    if isinstance(value, (list, tuple)):
        sequence = cast(list[object] | tuple[object, ...], value)
        return [_normalize(item) for item in sequence]
    raise TypeError(f"Unsupported canonical JSON value: {type(value).__name__}")


def _sort_key(value: CanonicalValue) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
