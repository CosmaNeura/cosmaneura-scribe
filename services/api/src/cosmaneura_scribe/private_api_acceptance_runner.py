from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from ipaddress import ip_address
from time import perf_counter
from typing import Any, Protocol, cast
from urllib.parse import urlsplit

import httpx
from azure.core.credentials import AccessToken
from azure.core.exceptions import AzureError
from azure.identity.aio import ManagedIdentityCredential
from pydantic import ValidationError

from .safe_logging import (
    configure_private_api_acceptance_logging,
    log_event,
    log_private_api_acceptance_readiness,
    log_private_api_acceptance_result,
)
from .schemas import AudioEncryptionPublicKey
from .settings import Settings, get_settings

PRIVATE_API_ACCEPTANCE_ENABLED_ENV = "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_ENABLED"
PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV = (
    "COSMANEURA_SCRIBE_PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED"
)
MAX_RESPONSE_BYTES = 8 * 1024


class AcceptanceCredential(Protocol):
    async def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken: ...

    async def close(self) -> None: ...


@dataclass(frozen=True)
class PrivateApiAcceptanceResult:
    status_code: int
    kty: str
    algorithm: str
    key_size_bits: int
    key_operations: tuple[str, ...]
    key_version_present: bool


EXPECTED_RESULT = PrivateApiAcceptanceResult(
    status_code=200,
    kty="RSA",
    algorithm="RSA-OAEP-256",
    key_size_bits=3072,
    key_operations=("wrapKey",),
    key_version_present=True,
)

_ERROR_CLASSES = {
    "private_api_acceptance_arguments_invalid": "PrivateApiAcceptanceArgumentsInvalid",
    "private_api_acceptance_cleanup_failed": "PrivateApiAcceptanceCleanupFailed",
    "private_api_acceptance_configuration_invalid": "PrivateApiAcceptanceConfigurationInvalid",
    "private_api_acceptance_http_rejected": "PrivateApiAcceptanceHttpRejected",
    "private_api_acceptance_identity_unavailable": "PrivateApiAcceptanceIdentityUnavailable",
    "private_api_acceptance_network_unavailable": "PrivateApiAcceptanceNetworkUnavailable",
    "private_api_acceptance_private_endpoint_unavailable": (
        "PrivateApiAcceptancePrivateEndpointUnavailable"
    ),
    "private_api_acceptance_readiness_deadline_exhausted": (
        "PrivateApiAcceptanceReadinessDeadlineExhausted"
    ),
    "private_api_acceptance_response_invalid": "PrivateApiAcceptanceResponseInvalid",
    "private_api_acceptance_response_too_large": "PrivateApiAcceptanceResponseTooLarge",
}

SettingsFactory = Callable[[], Settings]
AcceptanceExecution = Callable[[Settings], Awaitable[PrivateApiAcceptanceResult]]
JobRun = Callable[[], Awaitable[PrivateApiAcceptanceResult]]
AddressResolver = Callable[[str], Awaitable[Sequence[str]]]
Clock = Callable[[], float]
Sleeper = Callable[[float], Awaitable[None]]


class PrivateApiAcceptanceRunnerError(RuntimeError):
    """Fixed-code failure safe for the one-shot operational boundary."""


def _raw_gate_enabled(environ: Mapping[str, str], name: str) -> bool:
    value = environ.get(name)
    return value is not None and value.strip().casefold() == "true"


async def run_private_api_acceptance(
    *,
    arguments: Sequence[str] | None = None,
    environ: Mapping[str, str] | None = None,
    settings_factory: SettingsFactory | None = None,
    execute: AcceptanceExecution | None = None,
) -> PrivateApiAcceptanceResult:
    """Prove the authenticated private key route without exposing its response."""

    source = os.environ if environ is None else environ
    if not _raw_gate_enabled(source, PRIVATE_API_ACCEPTANCE_ENABLED_ENV):
        log_event(
            action="private_api_acceptance.disabled",
            error_class="PrivateApiAcceptanceDisabled",
        )
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_disabled")
    if not _raw_gate_enabled(source, PRIVATE_API_ACCEPTANCE_INVOCATION_ENABLED_ENV):
        log_event(
            action="private_api_acceptance.invocation_disabled",
            error_class="PrivateApiAcceptanceInvocationDisabled",
        )
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_invocation_disabled")

    started_at = perf_counter()
    try:
        if sys.argv[1:] if arguments is None else arguments:
            raise PrivateApiAcceptanceRunnerError("private_api_acceptance_arguments_invalid")
        try:
            settings = (settings_factory or get_settings)()
        except Exception:
            raise PrivateApiAcceptanceRunnerError(
                "private_api_acceptance_configuration_invalid"
            ) from None
        if not settings.private_api_acceptance_enabled:
            raise PrivateApiAcceptanceRunnerError("private_api_acceptance_configuration_invalid")
        if not settings.private_api_acceptance_invocation_enabled:
            raise PrivateApiAcceptanceRunnerError("private_api_acceptance_configuration_invalid")

        result = await (execute or execute_private_api_acceptance)(settings)
        if result != EXPECTED_RESULT:
            raise PrivateApiAcceptanceRunnerError("private_api_acceptance_response_invalid")
        log_private_api_acceptance_result(duration_ms=(perf_counter() - started_at) * 1000)
        return result
    except asyncio.CancelledError:
        log_event(
            action="private_api_acceptance.cancelled",
            error_class="CancelledError",
            duration_ms=(perf_counter() - started_at) * 1000,
        )
        raise
    except PrivateApiAcceptanceRunnerError as exc:
        log_event(
            action="private_api_acceptance.failed",
            error_class=_ERROR_CLASSES.get(str(exc), "PrivateApiAcceptanceExecutionFailed"),
            duration_ms=(perf_counter() - started_at) * 1000,
        )
        raise
    except Exception:
        log_event(
            action="private_api_acceptance.failed",
            error_class="PrivateApiAcceptanceExecutionFailed",
            duration_ms=(perf_counter() - started_at) * 1000,
        )
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_execution_failed") from None


