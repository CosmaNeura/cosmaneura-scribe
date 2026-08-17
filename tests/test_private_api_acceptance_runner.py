from __future__ import annotations

import asyncio
import base64
import json
import logging
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from io import StringIO
from uuid import UUID

import httpx
import pytest
from azure.core.credentials import AccessToken
from cosmaneura_scribe import private_api_acceptance_runner
from cosmaneura_scribe.private_api_acceptance_runner import (
    EXPECTED_RESULT,
    MAX_RESPONSE_BYTES,
    PRIVATE_API_ACCEPTANCE_ENABLED_ENV,
    PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV,
    PrivateApiAcceptanceRunnerError,
    execute_private_api_acceptance,
    run_private_api_acceptance,
)
from cosmaneura_scribe.safe_logging import (
    LOGGER_NAME,
    configure_private_api_acceptance_logging,
    log_private_api_acceptance_readiness,
    log_private_api_acceptance_result,
)
from cosmaneura_scribe.settings import Settings
from pydantic import ValidationError

PLATFORM_CLIENT_ID = UUID("c7bae168-fbf5-4658-b0d9-dd4b5373a1be")
API_AUDIENCE = "57264fe1-6a4a-4946-8412-e0be18805977"
SYNTHETIC_TENANT_ID = UUID("00000000-0000-4000-8000-000000000001")
PRIVATE_API_IP = "10.42.2.8"


def _enabled_settings() -> Settings:
    return Settings(
        managed_identity_client_id=PLATFORM_CLIENT_ID,
        workflow_api_audience=API_AUDIENCE,
        private_api_acceptance_enabled=True,
        private_api_acceptance_invocation_enabled=True,
        private_api_acceptance_base_url="https://cosmaneura-scribe-dev-api.internal.example",
        private_api_acceptance_tenant_id=SYNTHETIC_TENANT_ID,
        private_api_acceptance_private_endpoint_cidrs=(f"{PRIVATE_API_IP}/32",),
    )


def _public_key_payload() -> dict[str, object]:
    modulus = base64.urlsafe_b64encode(b"\x01" * 384).decode().rstrip("=")
    return {
        "key_version": "synthetic-version-01",
        "algorithm": "RSA-OAEP-256",
        "public_jwk": {
            "kty": "RSA",
            "n": modulus,
            "e": "AQAB",
            "alg": "RSA-OAEP-256",
            "ext": True,
            "key_ops": ["wrapKey"],
        },
    }


class StaticCredential:
    def __init__(self, events: list[str] | None = None) -> None:
        self.scopes: list[str] = []
        self.closed = False
        self.events = events

    async def get_token(self, *scopes: str, **kwargs: object) -> AccessToken:
        del kwargs
        self.scopes.extend(scopes)
        if self.events is not None:
            self.events.append("token")
        return AccessToken("must-not-be-logged", int(datetime.now(UTC).timestamp()) + 300)

    async def close(self) -> None:
        self.closed = True
        if self.events is not None:
            self.events.append("credential_closed")


class ManualClock:
    def __init__(self) -> None:
        self.seconds = 0.0

    def __call__(self) -> float:
        return self.seconds

    async def sleep(self, seconds: float) -> None:
        self.seconds += seconds


async def _no_delay_sleep(_: float) -> None:
    return None


def _ready_client(
    handler: Callable[[httpx.Request], httpx.Response] | None = None,
) -> httpx.AsyncClient:
    transport_handler = handler or (lambda _: httpx.Response(200))
    return httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(transport_handler),
        trust_env=False,
        follow_redirects=False,
    )


@pytest.mark.asyncio
async def test_both_raw_gates_precede_settings_and_clients(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, object]] = []
    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_event",
        lambda **event: events.append(event),
    )

    def settings_factory() -> Settings:
        raise AssertionError("closed raw gates must not parse configuration")

    with pytest.raises(
        PrivateApiAcceptanceRunnerError,
        match="^private_api_acceptance_disabled$",
    ):
        await run_private_api_acceptance(
            environ={
                PRIVATE_API_ACCEPTANCE_ENABLED_ENV: "false",
                PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV: "true",
            },
            settings_factory=settings_factory,
            execute=lambda _: _unexpected_execution(),
        )
    with pytest.raises(
        PrivateApiAcceptanceRunnerError,
        match="^private_api_acceptance_invocation_disabled$",
    ):
        await run_private_api_acceptance(
            environ={
                PRIVATE_API_ACCEPTANCE_ENABLED_ENV: "true",
                PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV: "false",
            },
            settings_factory=settings_factory,
            execute=lambda _: _unexpected_execution(),
        )

    assert [event["error_class"] for event in events] == [
        "PrivateApiAcceptanceDisabled",
        "PrivateApiAcceptanceInvocationDisabled",
    ]


