"""Request-local, content-free timings through the existing safe event logger."""

from __future__ import annotations

from collections.abc import Callable, Generator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from time import perf_counter_ns

from .safe_logging import log_event

# Keep literal action labels visible to the existing PHI-log AST policy.
_TOTAL_LOGGERS: dict[str, Callable[[float], None]] = {
    "catalog": lambda ms: log_event(action="provider.catalog.total", duration_ms=ms),
    "mount": lambda ms: log_event(action="provider.mount.total", duration_ms=ms),
    "recorder": lambda ms: log_event(action="provider.recorder.total", duration_ms=ms),
    "capture-admissions": lambda ms: log_event(
        action="provider.capture-admissions.total", duration_ms=ms,
    ),
    "capture-operations": lambda ms: log_event(
        action="provider.capture-operations.total", duration_ms=ms,
    ),
    "capture-notes": lambda ms: log_event(action="provider.capture-notes.total", duration_ms=ms),
    "note-opening": lambda ms: log_event(action="provider.note-opening.total", duration_ms=ms),
    "source-start": lambda ms: log_event(action="provider.source-start.total", duration_ms=ms),
    "source-start-ready": lambda ms: log_event(
        action="provider.source-start-ready.total", duration_ms=ms,
    ),
}
_PHASE_LOGGERS: dict[str, Callable[[float], None]] = {
    "registry": lambda ms: log_event(action="provider.registry", duration_ms=ms),
    "workload_token": lambda ms: log_event(action="provider.workload_token", duration_ms=ms),
    "core_exchange": lambda ms: log_event(action="provider.core_exchange", duration_ms=ms),
    "core_mount": lambda ms: log_event(action="provider.core_mount", duration_ms=ms),
    "core_binding": lambda ms: log_event(action="provider.core_binding", duration_ms=ms),
    "core_operation": lambda ms: log_event(action="provider.core_operation", duration_ms=ms),
}
PROVIDER_ACTIONS = frozenset(_TOTAL_LOGGERS)


@dataclass
class _Timing:
    durations: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    closed: bool = False


_CURRENT: ContextVar[_Timing | None] = ContextVar("provider_performance", default=None)


@contextmanager
def provider_request_timing(action: str) -> Generator[None, None, None]:
    """Only fixed action/phase labels and cumulative milliseconds are emitted.

    This measures handler time through response headers, including failed or
    cancelled work. It does not describe clinical success or microphone timing.
    Tokens, identifiers, paths, payloads and exceptions are never accepted.
    """
    if action not in PROVIDER_ACTIONS:
        raise ValueError("unknown_provider_timing_action")
    timing = _Timing()
    token = _CURRENT.set(timing)
    started = perf_counter_ns()
    try:
        yield
    finally:
        timing.closed = True
        _CURRENT.reset(token)
        timing.durations["total"] = max(0, perf_counter_ns() - started)
        for phase, duration in timing.durations.items():
            try:
                emit = _TOTAL_LOGGERS[action] if phase == "total" else _PHASE_LOGGERS[phase]
                emit(duration / 1_000_000)
            except Exception:
                # Observability must not replace a request result or cancellation.
                pass


@contextmanager
def provider_phase_timing(phase: str) -> Generator[None, None, None]:
    if phase not in _PHASE_LOGGERS:
        raise ValueError("unknown_provider_timing_phase")
    timing = _CURRENT.get()
    if timing is None:
        yield
        return
    started = perf_counter_ns()
    try:
        yield
    finally:
        if not timing.closed:
            timing.durations[phase] = timing.durations.get(phase, 0) + max(
                0, perf_counter_ns() - started,
            )
