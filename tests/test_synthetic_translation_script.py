from __future__ import annotations

import asyncio
import json
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


def test_error_metadata_retains_only_fixed_codes_and_true_flags() -> None:
    script = runpy.run_path(str(SCRIPT))
    marker = "synthetic-sensitive-message-never-retain"
    raw = json.dumps(
        {
            "error": {
                "code": "content_filter",
                "message": marker,
                "param": marker,
                "innererror": {
                    "code": "ResponsibleAIPolicyViolation",
                    "content_filter_result": {
                        "jailbreak": {"detected": True, "filtered": True, "message": marker},
                        "hate": {"detected": "true", "filtered": False},
                        marker: {"detected": True},
                    },
                },
            }
        }
    ).encode()
    result = script["_error_metadata"](raw)
    assert result == {
        "diagnostic": "parsed",
        "error_code": "content_filter",
        "inner_code": "ResponsibleAIPolicyViolation",
        "filter_flags": ["jailbreak_detected", "jailbreak_filtered"],
    }
    assert marker not in json.dumps(result)
    result = script["_error_metadata"](
        json.dumps(
            {
                "error": {
                    "code": marker,
                    "innererror": {"code": [marker]},
                    "message": marker,
                }
            }
        ).encode()
    )
    assert result == {
        "diagnostic": "parsed",
        "error_code": "other_or_absent",
        "inner_code": "other_or_absent",
        "filter_flags": [],
    }


@pytest.mark.parametrize(
    "raw",
    [
        b"not-json",
        b"[]",
        b"{}",
        b'{"error":[]}',
        b'{"error":{"code":"content_filter","code":"other"}}',
        b"[" * 2000 + b"]" * 2000,
    ],
)
def test_invalid_error_payload_returns_no_values(raw: bytes) -> None:
    parse = runpy.run_path(str(SCRIPT))["_error_metadata"]
    assert parse(raw) == {"diagnostic": "invalid_error_body"}


class _ErrorStream(httpx.AsyncByteStream):
    def __init__(self, data: bytes, failure: BaseException | None = None):
        self.data = data
        self.failure = failure
        self.reads = 0

    async def __aiter__(self):
        if self.failure:
            raise self.failure
        for start in range(0, len(self.data), 1024):
            self.reads += 1
            yield self.data[start : start + 1024]


@pytest.mark.asyncio
async def test_diagnostic_body_read_is_bounded_and_does_not_decompress() -> None:
    read = runpy.run_path(str(SCRIPT))["_read_error_metadata"]
    stream = _ErrorStream(b"x" * 100_000)
    assert await read(httpx.Response(400, stream=stream)) == {"diagnostic": "body_limit"}
    assert stream.reads == 17
    encoded = _ErrorStream(b"unused")
    assert await read(
        httpx.Response(
            400,
            stream=encoded,
            headers={
                "Content-Encoding": "gzip",
            },
        )
    ) == {"diagnostic": "encoded_body_not_read"}
    assert encoded.reads == 0


@pytest.mark.asyncio
async def test_diagnostic_read_failure_is_bounded_and_cancellation_propagates() -> None:
    read = runpy.run_path(str(SCRIPT))["_read_error_metadata"]
    failed = _ErrorStream(b"", httpx.ReadError("synthetic-sensitive-detail"))
    assert await read(httpx.Response(400, stream=failed)) == {"diagnostic": "body_unavailable"}
    with pytest.raises(asyncio.CancelledError):
        await read(httpx.Response(400, stream=_ErrorStream(b"", asyncio.CancelledError())))


@pytest.mark.asyncio
async def test_real_adapter_still_rejects_once_after_error_diagnostics(monkeypatch) -> None:
    script = runpy.run_path(str(SCRIPT))
    from cosmaneura_scribe.translation_adapter import (
        SpanishToEnglishTranslationRequest,
        TranslationAdapterError,
        TranslationAdapterFailureCode,
    )
    from test_azure_translation import Credential, Guard

    pools = []

    class Pool(httpx.AsyncBaseTransport):
        def __init__(self, **kwargs):
            assert kwargs == {"retries": 0, "trust_env": False}
            pools.append(self)

        async def handle_async_request(self, request):
            return httpx.Response(
                400,
                stream=_ErrorStream(
                    b'{"error":{"code":"content_filter","message":"do-not-retain"}}'
                ),
            )

    monkeypatch.setattr(httpx, "AsyncHTTPTransport", Pool)
    transport = script["_StatusOnlyTransport"]()
    configured = script["AzureGPT41TranslationAdapter"](
        script["AzureTranslationProfile"](
            "https://synthetic-model.openai.azure.com/openai/v1", "gpt-4.1"
        ),
        credential=Credential(),
        endpoint_guard=Guard(),
        transport=transport,
    )
    with pytest.raises(TranslationAdapterError) as error:
        await configured.translate(SpanishToEnglishTranslationRequest("Texto sintetico."))
    assert error.value.code == TranslationAdapterFailureCode.PROVIDER_REJECTED
    assert len(pools) == 1
    assert transport.errors == [
        {
            "request_index": 0,
            "http_status": 400,
            "diagnostic": "parsed",
            "error_code": "content_filter",
            "inner_code": "other_or_absent",
            "filter_flags": [],
        }
    ]
    assert transport.inner is None
