from __future__ import annotations

import asyncio
import json
from typing import cast

import httpx
import pytest
from azure.core.credentials import AccessToken
from azure.core.credentials_async import AsyncTokenCredential
from cosmaneura_scribe.azure_translation import (
    AzureGPT41TranslationAdapter,
    AzureTranslationProfile,
)
from cosmaneura_scribe.translation_adapter import (
    SpanishToEnglishTranslationRequest,
    TranslationAdapterError,
    TranslationAdapterFailureCode,
    prepare_spanish_to_english_attempt,
)
from test_translation_adapter import _reservation

SOURCE = "No tengo fiebre. Tomo 5 mg, no 50 mg."
ENGLISH = "I do not have a fever. I take 5 mg, not 50 mg."
ENDPOINT = "https://synthetic-model.openai.azure.com/openai/v1"


class Credential:
    def __init__(self) -> None:
        self.calls = 0

    async def get_token(self, *scopes: str, **kwargs: object) -> AccessToken:
        assert scopes == ("https://cognitiveservices.azure.com/.default",)
        self.calls += 1
        return AccessToken("synthetic-token", 4_000_000_000)


class Guard:
    def __init__(self, error: Exception | None = None) -> None:
        self.calls = 0
        self.error = error

    async def verify(self) -> None:
        self.calls += 1
        if self.error:
            raise self.error


def body() -> dict:
    return {
        "model": "gpt-4.1-2025-04-14",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {
            "role": "assistant",
            "content": json.dumps({"status": "translated", "translation": ENGLISH}),
        }}],
    }


def adapter(handler, *, guard=None, credential=None):
    return AzureGPT41TranslationAdapter(
        AzureTranslationProfile(ENDPOINT, "gpt-4.1"),
        credential=cast(AsyncTokenCredential, credential or Credential()),
        endpoint_guard=guard or Guard(), transport=httpx.MockTransport(handler),
    )


@pytest.mark.asyncio
async def test_actual_http_contract_preserves_fixed_direction_and_minimal_payload() -> None:
    requests = []
    credential, guard = Credential(), Guard()

    def handler(request):
        requests.append(request)
        assert str(request.url) == ENDPOINT + "/chat/completions"
        assert request.headers["authorization"] == "Bearer synthetic-token"
        payload = json.loads(request.content)
        assert payload["model"] == "gpt-4.1"
        assert payload["store"] is False and payload["stream"] is False
        assert "tools" not in payload
        assert len(payload["messages"]) == 2
        assert SOURCE not in payload["messages"][0]["content"]
        assert json.loads(payload["messages"][1]["content"]) == {
            "source_locale": "es-US", "target_locale": "en-US", "transcript_segment": SOURCE,
        }
        assert payload["response_format"]["json_schema"]["strict"] is True
        return httpx.Response(200, json=body())

    result = await adapter(handler, guard=guard, credential=credential).translate(
        SpanishToEnglishTranslationRequest(SOURCE)
    )
    assert result.content == ENGLISH
    assert ENGLISH not in repr(result)
    assert len(requests) == credential.calls == guard.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [302, 400, 401, 403, 404, 408, 422, 429, 500, 503])
async def test_http_failure_never_retries_redirects_or_exposes_provider_body(status) -> None:
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, text=SOURCE, headers={"Location": "https://elsewhere.test"})

    with pytest.raises(TranslationAdapterError) as caught:
        await adapter(handler).translate(SpanishToEnglishTranslationRequest(SOURCE))
    assert len(requests) == 1
    assert SOURCE not in str(caught.value)
    assert caught.value.__context__ is None


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", [
    lambda b: b.update(model="different-model"),
    lambda b: b["choices"].append(b["choices"][0]),
    lambda b: b["choices"][0].update(index=False),
    lambda b: b["choices"][0].update(finish_reason="length"),
    lambda b: b["choices"][0]["message"].update(refusal="refused"),
    lambda b: b["choices"][0]["message"].update(tool_calls=[{"name": "send"}]),
    lambda b: b["choices"][0]["message"].update(role="user"),
    lambda b: b["choices"][0]["message"].update(content="not JSON"),
    lambda b: b["choices"][0]["message"].update(content='{"status":"translated","translation":""}'),
    lambda b: b["choices"][0]["message"].update(content=json.dumps({
        "status": "translated", "translation": ENGLISH, "note_ready": True,
    })),
    lambda b: b["choices"][0]["message"].update(content=(
        '{"status":"translated","translation":"one","translation":"two"}'
    )),
])
async def test_invalid_provider_result_cannot_enter_working_transcript(mutation) -> None:
    response = body()
    mutation(response)
    with pytest.raises(TranslationAdapterError) as caught:
        await adapter(lambda _: httpx.Response(200, json=response)).translate(
            SpanishToEnglishTranslationRequest(SOURCE)
        )
    assert caught.value.code == TranslationAdapterFailureCode.RESPONSE_INVALID


