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
    with performance.provider_request_timing("mount"):
        with performance.provider_phase_timing("registry"):
            pass
        with performance.provider_phase_timing("registry"):
            pass
    assert events == [
        {"action": "provider.registry", "duration_ms": 6},
        {"action": "provider.mount.total", "duration_ms": 10},
    ]
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
    with performance.provider_request_timing("mount"):
        pending = asyncio.create_task(child())
        await entered.wait()
    assert len(events) == 1 and events[0]["action"] == "provider.mount.total"
    finish.set()
    await pending
    assert len(events) == 1