async def _unexpected_execution() -> object:
    raise AssertionError("closed raw gates must not resolve DNS or construct clients")


@pytest.mark.asyncio
async def test_runner_rejects_every_argument_before_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, object]] = []
    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_event",
        lambda **event: events.append(event),
    )

    with pytest.raises(PrivateApiAcceptanceRunnerError) as caught:
        await run_private_api_acceptance(
            arguments=["unsafe-override-value"],
            environ={
                PRIVATE_API_ACCEPTANCE_ENABLED_ENV: "true",
                PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV: "true",
            },
            settings_factory=lambda: (_ for _ in ()).throw(
                AssertionError("arguments must fail before settings")
            ),
        )

    assert str(caught.value) == "private_api_acceptance_arguments_invalid"
    assert "unsafe-override-value" not in repr(caught.value)
    assert events[-1]["error_class"] == "PrivateApiAcceptanceArgumentsInvalid"


@pytest.mark.asyncio
async def test_success_and_failure_each_emit_one_terminal_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    standard_events: list[dict[str, object]] = []
    result_events: list[dict[str, object]] = []
    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_event",
        lambda **event: standard_events.append(event),
    )
    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_private_api_acceptance_result",
        lambda **event: result_events.append(event),
    )
    environment = {
        PRIVATE_API_ACCEPTANCE_ENABLED_ENV: "true",
        PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV: "true",
    }

    async def succeed(_: Settings) -> object:
        return EXPECTED_RESULT

    assert (
        await run_private_api_acceptance(
            arguments=(),
            environ=environment,
            settings_factory=_enabled_settings,
            execute=succeed,  # type: ignore[arg-type]
        )
        == EXPECTED_RESULT
    )
    assert standard_events == []
    assert len(result_events) == 1

    result_events.clear()

    async def fail(_: Settings) -> object:
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_response_invalid")

    with pytest.raises(
        PrivateApiAcceptanceRunnerError,
        match="^private_api_acceptance_response_invalid$",
    ):
        await run_private_api_acceptance(
            arguments=(),
            environ=environment,
            settings_factory=_enabled_settings,
            execute=fail,  # type: ignore[arg-type]
        )
    assert len(standard_events) == 1
    assert standard_events[0]["action"] == "private_api_acceptance.failed"
    assert standard_events[0]["error_class"] == "PrivateApiAcceptanceResponseInvalid"
    assert result_events == []


@pytest.mark.asyncio
async def test_readiness_deadline_has_a_distinct_terminal_failure_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, object]] = []
    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_event",
        lambda **event: events.append(event),
    )

    async def fail(_: Settings) -> object:
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_readiness_deadline_exhausted")

    with pytest.raises(
        PrivateApiAcceptanceRunnerError,
        match="^private_api_acceptance_readiness_deadline_exhausted$",
    ):
        await run_private_api_acceptance(
            arguments=(),
            environ={
                PRIVATE_API_ACCEPTANCE_ENABLED_ENV: "true",
                PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV: "true",
            },
            settings_factory=_enabled_settings,
            execute=fail,  # type: ignore[arg-type]
        )

    assert len(events) == 1
    assert events[0]["error_class"] == ("PrivateApiAcceptanceReadinessDeadlineExhausted")