@pytest.mark.asyncio
async def test_guard_failure_precedes_credential_and_network_access() -> None:
    credential = Credential()
    requests = []
    with pytest.raises(TranslationAdapterError):
        await adapter(lambda r: requests.append(r), credential=credential,
                      guard=Guard(RuntimeError("private endpoint unavailable"))).translate(
            SpanishToEnglishTranslationRequest(SOURCE)
        )
    assert not requests and credential.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["content_type", "oversized", "unable"])
async def test_bounded_response_and_declared_inability(kind) -> None:
    response = body()
    response["choices"][0]["message"]["content"] = json.dumps({
        "status": "unable_to_translate", "translation": None,
    })
    replies = {
        "content_type": httpx.Response(200, text=json.dumps(body())),
        "oversized": httpx.Response(200, content=b" " * 128_001,
                                    headers={"Content-Type": "application/json"}),
        "unable": httpx.Response(200, json=response),
    }
    with pytest.raises(TranslationAdapterError) as caught:
        await adapter(lambda _: replies[kind]).translate(SpanishToEnglishTranslationRequest(SOURCE))
    assert caught.value.code == (
        TranslationAdapterFailureCode.PROVIDER_REJECTED if kind == "unable"
        else TranslationAdapterFailureCode.RESPONSE_INVALID
    )


@pytest.mark.asyncio
async def test_timeout_is_bounded_and_cancellation_propagates() -> None:
    for error, expected in [(httpx.ReadTimeout("sensitive"), TranslationAdapterError),
                            (asyncio.CancelledError(), asyncio.CancelledError)]:
        def handler(_, failure=error):
            raise failure
        with pytest.raises(expected) as caught:
            await adapter(handler).translate(SpanishToEnglishTranslationRequest(SOURCE))
        if isinstance(caught.value, TranslationAdapterError):
            assert caught.value.code == TranslationAdapterFailureCode.PROVIDER_TIMEOUT


@pytest.mark.asyncio
async def test_provider_output_uses_existing_immutable_attempt_contract() -> None:
    configured = adapter(lambda _: httpx.Response(200, json=body()))
    attempt = await prepare_spanish_to_english_attempt(configured, _reservation())
    assert attempt.content == ENGLISH
    assert attempt.translation_adapter_id == configured.adapter_id
    assert attempt.translation_model_profile_id == configured.model_profile_id
    assert not hasattr(attempt, "note_ready")


@pytest.mark.parametrize("endpoint", [
    "http://synthetic-model.openai.azure.com/openai/v1",
    "https://synthetic-model.openai.azure.com.evil.test/openai/v1",
    "https://user@synthetic-model.openai.azure.com/openai/v1",
    ENDPOINT + "?redirect=other", ENDPOINT + "/", ENDPOINT + "#fragment",
])
def test_profile_rejects_alternate_destinations(endpoint) -> None:
    with pytest.raises(ValueError, match="translation_profile_invalid"):
        AzureTranslationProfile(endpoint, "gpt-4.1")


def test_profile_lineage_changes_with_deployment() -> None:
    profile = AzureTranslationProfile(ENDPOINT, "gpt-4.1")
    assert profile.profile_id == AzureTranslationProfile(ENDPOINT, "gpt-4.1").profile_id
    assert profile.profile_id != AzureTranslationProfile(ENDPOINT, "gpt-4.1-new").profile_id
    assert ENDPOINT not in repr(profile)
