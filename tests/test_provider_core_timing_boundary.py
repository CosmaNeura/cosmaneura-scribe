"""Execute the actual middleware alone, without identity/database service setup."""

import ast
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import httpx
import pytest
from cosmaneura_scribe import provider_performance as performance
from cosmaneura_scribe.provider_core_timing import PROVIDER_CORE_HEADER
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from test_provider_core_timing import decode, headers


def application(observe=False):
    source = Path(__file__).parents[1] / "scripts/standalone-provider/receiver.py"
    boundary = next(
        node
        for node in ast.walk(ast.parse(source.read_text()))
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "boundary"
    )
    app = FastAPI()
    namespace = {
        "app": app,
        "Request": Request,
        "urlsplit": urlsplit,
        "self": SimpleNamespace(
            enabled=True,
            _provider_trace_enabled=False,
            profile=SimpleNamespace(
                origin="https://provider.synthetic.invalid", native_origins={"app://fixture"}
            ),
        ),
        "_PREFIX": "/provider/v1/",
        "_LIMITS": {"catalog": 2},
        "_reply": lambda status, body: JSONResponse(body, status_code=status),
        "provider_request_timing": performance.provider_request_timing,
        "PROVIDER_CORE_HEADER": PROVIDER_CORE_HEADER,
    }
    # The function/decorator bytes are compiled unchanged from production. All
    # service constructors are excluded; the route below is a synthetic fixture.
    exec(compile(ast.Module(body=[boundary], type_ignores=[]), str(source), "exec"), namespace)

    @app.post("/provider/v1/catalog")
    async def catalog():
        if observe:
            performance.observe_core_response(headers())
        return JSONResponse(
            {"synthetic": True},
            headers={
                "Server-Timing": "private-forbidden;dur=1",
                PROVIDER_CORE_HEADER: "private-forbidden",
            },
        )

    return app


@pytest.mark.asyncio
@pytest.mark.parametrize("observe", [False, True])
async def test_actual_boundary_strips_spoofed_metadata_and_keeps_legacy_eight_metrics(observe):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application(observe)),
        base_url="https://provider.synthetic.invalid",
    ) as client:
        response = await client.post(
            "/provider/v1/catalog", headers={"Origin": "app://fixture"}, json={}
        )
    assert response.status_code == 200 and response.json() == {"synthetic": True}
    assert len(response.headers["server-timing"].split(",")) == 8
    assert "private" not in repr(dict(response.headers))
    if observe:
        assert decode(response.headers[PROVIDER_CORE_HEADER])["accepted"] == "1"
    else:
        assert PROVIDER_CORE_HEADER not in response.headers


@pytest.mark.asyncio
async def test_incoming_numeric_header_cannot_inject_observations_or_enter_handler():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application(True)),
        base_url="https://provider.synthetic.invalid",
    ) as client:
        response = await client.post(
            "/provider/v1/catalog",
            headers={
                "Origin": "app://fixture",
                PROVIDER_CORE_HEADER: "v=1",
            },
            json={},
        )
    assert response.status_code == 404 and PROVIDER_CORE_HEADER not in response.headers
