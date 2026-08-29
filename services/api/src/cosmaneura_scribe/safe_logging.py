from __future__ import annotations

import json
import logging
import math
import re
from typing import TextIO
from uuid import UUID

LOGGER_NAME = "cosmaneura_scribe"
LOG_FIELD_ALLOWLIST = frozenset({"action", "entity_id", "tenant_id", "error_class", "duration_ms"})
PRIVATE_API_ACCEPTANCE_RESULT_FIELD_ALLOWLIST = frozenset(
    {
        "action",
        "algorithm",
        "duration_ms",
        "http_status",
        "key_operations",
        "key_size_bits",
        "kty",
        "key_version_present",
    }
)
PRIVATE_API_ACCEPTANCE_READINESS_FIELD_ALLOWLIST = frozenset(
    {"action", "elapsed_ms", "error_class", "poll_count"}
)

_PRIVATE_API_ACCEPTANCE_READINESS_ACTIONS = {
    "private_api_acceptance.readiness_started": None,
    "private_api_acceptance.readiness_succeeded": None,
    "private_api_acceptance.readiness_deadline_exhausted": (
        "PrivateApiAcceptanceReadinessDeadlineExhausted"
    ),
}
_PRIVATE_API_ACCEPTANCE_READINESS_MAX_POLLS = 36

# Namespaces whose libraries emit request URLs at INFO/DEBUG. A blob URL path
# carries the object name, which the hard rules forbid logging. The AST policy in
# scripts/check_phi_logs.py covers code we own; it cannot cover code we do not.
_PHI_RISK_LOG_NAMESPACES = ("azure", "httpcore", "httpx")

_SAFE_LABEL = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,79}$")
_LOGGER = logging.getLogger(LOGGER_NAME)


class _StandaloneSafeLogHandler(logging.StreamHandler[TextIO]):
    """Marker handler used only by command-line jobs."""


def _silence(namespace: str) -> None:
    """Make one third-party logger namespace incapable of emitting."""

    external = logging.getLogger(namespace)
    external.handlers.clear()
    external.addHandler(logging.NullHandler())
    external.propagate = False
    external.disabled = True


def configure_standalone_logging() -> None:
    """Emit allowlisted job events at INFO without enabling third-party INFO logs."""

    if not any(isinstance(handler, _StandaloneSafeLogHandler) for handler in _LOGGER.handlers):
        handler = _StandaloneSafeLogHandler()
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter("%(message)s"))
        _LOGGER.addHandler(handler)
    _LOGGER.setLevel(logging.INFO)
    _LOGGER.propagate = False


def configure_private_api_acceptance_logging() -> None:
    """Expose only the safe Scribe logger in the public-key acceptance process."""

    configure_standalone_logging()
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(logging.NullHandler())
    root.setLevel(logging.CRITICAL + 1)
    for namespace in _PHI_RISK_LOG_NAMESPACES:
        _silence(namespace)


def configure_service_logging() -> None:
    """Expose only the safe Scribe logger inside the long-running API service.

    Deliberately narrow. It does not touch the root logger or this service's own
    logger: under uvicorn those already carry startup and request errors, and
    `log_event` is closed-schema, so neither can carry a clinical payload. It
    closes the one gap they cannot — third-party HTTP clients that log the URLs
    they call.

    Without this the service is protected only by Python's default root level of
    WARNING, which is a default rather than a decision — one ``--log-level debug``
    turns it into blob object names on stdout.
    """

    for namespace in _PHI_RISK_LOG_NAMESPACES:
        _silence(namespace)


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


def log_private_api_acceptance_result(*, duration_ms: int | float) -> None:
    """Emit only the fixed metadata proven by the private API acceptance job."""

    if isinstance(duration_ms, bool) or not math.isfinite(duration_ms) or duration_ms < 0:
        raise ValueError("Structured log duration_ms must be a nonnegative finite number")
    payload: dict[str, object] = {
        "action": "private_api_acceptance.completed",
        "algorithm": "RSA-OAEP-256",
        "duration_ms": round(duration_ms, 3),
        "http_status": 200,
        "key_operations": ["wrapKey"],
        "key_size_bits": 3072,
        "kty": "RSA",
        "key_version_present": True,
    }
    if frozenset(payload) != PRIVATE_API_ACCEPTANCE_RESULT_FIELD_ALLOWLIST:
        raise RuntimeError("private API acceptance log schema is not closed")
    _LOGGER.log(logging.INFO, json.dumps(payload, sort_keys=True, separators=(",", ":")))


def log_private_api_acceptance_readiness(
    *,
    action: str,
    poll_count: object,
    elapsed_ms: int | float,
) -> None:
    """Emit only fixed readiness lifecycle metadata."""

    if action not in _PRIVATE_API_ACCEPTANCE_READINESS_ACTIONS:
        raise ValueError("Private API readiness action must be a fixed safe label")
    if (
        not isinstance(poll_count, int)
        or isinstance(poll_count, bool)
        or not 0 <= poll_count <= _PRIVATE_API_ACCEPTANCE_READINESS_MAX_POLLS
    ):
        raise ValueError("Structured log poll_count must be a bounded nonnegative integer")
    if isinstance(elapsed_ms, bool) or not math.isfinite(elapsed_ms) or elapsed_ms < 0:
        raise ValueError("Structured log elapsed_ms must be a nonnegative finite number")
    error_class = _PRIVATE_API_ACCEPTANCE_READINESS_ACTIONS[action]
    payload: dict[str, object] = {
        "action": action,
        "elapsed_ms": round(elapsed_ms, 3),
        "error_class": error_class,
        "poll_count": poll_count,
    }
    if frozenset(payload) != PRIVATE_API_ACCEPTANCE_READINESS_FIELD_ALLOWLIST:
        raise RuntimeError("private API readiness log schema is not closed")
    level = logging.WARNING if error_class is not None else logging.INFO
    _LOGGER.log(level, json.dumps(payload, sort_keys=True, separators=(",", ":")))
