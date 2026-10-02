import asyncio
import json
from itertools import count

import pytest
from cosmaneura_scribe import provider_performance as performance


@pytest.fixture
def events(monkeypatch):
    recorded = []
    monkeypatch.setattr(performance, "log_event", lambda **value: recorded.append(value))
    return recorded


def test_accumulates_only_fixed_labels_and_monotonic_durations(events, monkeypatch):
    clock = iter([0, 1, 3, 4, 8, 10])
    monkeypatch.setattr(performance, "perf_counter_ns", lambda: next(clock) * 1_000_000)
    with performance.provider_request_timing("mount") as timing:
        assert timing.server_timing() is None
        with performance.provider_phase_timing("registry"):
            pass
        with performance.provider_phase_timing("registry"):
            pass
    assert events == [
        {"action": "provider.registry", "duration_ms": 6},
        {"action": "provider.mount.total", "duration_ms": 10},
    ]
    assert timing.server_timing() == (
        "scribe_registry;dur=6.000, scribe_workload_token;dur=0.000, "
        "scribe_core_exchange;dur=0.000, scribe_core_mount;dur=0.000, "
        "scribe_core_binding;dur=0.000, scribe_core_operation;dur=0.000, "
        "scribe_core_encounter_lookup;dur=0.000, scribe_total;dur=10.000"
    )
    with performance.provider_phase_timing("core_operation"):
        pass
    assert len(events) == 2


@pytest.mark.parametrize("label", ["Bearer private-token", "appointment_private", "unknown"])
def test_unknown_labels_are_rejected_without_output(events, label):
    with pytest.raises(ValueError, match="unknown_provider_timing_action"):
        with performance.provider_request_timing(label):
            pass
    with pytest.raises(ValueError, match="unknown_provider_timing_phase"):
        with performance.provider_phase_timing(label):
            pass
    assert not events


@pytest.mark.parametrize("error", [RuntimeError("private sentinel"), asyncio.CancelledError()])
def test_failures_remain_unchanged_and_never_enter_events(events, error):
    with pytest.raises(type(error)) as caught:
        with performance.provider_request_timing("source-start-ready"):
            with performance.provider_phase_timing("core_operation"):
                raise error
    assert caught.value is error
    assert len(events) == 2
    assert all(set(event) == {"action", "duration_ms"} for event in events)
    assert "private" not in repr(events)


def test_logging_failure_does_not_replace_request_result(monkeypatch):
    def failed_logger(**_):
        raise RuntimeError("logging unavailable")
    monkeypatch.setattr(performance, "log_event", failed_logger)
    with performance.provider_request_timing("catalog"):
        with performance.provider_phase_timing("registry"):
            result = 42
    assert result == 42


@pytest.mark.asyncio
async def test_concurrent_requests_keep_their_own_phases(events, monkeypatch):
    clock = count(step=1_000_000)
    monkeypatch.setattr(performance, "perf_counter_ns", lambda: next(clock))
    arrived = asyncio.Event()
    async def one():
        with performance.provider_request_timing("mount"):
            with performance.provider_phase_timing("registry"):
                arrived.set()
                await asyncio.sleep(0)
    async def two():
        await arrived.wait()
        with performance.provider_request_timing("note-opening"):
            with performance.provider_phase_timing("workload_token"):
                await asyncio.sleep(0)
    await asyncio.gather(one(), two())
    assert {e["action"] for e in events} == {
        "provider.registry", "provider.mount.total",
        "provider.workload_token", "provider.note-opening.total",
    }


@pytest.mark.asyncio
async def test_late_child_cannot_append_to_finished_request(events):
    entered, finish = asyncio.Event(), asyncio.Event()
    async def child():
        with performance.provider_phase_timing("registry"):
            entered.set()
            await finish.wait()
    with performance.provider_request_timing("mount") as timing:
        pending = asyncio.create_task(child())
        await entered.wait()
    assert len(events) == 1 and events[0]["action"] == "provider.mount.total"
    header = timing.server_timing()
    finish.set()
    await pending
    assert len(events) == 1
    assert timing.server_timing() == header


@pytest.mark.parametrize(
    "duration", [True, -1, float("nan"), float("inf"), "private", 3_600_000_000_001],
)
def test_invalid_diagnostic_duration_is_omitted(duration):
    timing = performance._Timing(durations={"total": duration}, closed=True)
    assert timing.server_timing() is None


def test_unknown_diagnostic_field_is_omitted():
    timing = performance._Timing(durations={"total": 1, "private_identity": 1}, closed=True)
    assert timing.server_timing() is None


@pytest.mark.asyncio
async def test_headers_are_isolated_between_concurrent_requests(events):
    ready, finish = asyncio.Event(), asyncio.Event()

    async def first():
        with performance.provider_request_timing("mount") as timing:
            with performance.provider_phase_timing("registry"):
                ready.set()
                await finish.wait()
        return timing.server_timing()

    async def second():
        await ready.wait()
        with performance.provider_request_timing("catalog") as timing:
            with performance.provider_phase_timing("core_operation"):
                await asyncio.sleep(0.001)
        finish.set()
        return timing.server_timing()

    a, b = await asyncio.gather(first(), second())
    assert "scribe_core_operation;dur=0.000" in a
    assert "scribe_registry;dur=0.000" in b
    assert a != b