@pytest.mark.asyncio
async def test_cancellation_emits_one_terminal_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    standard_events: list[dict[str, object]] = []
    result_events: list[dict[str, object]] = []
    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_event",
        lambda **event: standard_events.append(event),
    )
    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_private_api_acceptance_result",
        lambda **event: result_events.append(event),
    )

    async def cancel(_: Settings) -> object:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_private_api_acceptance(
            arguments=(),
            environ={
                PRIVATE_API_ACCEPTANCE_ENABLED_ENV: "true",
                PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV: "true",
            },
            settings_factory=_enabled_settings,
            execute=cancel,  # type: ignore[arg-type]
        )

    assert len(standard_events) == 1
    assert standard_events[0]["action"] == "private_api_acceptance.cancelled"
    assert result_events == []


@pytest.mark.asyncio
async def test_private_api_proof_checks_dns_then_uses_exact_identity_scope_and_route() -> None:
    events: list[str] = []
    credential = StaticCredential(events)
    readiness_requests: list[httpx.Request] = []
    probe_requests: list[httpx.Request] = []

    async def resolver(hostname: str) -> tuple[str, ...]:
        assert hostname == "cosmaneura-scribe-dev-api.internal.example"
        events.append("dns")
        return (PRIVATE_API_IP,)

    def handler(request: httpx.Request) -> httpx.Response:
        events.append("http")
        probe_requests.append(request)
        return httpx.Response(200, json=_public_key_payload())

    def readiness_handler(request: httpx.Request) -> httpx.Response:
        events.append("readiness")
        readiness_requests.append(request)
        return httpx.Response(200, headers={"Set-Cookie": "must-not-cross-phases=1"})

    client = httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(handler),
        trust_env=False,
        follow_redirects=False,
    )
    result = await execute_private_api_acceptance(
        _enabled_settings(),
        credential=credential,
        client=client,
        readiness_client=_ready_client(readiness_handler),
        resolver=resolver,
        sleeper=_no_delay_sleep,
    )

    assert result == EXPECTED_RESULT
    assert events[:6] == ["dns", "readiness", "readiness", "dns", "token", "http"]
    assert credential.scopes == [f"api://{API_AUDIENCE}/.default"]
    assert credential.closed is True
    assert client.is_closed is True
    assert len(readiness_requests) == 2
    assert all(request.url.path == "/healthz" for request in readiness_requests)
    assert all("authorization" not in request.headers for request in readiness_requests)
    assert len(probe_requests) == 1
    assert probe_requests[0].method == "GET"
    assert probe_requests[0].url.path == "/v1/audio-encryption-key"
    assert probe_requests[0].headers["authorization"] == "Bearer must-not-be-logged"
    assert probe_requests[0].headers["x-tenant-id"] == str(SYNTHETIC_TENANT_ID)
    assert "cookie" not in probe_requests[0].headers
    assert probe_requests[0].content == b""


@pytest.mark.asyncio
async def test_probe_timeout_is_separate_from_the_bounded_readiness_phase(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _enabled_settings()
    credential = StaticCredential()
    captured_client_options: dict[str, object] = {}
    real_async_client = httpx.AsyncClient
    readiness_client = _ready_client()

    def client_factory(**options: object) -> httpx.AsyncClient:
        captured_client_options.update(options)
        return real_async_client(
            **options,
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json=_public_key_payload())
            ),
        )

    monkeypatch.setattr(private_api_acceptance_runner.httpx, "AsyncClient", client_factory)

    result = await execute_private_api_acceptance(
        settings,
        credential=credential,
        readiness_client=readiness_client,
        resolver=lambda _: _async_addresses(PRIVATE_API_IP),
        sleeper=_no_delay_sleep,
    )

    assert result == EXPECTED_RESULT
    assert settings.private_api_acceptance_timeout_seconds == 60
    assert settings.private_api_acceptance_readiness_deadline_seconds == 180
    assert settings.private_api_acceptance_readiness_poll_interval_seconds == 5
    assert captured_client_options["timeout"] == 60
    assert captured_client_options["trust_env"] is False
    assert captured_client_options["follow_redirects"] is False
    assert readiness_client.is_closed is True


