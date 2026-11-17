"""Explicit fixed-origin activation of the verified account; no visit authority."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from uuid import UUID

import httpx
from pydantic import SecretStr

from .provider_account_setup import checked_setup
from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import (
    ProviderCoreUnavailable,
    core_wire_object,
    core_wire_require,
    core_wire_secret,
    provider_cookie_jar,
)

PATH = "/service/v1/agent/scribe/activation"


def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        core_wire_require(name not in result)
        result[name] = value
    return result


class ProviderActivationTransport:
    def __init__(
        self,
        origin: str,
        verify: Callable[[str], Awaitable[dict[str, object]]],
        workload: Callable[[], Awaitable[SecretStr]],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        connections: ProviderCoreConnections | None = None,
    ):
        url = httpx.URL(origin)
        core_wire_require(
            url.scheme == "https"
            and bool(url.host)
            and not url.userinfo
            and url.path == "/"
            and not url.query
            and not url.fragment
        )
        self.origin, self.verify, self.workload = origin.rstrip("/"), verify, workload
        self.client = httpx.AsyncClient(
            transport=connections.borrow(origin) if connections else transport,
            trust_env=False,
            follow_redirects=False,
            cookies=provider_cookie_jar(),
            timeout=httpx.Timeout(20, connect=5),
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def request(
        self, authorization: str, body: dict[str, object], key: str
    ) -> dict[str, object]:
        try:
            core_wire_require(
                set(body) == {"action", "request_nonce"} and body["action"] == "activate"
            )
            nonce = body["request_nonce"]
            core_wire_require(isinstance(nonce, str))
            assert isinstance(nonce, str)
            for value in (nonce, key):
                core_wire_require(str(UUID(value)) == value and UUID(value).int != 0)
            core_wire_require(authorization.startswith("Bearer "))
            token = core_wire_secret(SecretStr(authorization[7:]))
            async with asyncio.timeout(30):
                before = await self.verify(token)
                workload = core_wire_secret(await self.workload())
                async with self.client.stream(
                    "POST",
                    self.origin + PATH,
                    json=body,
                    headers={
                        "Authorization": "Bearer " + token,
                        "X-Cosmaneura-Workload-Authorization": "Bearer " + workload,
                        "X-Cosmaneura-Record-Version": "1",
                        "Idempotency-Key": key,
                        "Content-Type": "application/json",
                    },
                ) as response:
                    if response.status_code in {401, 403}:
                        raise ProviderCoreUnavailable(
                            "core_provider_access_unavailable", response.status_code
                        )
                    core_wire_require(
                        response.status_code in {200, 409}
                        and response.headers.get_list("x-cosmaneura-record-version") == ["1"]
                        and response.headers.get("cache-control") == "no-store"
                        and not response.headers.get_list("set-cookie")
                        and response.headers.get("content-type", "").split(";", 1)[0]
                        == (
                            "application/problem+json"
                            if response.status_code == 409
                            else "application/json"
                        )
                    )
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        core_wire_require(len(raw) + len(chunk) <= 1024)
                        raw.extend(chunk)
                value = core_wire_object(
                    json.loads(
                        raw,
                        object_pairs_hook=unique,
                        parse_constant=lambda _: core_wire_require(False),
                    )
                )
                if response.status_code == 409:
                    setup = checked_setup(value, nonce)
                    core_wire_require(setup.setup == "practice")
                    core_wire_require(await self.verify(token) == before)
                    raise setup
                core_wire_require(
                    set(value) == {"contract_version", "action", "request_nonce", "state"}
                    and value["contract_version"] == "1"
                    and value["action"] == "activate"
                    and value["request_nonce"] == nonce
                    and value["state"] == "active"
                )
                core_wire_require(await self.verify(token) == before)
                return value
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_activation_unconfirmed", 503) from None
