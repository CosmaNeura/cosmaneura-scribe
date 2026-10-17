"""Metadata-only fixtures: no account, network, audio or clinical content."""

import asyncio
import json

import httpx
import pytest
from cosmaneura_scribe import provider_core_timing as core
from cosmaneura_scribe import provider_performance as performance


def core_row():
    return {
        "event": "native_core_request_timing",
        "request_kind": "prepared_admission",
        "total_ms": 150.25,
        "phase_ms": dict.fromkeys(core._CORE_PHASES, 0.0),
        "phase_count": dict.fromkeys(core._CORE_PHASES, 0),
        "phase_failures": dict.fromkeys(core._CORE_PHASES, 0),
        "sql_cursor_ms": 3.25,
        "sql_cursor_count": 2,
        "sql_cursor_failures": 0,
    }


def headers(row=None):
    return httpx.Headers({core.CORE_HEADER: json.dumps(row if row is not None else core_row())})


def decode(value):
    return dict(item.split("=") for item in value.split(";"))


def test_projects_only_three_phases_and_reports_partial_response_start_observations(monkeypatch):
    events = []
    monkeypatch.setattr(performance, "log_event", lambda **event: events.append(event))
    row = core_row()
    row["phase_ms"].update(workflow_token=12.25, workflow_http=47.5, capture_transaction=88.75)
    row["phase_count"].update(workflow_token=2, workflow_http=2, capture_transaction=1)
    row["phase_failures"]["workflow_http"] = 1
    with performance.provider_request_timing("capture-admissions") as timing:
        assert timing.core_header() is None
        performance.observe_core_response(headers(row))
        performance.observe_core_response(headers(row))
        performance.observe_core_response(httpx.Headers())
        performance.observe_core_response(httpx.Headers({core.CORE_HEADER: "private sentinel"}))
    value = decode(timing.core_header())
    assert value == {
        "v": "1",
        "observations": "4",
        "accepted": "2",
        "missing": "1",
        "invalid": "1",
        "response_start_only": "1",
        "nonadditive": "1",
        "workflow_token_ms": "24.50",
        "workflow_token_count": "4",
        "workflow_token_failures": "0",
        "workflow_http_ms": "95.00",
        "workflow_http_count": "4",
        "workflow_http_failures": "2",
        "capture_transaction_ms": "177.50",
        "capture_transaction_count": "2",
        "capture_transaction_failures": "0",
    }
    assert len(events) == 1 and set(events[0]) == {"action", "duration_ms"}
    assert "private" not in timing.core_header()
    assert "sql" not in timing.core_header() and "request_kind" not in timing.core_header()
    assert timing.server_timing().count(";dur=") == 8


@pytest.mark.parametrize(
    "group,name,value",
    [
        (None, "total_ms", True),
        (None, "total_ms", -1),
        (None, "total_ms", float("nan")),
        (None, "sql_cursor_ms", float("inf")),
        (None, "sql_cursor_count", 1.0),
        (None, "sql_cursor_failures", 3),
        (None, "event", "private sentinel"),
        (None, "request_kind", "appointment_private"),
        (None, "request_kind", []),
        ("phase_ms", "workflow_token", 600000.01),
        ("phase_ms", "workload_agent", "private"),
        ("phase_count", "workflow_http", True),
        ("phase_count", "policy_lookup", -1),
        ("phase_count", "capture_transaction", 10001),
        ("phase_failures", "workflow_token", 1),
    ],
)
def test_rejects_malformed_values_even_in_nonforwarded_fields(group, name, value):
    row = core_row()
    (row if group is None else row[group])[name] = value
    assert core._parse([json.dumps(row)]) is None


def test_rejects_duplicates_unknown_private_fields_old_phase_set_and_oversized_header():
    row = core_row()
    raw = json.dumps(row)
    assert core._parse([raw, raw]) is None
    assert core._parse([raw.replace('"total_ms": 150.25', '"total_ms": 1,"total_ms": 2')]) is None
    assert (
        core._parse([raw.replace('"workflow_http": 0.0', '"workflow_http": 1,"workflow_http": 2')])
        is None
    )
    assert core._parse([raw + " " * 4096]) is None
    assert core._parse(["[" * 1500 + "]" * 1500]) is None
    row["private_identifier"] = "synthetic forbidden"
    assert core._parse([json.dumps(row)]) is None
    del row["private_identifier"]
    for field in ("phase_ms", "phase_count", "phase_failures"):
        for phase in core.PHASES:
            del row[field][phase]
    assert core._parse([json.dumps(row)]) is None  # Older thirteen-phase metadata is optional.


