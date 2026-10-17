"""Closed numeric Core snapshots, aggregated only inside one provider request.

Snapshots are taken at Core response start: unfinished phases are absent, and
nested phase totals overlap. Neither these values nor their counts are authority.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import cast

CORE_HEADER = "x-cosmaneura-native-request-timing"
PROVIDER_CORE_HEADER = "X-Scribe-Core-Timing"
PHASES = ("workflow_token", "workflow_http", "capture_transaction")
_CORE_PHASES = (
    "workload_agent",
    "workload_capture",
    "clerk_auth",
    "entra_jwks",
    "policy_lookup",
    "policy_exchange",
    "policy_mount",
    "policy_binding",
    "operation",
    "downstream",
    "consent_admission",
    "session_admission",
    "preparation_metadata",
    *PHASES,
)
_KINDS = frozenset(
    {
        "mount",
        "operation",
        "preparation_context",
        "prepared_window",
        "prepared_admission",
        "prepared_native_read",
        "prepared_source",
        "unparsed",
    }
)
MAX_OBSERVATIONS = 16
MAX_HEADER_BYTES = 1024
_MAX_MS = 600_000
_MAX_COUNT = 10_000


def _unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_numeric_field")
        result[key] = value
    return result


def _numeric(value: object, *, count: bool = False) -> bool:
    if type(value) not in ({int} if count else {int, float}):
        return False
    number = cast(int | float, value)
    return math.isfinite(number) and 0 <= number <= (_MAX_COUNT if count else _MAX_MS)


@dataclass(frozen=True)
class _Snapshot:
    milliseconds: dict[str, float]
    counts: dict[str, int]
    failures: dict[str, int]


def _parse(fields: list[str]) -> _Snapshot | None:
    """Validate all nine fields and sixteen phases before projecting only three."""
    if len(fields) != 1 or len(fields[0]) > 4096 or not fields[0].isascii():
        return None
    try:
        raw_row: object = json.loads(fields[0], object_pairs_hook=_unique)
        if type(raw_row) is not dict:
            return None
        row = cast(dict[str, object], raw_row)
        if set(row) != {
            "event",
            "request_kind",
            "total_ms",
            "phase_ms",
            "phase_count",
            "phase_failures",
            "sql_cursor_ms",
            "sql_cursor_count",
            "sql_cursor_failures",
        }:
            return None
        kind = row["request_kind"]
        if (
            row["event"] != "native_core_request_timing"
            or not isinstance(kind, str)
            or kind not in _KINDS
        ):
            return None
        groups: dict[str, dict[str, object]] = {}
        for name in ("phase_ms", "phase_count", "phase_failures"):
            raw_values = row[name]
            if type(raw_values) is not dict:
                return None
            values = cast(dict[str, object], raw_values)
            if set(values) != set(_CORE_PHASES):
                return None
            if not all(_numeric(v, count=name != "phase_ms") for v in values.values()):
                return None
            groups[name] = values
        if not all(_numeric(row[name]) for name in ("total_ms", "sql_cursor_ms")):
            return None
        if not all(
            _numeric(row[name], count=True)
            for name in (
                "sql_cursor_count",
                "sql_cursor_failures",
            )
        ):
            return None
        if cast(int, row["sql_cursor_failures"]) > cast(int, row["sql_cursor_count"]) or any(
            cast(int, groups["phase_failures"][p]) > cast(int, groups["phase_count"][p])
            for p in _CORE_PHASES
        ):
            return None
        return _Snapshot(
            {p: float(cast(int | float, groups["phase_ms"][p])) for p in PHASES},
            {p: cast(int, groups["phase_count"][p]) for p in PHASES},
            {p: cast(int, groups["phase_failures"][p]) for p in PHASES},
        )
    except (ValueError, TypeError, OverflowError, RecursionError):
        return None


@dataclass
class CoreTiming:
    """Owned by _Timing's lock; an overflow omits the whole optional header."""

    observations: int = 0
    accepted: int = 0
    missing: int = 0
    invalid: int = 0
    milliseconds: dict[str, float] = field(default_factory=lambda: dict.fromkeys(PHASES, 0.0))
    counts: dict[str, int] = field(default_factory=lambda: dict.fromkeys(PHASES, 0))
    failures: dict[str, int] = field(default_factory=lambda: dict.fromkeys(PHASES, 0))

    def observe(self, fields: list[str]) -> None:
        self.observations += 1
        if self.observations > MAX_OBSERVATIONS:
            return
        if not fields:
            self.missing += 1
            return
        snapshot = _parse(fields)
        if snapshot is None:
            self.invalid += 1
            return
        self.accepted += 1
        for phase in PHASES:
            self.milliseconds[phase] += snapshot.milliseconds[phase]
            self.counts[phase] += snapshot.counts[phase]
            self.failures[phase] += snapshot.failures[phase]

    def header(self) -> str | None:
        if not 1 <= self.accepted <= self.observations <= MAX_OBSERVATIONS:
            return None
        fields = [
            "v=1",
            f"observations={self.observations}",
            f"accepted={self.accepted}",
            f"missing={self.missing}",
            f"invalid={self.invalid}",
            "response_start_only=1",
            "nonadditive=1",
        ]
        for phase in PHASES:
            fields.extend(
                (
                    f"{phase}_ms={self.milliseconds[phase]:.2f}",
                    f"{phase}_count={self.counts[phase]}",
                    f"{phase}_failures={self.failures[phase]}",
                )
            )
        value = ";".join(fields)
        return value if len(value) <= MAX_HEADER_BYTES else None