@pytest.mark.asyncio
async def test_readiness_tolerates_platform_failures_and_requires_two_consecutive_200s(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = ManualClock()
    credential = StaticCredential()
    readiness_events: list[dict[str, object]] = []
    readiness_results: list[object] = [
        httpx.ConnectError("unsafe endpoint detail"),
        httpx.Response(503),
        httpx.Response(200),
        httpx.Response(502),
        httpx.Response(200),
        httpx.Response(200),
    ]
    requests: list[httpx.Request] = []

    def readiness_handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        result = readiness_results.pop(0)
        if isinstance(result, Exception):
            raise result
        assert isinstance(result, httpx.Response)
        return result

    def probe_handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=_public_key_payload())

    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_private_api_acceptance_readiness",
        lambda **event: readiness_events.append(event),
    )
    client = httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(probe_handler),
    )
    readiness_client = _ready_client(readiness_handler)

    result = await execute_private_api_acceptance(
        _enabled_settings(),
        credential=credential,
        client=client,
        readiness_client=readiness_client,
        resolver=lambda _: _async_addresses(PRIVATE_API_IP),
        clock=clock,
        sleeper=clock.sleep,
    )

    assert result == EXPECTED_RESULT
    assert [event["action"] for event in readiness_events] == [
        "private_api_acceptance.readiness_started",
        "private_api_acceptance.readiness_succeeded",
    ]
    assert readiness_events[-1] == {
        "action": "private_api_acceptance.readiness_succeeded",
        "poll_count": 6,
        "elapsed_ms": 25_000,
    }
    assert credential.scopes == [f"api://{API_AUDIENCE}/.default"]
    assert readiness_client.is_closed is True
    assert [request.url.path for request in requests] == ["/healthz"] * 6 + [
        "/v1/audio-encryption-key"
    ]
    assert all("authorization" not in request.headers for request in requests[:-1])


@pytest.mark.asyncio
async def test_readiness_deadline_is_fixed_token_free_and_closes_resources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = ManualClock()
    credential = StaticCredential()
    readiness_events: list[dict[str, object]] = []
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(503, text="unsafe gateway response")

    monkeypatch.setattr(
        private_api_acceptance_runner,
        "log_private_api_acceptance_readiness",
        lambda **event: readiness_events.append(event),
    )
    readiness_client = _ready_client(handler)

    with pytest.raises(
        PrivateApiAcceptanceRunnerError,
        match="^private_api_acceptance_readiness_deadline_exhausted$",
    ):
        await execute_private_api_acceptance(
            _enabled_settings(),
            credential=credential,
            readiness_client=readiness_client,
            resolver=lambda _: _async_addresses(PRIVATE_API_IP),
            clock=clock,
            sleeper=clock.sleep,
        )

    assert readiness_events == [
        {
            "action": "private_api_acceptance.readiness_started",
            "poll_count": 0,
            "elapsed_ms": 0,
        },
        {
            "action": "private_api_acceptance.readiness_deadline_exhausted",
            "poll_count": 36,
            "elapsed_ms": 180_000,
        },
    ]
    assert len(requests) == 36
    assert all(request.url.path == "/healthz" for request in requests)
    assert all("authorization" not in request.headers for request in requests)
    assert credential.scopes == []
    assert credential.closed is False
    assert readiness_client.is_closed is True


@pytest.mark.asyncio
async def test_readiness_cancellation_closes_only_the_active_unauthenticated_client() -> None:
    entered_readiness = asyncio.Event()
    never_complete = asyncio.Event()
    credential = StaticCredential()

    async def readiness_handler(_: httpx.Request) -> httpx.Response:
        entered_readiness.set()
        await never_complete.wait()
        raise AssertionError("cancelled readiness request must not complete")

    readiness_client = httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(readiness_handler),
        trust_env=False,
        follow_redirects=False,
    )
    task = asyncio.create_task(
        execute_private_api_acceptance(
            _enabled_settings(),
            credential=credential,
            readiness_client=readiness_client,
            resolver=lambda _: _async_addresses(PRIVATE_API_IP),
        )
    )
    await entered_readiness.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert readiness_client.is_closed is True
    assert credential.scopes == []
    assert credential.closed is False


@pytest.mark.asyncio
async def test_dns_must_resolve_only_to_the_exact_private_environment_ip() -> None:
    credential = StaticCredential()
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(500)))

    with pytest.raises(PrivateApiAcceptanceRunnerError) as caught:
        await execute_private_api_acceptance(
            _enabled_settings(),
            credential=credential,
            client=client,
            resolver=lambda _: _async_addresses("10.42.2.9", "8.8.8.8"),
        )

    assert str(caught.value) == "private_api_acceptance_private_endpoint_unavailable"
    assert credential.scopes == []
    assert credential.closed is False
    assert client.is_closed is False