def test_absent_invalid_and_observation_overflow_omit_whole_header():
    with performance.provider_request_timing("catalog") as absent:
        performance.observe_core_response(httpx.Headers())
    assert absent.core_header() is None
    with performance.provider_request_timing("mount") as invalid:
        performance.observe_core_response(httpx.Headers({core.CORE_HEADER: "not numeric"}))
    assert invalid.core_header() is None
    with performance.provider_request_timing("capture-admissions") as exact:
        for _ in range(core.MAX_OBSERVATIONS):
            performance.observe_core_response(headers())
    assert decode(exact.core_header())["accepted"] == "16"
    with performance.provider_request_timing("capture-admissions") as overflow:
        for _ in range(core.MAX_OBSERVATIONS + 1):
            performance.observe_core_response(headers())
    assert overflow.core_header() is None


@pytest.mark.asyncio
async def test_concurrent_threads_and_late_children_cannot_cross_request_or_closed_custody():
    entered, release = asyncio.Event(), asyncio.Event()

    async def first():
        with performance.provider_request_timing("mount") as timing:
            await asyncio.to_thread(performance.observe_core_response, headers())
            entered.set()
            await release.wait()
        return timing.core_header()

    async def second():
        await entered.wait()
        row = core_row()
        row["phase_ms"]["workflow_http"] = 7.5
        row["phase_count"]["workflow_http"] = 1
        with performance.provider_request_timing("catalog") as timing:
            performance.observe_core_response(headers(row))
        release.set()
        return timing.core_header()

    a, b = await asyncio.gather(first(), second())
    assert decode(a)["workflow_http_ms"] == "0.00"
    assert decode(b)["workflow_http_ms"] == "7.50"

    async def late():
        await release.wait()
        performance.observe_core_response(headers())

    release.clear()
    with performance.provider_request_timing("mount") as closed:
        performance.observe_core_response(headers())
        child = asyncio.create_task(late())
    original = closed.core_header()
    release.set()
    await child
    assert closed.core_header() == original


@pytest.mark.parametrize("error", [RuntimeError("private sentinel"), asyncio.CancelledError()])
def test_observation_does_not_replace_failures_or_cancellation(error):
    with pytest.raises(type(error)) as caught:
        with performance.provider_request_timing("source-start-ready") as timing:
            performance.observe_core_response(headers())
            raise error
    assert caught.value is error and decode(timing.core_header())["accepted"] == "1"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 503])
@pytest.mark.parametrize("retained", [False, True])
async def test_real_native_facade_observes_header_before_original_status_classification(
    status, retained
):
    from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
    from test_provider_native_core_transport import Wire, body, retained_preparation

    wire = Wire()
    original = wire.handle

    async def handle(request):
        response = await original(request)
        response.headers.update(headers())
        response.status_code = status
        return response

    wire.handle = handle
    request = body("capture-operations", "native_recording_preparation")
    client = None
    try:
        if retained:
            client, handoff, revision = retained_preparation(wire, request["workspace_id"])

        async def dispatch():
            if client is not None:
                return await client.request(
                    "capture-operations",
                    request,
                    "prepared-timing-key",
                    handoff=handoff,
                    revision=revision,
                )
            return await wire.call("capture-operations", request)

        with performance.provider_request_timing("capture-operations") as timing:
            if status == 503:
                with pytest.raises(ProviderCoreUnavailable) as caught:
                    await dispatch()
                assert caught.value.status == 503
            else:
                await dispatch()
    finally:
        if client is not None:
            await client.close()
    assert decode(timing.core_header())["accepted"] == "1"
    assert len(wire.calls) == 1


def test_optional_serialization_failure_does_not_change_original_result(monkeypatch):
    def unavailable(_self):
        raise RuntimeError("private sentinel")

    monkeypatch.setattr(core.CoreTiming, "header", unavailable)
    with performance.provider_request_timing("catalog") as timing:
        result = 42
    assert result == 42 and timing.core_header() is None


@pytest.mark.asyncio
async def test_fresh_preparation_context_keeps_existing_dispatch_and_account_fences():
    from test_provider_preparation_core_transport import Wire

    wire = Wire()
    original = wire.handle

    async def handle(request):
        response = await original(request)
        response.headers.update(headers())
        return response

    wire.handle = handle
    with performance.provider_request_timing("capture-operations") as timing:
        await wire.call()
    assert len(wire.calls) == 2 and wire.checks == 6
    assert decode(timing.core_header())["accepted"] == "1"
