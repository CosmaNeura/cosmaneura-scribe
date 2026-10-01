import asyncio
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