def test_trace_is_default_off_and_does_not_change_existing_logging(events, monkeypatch):
    clock = count(step=1_000_000)
    monkeypatch.setattr(performance, "perf_counter_ns", lambda: next(clock))
    with performance.provider_request_timing("mount") as timing:
        with performance.provider_phase_timing("registry"):
            with performance.provider_diagnostic_timing("identity_check"):
                pass
    assert not timing.spans and timing.trace_header() is None
    assert events == [
        {"action": "provider.registry", "duration_ms": 1},
        {"action": "provider.mount.total", "duration_ms": 3},
    ]


def test_trace_nested_entry_order_counts_and_same_clock_without_extra_logs(events, monkeypatch):
    clock = count(step=1_000_000)
    monkeypatch.setattr(performance, "perf_counter_ns", lambda: next(clock))
    with performance.provider_request_timing("mount", trace_enabled=True) as timing:
        assert timing.trace_header() is None
        with performance.provider_diagnostic_timing("selection_check"):
            with performance.provider_phase_timing("registry"):
                with performance.provider_diagnostic_timing("identity_check"):
                    pass
    value = json.loads(timing.trace_header())
    assert value == {
        "v": 1, "total_us": 7000,
        "counts": {**dict.fromkeys(performance.TRACE_PHASES, 0),
                   "selection_check": 1, "registry": 1, "identity_check": 1},
        "spans": [
            {"phase": "selection_check", "start_us": 1000, "duration_us": 5000},
            {"phase": "registry", "start_us": 2000, "duration_us": 3000},
            {"phase": "identity_check", "start_us": 3000, "duration_us": 1000},
        ],
    }
    assert events == [
        {"action": "provider.registry", "duration_ms": 3},
        {"action": "provider.mount.total", "duration_ms": 7},
    ]
    assert "identity" not in timing.server_timing()
    assert "selection" not in timing.server_timing()


@pytest.mark.parametrize("error", [RuntimeError("private sentinel"), asyncio.CancelledError()])
def test_trace_retains_failed_call_without_exception_text_or_changing_failure(events, error):
    with pytest.raises(type(error)) as caught:
        with performance.provider_request_timing(
            "source-start-ready", trace_enabled=True,
        ) as timing:
            with performance.provider_diagnostic_timing("identity_check"):
                raise error
    assert caught.value is error
    assert json.loads(timing.trace_header())["counts"]["identity_check"] == 1
    assert "private" not in timing.trace_header() and "private" not in repr(events)


def test_trace_accepts_exact_limit_but_never_publishes_partial_overflow(events):
    with performance.provider_request_timing("mount", trace_enabled=True) as exact:
        for _ in range(performance.TRACE_MAX_SPANS):
            with performance.provider_phase_timing("core_encounter_lookup"):
                pass
    assert len(json.loads(exact.trace_header())["spans"]) == performance.TRACE_MAX_SPANS
    assert len(exact.trace_header().encode("ascii")) <= performance.TRACE_MAX_BYTES
    with performance.provider_request_timing("mount", trace_enabled=True) as overflow:
        for _ in range(performance.TRACE_MAX_SPANS + 1):
            with performance.provider_phase_timing("registry"):
                pass
    assert overflow.trace_header() is None
    assert len(overflow.spans) == performance.TRACE_MAX_SPANS
    assert overflow.server_timing() is not None


@pytest.mark.parametrize("field,value", [
    ("phase", "private identity"), ("start_ns", True), ("start_ns", -1),
    ("duration_ns", None), ("duration_ns", "private"), ("duration_ns", float("nan")),
    ("duration_ns", float("inf")), ("duration_ns", True), ("duration_ns", -1),
    ("duration_ns", 3_600_000_000_001), ("start_ns", 3_600_000_000_001),
])
def test_trace_omits_malformed_span_in_full(field, value):
    span = performance._Span("registry", 0, 1000)
    setattr(span, field, value)
    timing = performance._Timing(
        durations={"total": 1000}, closed=True, trace_enabled=True, spans=[span],
    )
    assert timing.trace_header() is None


@pytest.mark.asyncio
async def test_trace_thread_handoff_and_concurrent_requests_remain_isolated(events):
    async def run(phase):
        def threaded():
            with performance.provider_diagnostic_timing("identity_check"):
                pass
        with performance.provider_request_timing("mount", trace_enabled=True) as timing:
            with performance.provider_phase_timing(phase):
                await asyncio.to_thread(threaded)
        return json.loads(timing.trace_header())
    first, second = await asyncio.gather(run("registry"), run("core_operation"))
    assert first["counts"]["registry"] == 1 and first["counts"]["core_operation"] == 0
    assert second["counts"]["registry"] == 0 and second["counts"]["core_operation"] == 1
    for value in (first, second):
        assert value["counts"]["identity_check"] == 1
        assert len(value["spans"]) == 2


@pytest.mark.asyncio
async def test_unfinished_child_omits_trace_without_late_mutation(events):
    entered, finish = asyncio.Event(), asyncio.Event()
    async def child():
        with performance.provider_diagnostic_timing("identity_check"):
            entered.set()
            await finish.wait()
    with performance.provider_request_timing("mount", trace_enabled=True) as timing:
        pending = asyncio.create_task(child())
        await entered.wait()
    assert timing.trace_header() is None
    header = timing.server_timing()
    finish.set()
    await pending
    assert timing.trace_header() is None and timing.server_timing() == header


def test_unknown_diagnostic_label_is_rejected_without_recording(events):
    with pytest.raises(ValueError, match="unknown_provider_diagnostic_phase"):
        with performance.provider_diagnostic_timing("private"):
            pass
    assert not events
