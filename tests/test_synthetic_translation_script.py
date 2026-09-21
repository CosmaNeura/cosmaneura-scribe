from __future__ import annotations

import runpy
from pathlib import Path

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/qualify_synthetic_translation.py"


@pytest.mark.asyncio
async def test_status_transport_reopens_after_each_one_shot_client(monkeypatch) -> None:
    script = runpy.run_path(str(SCRIPT))
    pools = []

    class Pool(httpx.AsyncBaseTransport):
        def __init__(self, **kwargs):
            assert kwargs == {"retries": 0, "trust_env": False}
            self.closed = False
            pools.append(self)

        async def handle_async_request(self, request):
            assert not self.closed
            return httpx.Response(200, json={"synthetic": True})

        async def aclose(self):
            self.closed = True

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", Pool)
    transport = script["_StatusOnlyTransport"]()
    for _ in range(2):
        async with httpx.AsyncClient(transport=transport) as client:
            response = await client.post("https://synthetic.invalid/fixed")
            assert response.status_code == 200
    assert len(pools) == 2 and all(pool.closed for pool in pools)
    assert transport.statuses == [200, 200]
    assert transport.inner is None