async def execute_private_api_acceptance(
    settings: Settings,
    *,
    credential: AcceptanceCredential | None = None,
    client: httpx.AsyncClient | None = None,
    readiness_client: httpx.AsyncClient | None = None,
    resolver: AddressResolver | None = None,
    clock: Clock | None = None,
    sleeper: Sleeper | None = None,
) -> PrivateApiAcceptanceResult:
    if (
        settings.managed_identity_client_id is None
        or settings.workflow_api_audience is None
        or settings.private_api_acceptance_base_url is None
        or settings.private_api_acceptance_tenant_id is None
        or not settings.private_api_acceptance_private_endpoint_cidrs
    ):
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_configuration_invalid")
    await _verify_private_api_dns(settings, resolver=resolver)

    base_url = str(settings.private_api_acceptance_base_url).rstrip("/")
    active_readiness_client = readiness_client or httpx.AsyncClient(
        base_url=base_url,
        timeout=settings.private_api_acceptance_timeout_seconds,
        trust_env=False,
        follow_redirects=False,
    )
    try:
        await _wait_for_private_api_readiness(
            settings,
            active_readiness_client,
            clock=clock or perf_counter,
            sleeper=sleeper or asyncio.sleep,
        )
    finally:
        await _close_without_cancellation(active_readiness_client, None)

    await _verify_private_api_dns(settings, resolver=resolver)
    active_client = client or httpx.AsyncClient(
        base_url=base_url,
        timeout=settings.private_api_acceptance_timeout_seconds,
        trust_env=False,
        follow_redirects=False,
    )
    active_credential = credential
    try:
        if active_credential is None:
            active_credential = ManagedIdentityCredential(
                client_id=str(settings.managed_identity_client_id)
            )
        try:
            access_token = await active_credential.get_token(
                f"api://{settings.workflow_api_audience}/.default"
            )
        except AzureError:
            raise PrivateApiAcceptanceRunnerError(
                "private_api_acceptance_identity_unavailable"
            ) from None

        try:
            async with asyncio.timeout(settings.private_api_acceptance_timeout_seconds):
                async with active_client.stream(
                    "GET",
                    "/v1/audio-encryption-key",
                    headers={
                        "Authorization": f"Bearer {access_token.token}",
                        "X-Tenant-ID": str(settings.private_api_acceptance_tenant_id),
                    },
                ) as response:
                    return await _validated_result(response)
        except (TimeoutError, httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError):
            raise PrivateApiAcceptanceRunnerError(
                "private_api_acceptance_network_unavailable"
            ) from None
    finally:
        await _close_without_cancellation(active_client, active_credential)


async def _wait_for_private_api_readiness(
    settings: Settings,
    client: httpx.AsyncClient,
    *,
    clock: Clock,
    sleeper: Sleeper,
) -> None:
    deadline_seconds = settings.private_api_acceptance_readiness_deadline_seconds
    poll_interval_seconds = settings.private_api_acceptance_readiness_poll_interval_seconds
    started_at = clock()
    polls = 0
    consecutive_ready = 0
    log_private_api_acceptance_readiness(
        action="private_api_acceptance.readiness_started",
        poll_count=0,
        elapsed_ms=0,
    )

    try:
        async with asyncio.timeout(deadline_seconds):
            while True:
                elapsed_seconds = clock() - started_at
                remaining_seconds = deadline_seconds - elapsed_seconds
                if remaining_seconds <= 0:
                    raise TimeoutError

                polls += 1
                ready = False
                try:
                    async with client.stream(
                        "GET",
                        "/healthz",
                        timeout=min(
                            settings.private_api_acceptance_timeout_seconds,
                            remaining_seconds,
                        ),
                    ) as response:
                        ready = response.status_code == 200
                except (httpx.TimeoutException, httpx.NetworkError, httpx.ProtocolError):
                    ready = False

                elapsed_seconds = clock() - started_at
                if elapsed_seconds >= deadline_seconds:
                    raise TimeoutError

                if ready:
                    consecutive_ready += 1
                else:
                    consecutive_ready = 0
                if consecutive_ready == 2:
                    log_private_api_acceptance_readiness(
                        action="private_api_acceptance.readiness_succeeded",
                        poll_count=polls,
                        elapsed_ms=elapsed_seconds * 1000,
                    )
                    return

                remaining_seconds = deadline_seconds - elapsed_seconds
                await sleeper(min(poll_interval_seconds, remaining_seconds))
    except TimeoutError:
        elapsed_seconds = clock() - started_at
        log_private_api_acceptance_readiness(
            action="private_api_acceptance.readiness_deadline_exhausted",
            poll_count=polls,
            elapsed_ms=elapsed_seconds * 1000,
        )
        raise PrivateApiAcceptanceRunnerError(
            "private_api_acceptance_readiness_deadline_exhausted"
        ) from None


