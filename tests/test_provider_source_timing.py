"""Observe real prepared-source replies without changing their authority outcome."""

import pytest
from cosmaneura_scribe import provider_performance as performance
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from test_provider_core_timing import core_row, decode, headers
from test_provider_source_preparation import SourceWire, invoke, setup


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 503])
async def test_prepared_source_preserves_core_timing_and_original_status(status):
    wire = SourceWire()
    wire.status = status
    original = wire.handle
    row = core_row()
    row["request_kind"] = "prepared_source"
    row["phase_ms"]["capture_transaction"] = 80.0
    row["phase_count"]["capture_transaction"] = 1

    async def handle(request):
        response = await original(request)
        response.headers.update(headers(row))
        return response

    wire.handle = handle
    workspace, handoff, revision = await setup(wire)
    with performance.provider_request_timing("source-start-ready") as timing:
        if status == 503:
            with pytest.raises(ProviderCoreUnavailable) as caught:
                await invoke(wire, workspace, handoff, revision)
            assert caught.value.status == status
        else:
            result = await invoke(wire, workspace, handoff, revision)
            assert result["preparation"]["receipt"]["state"] == "prepared"
            assert result["authorization"]["receipt"]["receipt"]["state"] == "issued"
            assert wire.checks == 6

    observed = decode(timing.core_header())
    assert observed["accepted"] == "1"
    assert observed["capture_transaction_ms"] == "80.00"
    assert observed["capture_transaction_count"] == "1"
    assert len(wire.calls) == 1
    assert not handoff._pending