@pytest.mark.asyncio
async def test_dns_is_rechecked_after_readiness_before_any_token_or_probe() -> None:
    credential = StaticCredential()
    probe_requests: list[httpx.Request] = []
    resolved = iter(((PRIVATE_API_IP,), ("10.42.2.9",)))
    readiness_client = _ready_client()
    probe_client = httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(
            lambda request: probe_requests.append(request) or httpx.Response(500)
        ),
    )

    with pytest.raises(
        PrivateApiAcceptanceRunnerError,
        match="^private_api_acceptance_private_endpoint_unavailable$",
    ):
        await execute_private_api_acceptance(
            _enabled_settings(),
            credential=credential,
            client=probe_client,
            readiness_client=readiness_client,
            resolver=lambda _: _async_addresses(*next(resolved)),
            sleeper=_no_delay_sleep,
        )

    assert credential.scopes == []
    assert credential.closed is False
    assert probe_requests == []
    assert readiness_client.is_closed is True
    assert probe_client.is_closed is False


async def _async_addresses(*addresses: str) -> tuple[str, ...]:
    return addresses


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "expected_code"),
    [
        (
            httpx.Response(403, text="sensitive authorization response"),
            "private_api_acceptance_http_rejected",
        ),
        (
            httpx.Response(
                200,
                content=b"{" + b"x" * MAX_RESPONSE_BYTES + b"}",
                headers={"Content-Type": "application/json"},
            ),
            "private_api_acceptance_response_too_large",
        ),
        (
            httpx.Response(
                200,
                json={"unsafe": "sensitive modulus and key version"},
            ),
            "private_api_acceptance_response_invalid",
        ),
        (
            httpx.Response(
                200,
                content=json.dumps(_public_key_payload()).encode(),
                headers={"Content-Type": "text/plain"},
            ),
            "private_api_acceptance_response_invalid",
        ),
        (
            httpx.Response(
                200,
                json=_public_key_payload() | {"unexpected": "sensitive extra field"},
            ),
            "private_api_acceptance_response_invalid",
        ),
    ],
)
async def test_response_failures_are_fixed_and_never_echo_body(
    response: httpx.Response,
    expected_code: str,
) -> None:
    credential = StaticCredential()
    client = httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(lambda _: response),
    )

    with pytest.raises(PrivateApiAcceptanceRunnerError) as caught:
        await execute_private_api_acceptance(
            _enabled_settings(),
            credential=credential,
            client=client,
            readiness_client=_ready_client(),
            resolver=lambda _: _async_addresses(PRIVATE_API_IP),
            sleeper=_no_delay_sleep,
        )

    assert str(caught.value) == expected_code
    assert "sensitive" not in repr(caught.value)
    assert credential.closed is True
    assert client.is_closed is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        _public_key_payload() | {"unexpected": "forbidden"},
        _public_key_payload() | {"key_version": ""},
        _public_key_payload() | {"algorithm": "RSA-OAEP"},
        _public_key_payload()
        | {
            "public_jwk": _public_key_payload()["public_jwk"] | {"kty": "EC"}  # type: ignore[operator]
        },
        _public_key_payload()
        | {
            "public_jwk": _public_key_payload()["public_jwk"] | {"alg": "RSA-OAEP"}  # type: ignore[operator]
        },
        _public_key_payload()
        | {
            "public_jwk": _public_key_payload()["public_jwk"]
            | {"n": base64.urlsafe_b64encode(b"\x01" * 383).decode().rstrip("=")}  # type: ignore[operator]
        },
        _public_key_payload()
        | {
            "public_jwk": _public_key_payload()["public_jwk"] | {"key_ops": ["wrapKey", "wrapKey"]}  # type: ignore[operator]
        },
        _public_key_payload()
        | {
            "public_jwk": _public_key_payload()["public_jwk"] | {"unexpected": "forbidden"}  # type: ignore[operator]
        },
    ],
)
async def test_schema_rejects_extra_fields_and_nonexact_operations(
    payload: dict[str, object],
) -> None:
    credential = StaticCredential()
    client = httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload)),
    )

    with pytest.raises(
        PrivateApiAcceptanceRunnerError,
        match="^private_api_acceptance_response_invalid$",
    ):
        await execute_private_api_acceptance(
            _enabled_settings(),
            credential=credential,
            client=client,
            readiness_client=_ready_client(),
            resolver=lambda _: _async_addresses(PRIVATE_API_IP),
            sleeper=_no_delay_sleep,
        )

    assert credential.closed is True
    assert client.is_closed is True