async def _validated_result(response: httpx.Response) -> PrivateApiAcceptanceResult:
    if response.status_code != 200:
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_http_rejected")
    content_type = response.headers.get("content-type", "").partition(";")[0]
    if content_type.strip().casefold() != "application/json":
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_response_invalid")

    content = bytearray()
    async for chunk in response.aiter_bytes():
        if len(content) + len(chunk) > MAX_RESPONSE_BYTES:
            raise PrivateApiAcceptanceRunnerError("private_api_acceptance_response_too_large")
        content.extend(chunk)
    try:
        payload = json.loads(content.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError
        untyped_payload = cast(dict[object, object], payload)
        if not all(isinstance(key, str) for key in untyped_payload):
            raise ValueError
        object_payload = {cast(str, key): value for key, value in untyped_payload.items()}
        if set(object_payload) != {
            "key_version",
            "algorithm",
            "public_jwk",
        }:
            raise ValueError
        public_key = AudioEncryptionPublicKey.model_validate(object_payload)
    except (UnicodeDecodeError, ValueError, ValidationError):
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_response_invalid") from None
    if public_key.public_jwk.key_ops != ("wrapKey",):
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_response_invalid")
    return EXPECTED_RESULT


async def _resolve_addresses(hostname: str) -> tuple[str, ...]:
    loop = asyncio.get_running_loop()
    records = await loop.getaddrinfo(
        hostname,
        443,
        family=socket.AF_UNSPEC,
        type=socket.SOCK_STREAM,
        proto=socket.IPPROTO_TCP,
    )
    return tuple(str(record[4][0]) for record in records)


async def _verify_private_api_dns(
    settings: Settings,
    *,
    resolver: AddressResolver | None = None,
) -> None:
    if settings.private_api_acceptance_base_url is None:
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_configuration_invalid")
    hostname = urlsplit(str(settings.private_api_acceptance_base_url)).hostname
    allowed_networks = settings.private_api_acceptance_private_endpoint_cidrs
    if hostname is None or len(allowed_networks) != 1:
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_configuration_invalid")
    try:
        resolved = await (resolver or _resolve_addresses)(hostname)
        addresses = tuple(ip_address(value.split("%", maxsplit=1)[0]) for value in resolved)
    except (OSError, UnicodeError, ValueError):
        raise PrivateApiAcceptanceRunnerError(
            "private_api_acceptance_private_endpoint_unavailable"
        ) from None
    if not addresses or any(
        not address.is_private
        or address.version != allowed_networks[0].version
        or address not in allowed_networks[0]
        for address in addresses
    ):
        raise PrivateApiAcceptanceRunnerError("private_api_acceptance_private_endpoint_unavailable")


async def _close_without_cancellation(
    client: httpx.AsyncClient,
    credential: AcceptanceCredential | None,
) -> None:
    async def close_all() -> None:
        failed = False
        closes = [client.aclose]
        if credential is not None:
            closes.append(credential.close)
        for close in closes:
            try:
                await close()
            except Exception:
                failed = True
        if failed:
            raise PrivateApiAcceptanceRunnerError("private_api_acceptance_cleanup_failed")

    task = asyncio.create_task(close_all())
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


def _install_signal_handlers(
    loop: asyncio.AbstractEventLoop,
    task: asyncio.Task[PrivateApiAcceptanceResult],
) -> tuple[signal.Signals, ...]:
    installed: list[signal.Signals] = []
    for received_signal in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(received_signal, task.cancel)
        except (NotImplementedError, RuntimeError):
            continue
        installed.append(received_signal)
    return tuple(installed)


async def _run_with_signal_cancellation(
    run: JobRun | None = None,
) -> PrivateApiAcceptanceResult:
    async def invoke() -> PrivateApiAcceptanceResult:
        return await (run or run_private_api_acceptance)()

    task = asyncio.create_task(invoke())
    loop = asyncio.get_running_loop()
    installed = _install_signal_handlers(loop, task)
    try:
        return await task
    finally:
        for received_signal in installed:
            loop.remove_signal_handler(received_signal)


def main() -> None:
    configure_private_api_acceptance_logging()
    try:
        asyncio.run(_run_with_signal_cancellation())
    except asyncio.CancelledError:
        raise SystemExit(130) from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except PrivateApiAcceptanceRunnerError:
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
