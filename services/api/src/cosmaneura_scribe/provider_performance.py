"""Request-local, content-free timings through the existing safe event logger."""

from __future__ import annotations

import json
from collections.abc import Callable, Generator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from threading import Lock
from time import perf_counter_ns

from .safe_logging import log_event

# Keep literal action labels visible to the existing PHI-log AST policy.
_TOTAL_LOGGERS: dict[str, Callable[[float], None]] = {
    "encounters": lambda ms: log_event(action="provider.encounters.total", duration_ms=ms),
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
    "core_encounter_lookup": lambda ms: log_event(
        action="provider.core_encounter_lookup", duration_ms=ms,
    ),
}
PROVIDER_ACTIONS = frozenset(_TOTAL_LOGGERS)
_DIAGNOSTIC_PHASES = frozenset({"identity_check", "selection_check"})
TRACE_PHASES = (*_PHASE_LOGGERS, "identity_check", "selection_check")
TRACE_MAX_SPANS = 128
TRACE_MAX_BYTES = 16_384
_MAX_NS = 3_600_000_000_000


@dataclass
class _Span:
    phase: str
    start_ns: int
    duration_ns: int | None = None


@dataclass
class _Timing:
    durations: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    closed: bool = False
    trace_enabled: bool = False
    started_ns: int = 0
    spans: list[_Span] = field(default_factory=lambda: list[_Span]())
    trace_invalid: bool = False
    lock: Lock = field(default_factory=Lock, repr=False)

    def begin_span(self, phase: str, started: int) -> _Span | None:
        if not self.trace_enabled:
            return None
        with self.lock:
            if self.closed or self.trace_invalid:
                return None
            if len(self.spans) >= TRACE_MAX_SPANS:
                self.trace_invalid = True
                return None
            span = _Span(phase, started - self.started_ns)
            self.spans.append(span)
            return span

    def trace_header(self) -> str | None:
        """Bounded closed snapshot; nested spans are not additive or authority.

        Order is span entry order, not completion order. Offsets/durations are
        integer microseconds on this request's monotonic clock. Counts include
        failed calls but not unfinished calls: any unfinished/overflowed trace
        is omitted in full. No downstream headers or dynamic labels enter it.
        """
        with self.lock:
            total = self.durations.get("total")
            if (
                not self.trace_enabled or not self.closed or self.trace_invalid
                or type(total) is not int or not 0 <= total <= _MAX_NS
                or len(self.spans) > TRACE_MAX_SPANS
            ):
                return None
            counts = dict.fromkeys(TRACE_PHASES, 0)
            spans: list[dict[str, str | int]] = []
            for span in self.spans:
                if (
                    type(span) is not _Span or span.phase not in counts
                    or type(span.start_ns) is not int or type(span.duration_ns) is not int
                    or not 0 <= span.start_ns <= total
                    or not 0 <= span.duration_ns <= total - span.start_ns
                ):
                    return None
                counts[span.phase] += 1
                spans.append({
                    "phase": span.phase,
                    "start_us": span.start_ns // 1000,
                    "duration_us": span.duration_ns // 1000,
                })
            value = json.dumps({
                "v": 1, "total_us": total // 1000, "counts": counts, "spans": spans,
            }, separators=(",", ":"), ensure_ascii=True)
            return value if len(value) <= TRACE_MAX_BYTES else None

    def server_timing(self) -> str | None:
        """Closed numeric snapshot of this request; never an authority receipt.

        Zero means no measured work in that phase. No identifiers, arbitrary
        labels or errors are admitted, and malformed diagnostics are omitted.
        """
        phases = (*_PHASE_LOGGERS, "total")
        if not self.closed or "total" not in self.durations or set(self.durations) - set(phases):
            return None
        values = {phase: self.durations.get(phase, 0) for phase in phases}
        if any(type(ns) is not int or not 0 <= ns <= 3_600_000_000_000 for ns in values.values()):
            return None
        return ", ".join(f"scribe_{phase};dur={ns / 1_000_000:.3f}" for phase, ns in values.items())


_CURRENT: ContextVar[_Timing | None] = ContextVar("provider_performance", default=None)


@contextmanager
def provider_request_timing(
    action: str, *, trace_enabled: bool = False,
) -> Generator[_Timing, None, None]:
    """Only fixed action/phase labels and cumulative milliseconds are emitted.

    This measures handler time through response headers, including failed or
    cancelled work. It does not describe clinical success or microphone timing.
    Tokens, identifiers, paths, payloads and exceptions are never accepted.
    """
    if action not in PROVIDER_ACTIONS:
        raise ValueError("unknown_provider_timing_action")
    timing = _Timing(trace_enabled=trace_enabled is True)
    token = _CURRENT.set(timing)
    started = perf_counter_ns()
    timing.started_ns = started
    try:
        yield timing
    finally:
        with timing.lock:
            timing.closed = True
            timing.durations["total"] = max(0, perf_counter_ns() - started)
        _CURRENT.reset(token)
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
    span = timing.begin_span(phase, started)
    try:
        yield
    finally:
        duration = max(0, perf_counter_ns() - started)
        with timing.lock:
            if not timing.closed:
                timing.durations[phase] = timing.durations.get(phase, 0) + duration
                if span is not None:
                    span.duration_ns = duration


@contextmanager
def provider_diagnostic_timing(phase: str) -> Generator[None, None, None]:
    """Optional nested span only; never changes existing phase totals/logs."""
    if phase not in _DIAGNOSTIC_PHASES:
        raise ValueError("unknown_provider_diagnostic_phase")
    timing = _CURRENT.get()
    if timing is None or not timing.trace_enabled:
        yield
        return
    started = perf_counter_ns()
    span = timing.begin_span(phase, started)
    try:
        yield
    finally:
        duration = max(0, perf_counter_ns() - started)
        with timing.lock:
            if not timing.closed and span is not None:
                span.duration_ns = duration