@pytest.mark.asyncio
async def test_request_cancellation_closes_http_and_identity_clients() -> None:
    entered_request = asyncio.Event()
    never_complete = asyncio.Event()
    credential = StaticCredential()

    async def handler(_: httpx.Request) -> httpx.Response:
        entered_request.set()
        await never_complete.wait()
        raise AssertionError("cancelled request must not complete")

    client = httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(handler),
    )
    task = asyncio.create_task(
        execute_private_api_acceptance(
            _enabled_settings(),
            credential=credential,
            client=client,
            readiness_client=_ready_client(),
            resolver=lambda _: _async_addresses(PRIVATE_API_IP),
            sleeper=_no_delay_sleep,
        )
    )
    await entered_request.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert credential.closed is True
    assert client.is_closed is True


@pytest.mark.asyncio
async def test_cleanup_failure_is_fixed_and_sanitized() -> None:
    class FailingCloseCredential(StaticCredential):
        async def close(self) -> None:
            raise RuntimeError("sensitive identity cleanup detail")

    credential = FailingCloseCredential()
    client = httpx.AsyncClient(
        base_url="https://cosmaneura-scribe-dev-api.internal.example",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, json=_public_key_payload())),
    )

    with pytest.raises(PrivateApiAcceptanceRunnerError) as caught:
        await execute_private_api_acceptance(
            _enabled_settings(),
            credential=credential,
            client=client,
            readiness_client=_ready_client(),
            resolver=lambda _: _async_addresses(PRIVATE_API_IP),
            sleeper=_no_delay_sleep,
        )

    assert str(caught.value) == "private_api_acceptance_cleanup_failed"
    assert "sensitive" not in repr(caught.value)
    assert client.is_closed is True


def test_completed_log_contains_only_fixed_acceptance_metadata() -> None:
    stream = StringIO()
    logger = logging.getLogger(LOGGER_NAME)
    previous_handlers = list(logger.handlers)
    previous_level = logger.level
    previous_propagate = logger.propagate
    handler = logging.StreamHandler(stream)
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        log_private_api_acceptance_result(duration_ms=12.5)
    finally:
        logger.handlers = previous_handlers
        logger.setLevel(previous_level)
        logger.propagate = previous_propagate

    payload = json.loads(stream.getvalue())
    assert payload == {
        "action": "private_api_acceptance.completed",
        "algorithm": "RSA-OAEP-256",
        "duration_ms": 12.5,
        "http_status": 200,
        "key_operations": ["wrapKey"],
        "key_size_bits": 3072,
        "kty": "RSA",
        "key_version_present": True,
    }
    assert "must-not-be-logged" not in stream.getvalue()
    assert "synthetic-version-01" not in stream.getvalue()
    assert str(SYNTHETIC_TENANT_ID) not in stream.getvalue()


