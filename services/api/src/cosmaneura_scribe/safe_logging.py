from __future__ import annotations

import json
import logging
import math
import re
from typing import TextIO
from uuid import UUID

LOGGER_NAME = "cosmaneura_scribe"
LOG_FIELD_ALLOWLIST = frozenset({"action", "entity_id", "tenant_id", "error_class", "duration_ms"})

_SAFE_LABEL = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,79}$")
_LOGGER = logging.getLogger(LOGGER_NAME)


class _StandaloneSafeLogHandler(logging.StreamHandler[TextIO]):
    """Marker handler used only by command-line jobs."""


def configure_standalone_logging() -> None:
    """Emit allowlisted job events at INFO without enabling third-party INFO logs."""

    if not any(isinstance(handler, _StandaloneSafeLogHandler) for handler in _LOGGER.handlers):
        handler = _StandaloneSafeLogHandler()
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter("%(message)s"))
        _LOGGER.addHandler(handler)
    _LOGGER.setLevel(logging.INFO)
    _LOGGER.propagate = False


def log_event(
    *,
    action: str,
    entity_id: UUID | None = None,
    tenant_id: UUID | None = None,
    error_class: str | None = None,
    duration_ms: int | float | None = None,
) -> None:
    """Emit one JSON event whose fields cannot contain clinical payloads."""

    if _SAFE_LABEL.fullmatch(action) is None:
        raise ValueError("Structured log action must be a fixed safe label")
    if error_class is not None and _SAFE_LABEL.fullmatch(error_class) is None:
        raise ValueError("Structured log error_class must be a fixed safe label")
    if duration_ms is not None and (
        isinstance(duration_ms, bool) or not math.isfinite(duration_ms) or duration_ms < 0
    ):
        raise ValueError("Structured log duration_ms must be a nonnegative finite number")

    payload: dict[str, object] = {
        "action": action,
        "entity_id": str(entity_id) if entity_id is not None else None,
        "tenant_id": str(tenant_id) if tenant_id is not None else None,
        "error_class": error_class,
        "duration_ms": round(duration_ms, 3) if duration_ms is not None else None,
    }
    level = logging.WARNING if error_class is not None else logging.INFO
    _LOGGER.log(level, json.dumps(payload, sort_keys=True, separators=(",", ":")))