def test_readiness_logs_have_one_closed_numeric_schema() -> None:
    stream = StringIO()
    logger = logging.getLogger(LOGGER_NAME)
    previous_handlers = list(logger.handlers)
    previous_level = logger.level
    previous_propagate = logger.propagate
    handler = logging.StreamHandler(stream)
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        log_private_api_acceptance_readiness(
            action="private_api_acceptance.readiness_succeeded",
            poll_count=6,
            elapsed_ms=25_000.125,
        )
    finally:
        logger.handlers = previous_handlers
        logger.setLevel(previous_level)
        logger.propagate = previous_propagate

    assert json.loads(stream.getvalue()) == {
        "action": "private_api_acceptance.readiness_succeeded",
        "elapsed_ms": 25_000.125,
        "error_class": None,
        "poll_count": 6,
    }
    assert "http" not in stream.getvalue().casefold()
    assert PRIVATE_API_IP not in stream.getvalue()
    assert str(SYNTHETIC_TENANT_ID) not in stream.getvalue()

    for invalid_poll_count in (True, 1.5, -1, 37):
        with pytest.raises(ValueError, match="bounded nonnegative integer"):
            log_private_api_acceptance_readiness(
                action="private_api_acceptance.readiness_succeeded",
                poll_count=invalid_poll_count,
                elapsed_ms=1,
            )
    with pytest.raises(ValueError, match="fixed safe label"):
        log_private_api_acceptance_readiness(
            action="unsafe.endpoint",
            poll_count=1,
            elapsed_ms=1,
        )


def test_acceptance_logging_suppresses_third_party_warning_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream = StringIO()
    sentinel = "https://unsafe.example token-body-must-not-appear"
    safe_logger = logging.getLogger(LOGGER_NAME)
    root = logging.getLogger()
    azure_logger = logging.getLogger("azure.identity.aio._internal.decorators")
    external_loggers = [logging.getLogger(name) for name in ("azure", "httpcore", "httpx")]
    saved_safe = (list(safe_logger.handlers), safe_logger.level, safe_logger.propagate)
    saved_root = (list(root.handlers), root.level)
    saved_externals = [
        (list(logger.handlers), logger.level, logger.propagate, logger.disabled)
        for logger in external_loggers
    ]
    saved_azure = (
        list(azure_logger.handlers),
        azure_logger.level,
        azure_logger.propagate,
        azure_logger.disabled,
    )
    monkeypatch.setattr(sys, "stderr", stream)
    safe_logger.handlers.clear()
    try:
        configure_private_api_acceptance_logging()
        azure_logger.warning(sentinel)
        private_api_acceptance_runner.log_event(
            action="private_api_acceptance.failed",
            error_class="PrivateApiAcceptanceIdentityUnavailable",
        )
    finally:
        safe_logger.handlers, safe_logger.level, safe_logger.propagate = saved_safe
        root.handlers, root.level = saved_root
        for logger, state in zip(external_loggers, saved_externals, strict=True):
            logger.handlers, logger.level, logger.propagate, logger.disabled = state
        (
            azure_logger.handlers,
            azure_logger.level,
            azure_logger.propagate,
            azure_logger.disabled,
        ) = saved_azure

    lines = stream.getvalue().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["error_class"] == ("PrivateApiAcceptanceIdentityUnavailable")
    assert sentinel not in stream.getvalue()


def test_settings_require_all_three_gates_and_one_exact_private_host() -> None:
    assert Settings().private_api_acceptance_timeout_seconds == 60
    assert Settings().private_api_acceptance_readiness_deadline_seconds == 180
    assert Settings().private_api_acceptance_readiness_poll_interval_seconds == 5
    with pytest.raises(ValidationError, match="less than or equal to 60"):
        Settings(private_api_acceptance_timeout_seconds=60.1)
    for invalid_deadline in (179, 181):
        with pytest.raises(ValidationError, match="Input should be 180"):
            Settings(private_api_acceptance_readiness_deadline_seconds=invalid_deadline)
    for invalid_interval in (4, 6):
        with pytest.raises(ValidationError, match="Input should be 5"):
            Settings(private_api_acceptance_readiness_poll_interval_seconds=invalid_interval)
    with pytest.raises(ValidationError, match="requires private_api_acceptance_enabled"):
        Settings(private_api_acceptance_invocation_enabled=True)
    with pytest.raises(ValidationError, match="requires its base URL"):
        Settings(private_api_acceptance_enabled=True)
    with pytest.raises(ValidationError, match="one exact private environment host CIDR"):
        Settings(
            managed_identity_client_id=PLATFORM_CLIENT_ID,
            workflow_api_audience=API_AUDIENCE,
            private_api_acceptance_enabled=True,
            private_api_acceptance_base_url="https://api.internal.example",
            private_api_acceptance_tenant_id=SYNTHETIC_TENANT_ID,
            private_api_acceptance_private_endpoint_cidrs=("10.42.2.0/24",),
        )
