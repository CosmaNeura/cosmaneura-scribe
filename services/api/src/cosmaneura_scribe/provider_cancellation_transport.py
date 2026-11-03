"""Fixed self-account cancellation transport; no encounter or tenant selection."""

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from datetime import datetime
from uuid import UUID

import httpx
from pydantic import SecretStr

from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import ProviderCoreUnavailable, provider_cookie_jar

PATH = "/service/v1/agent/scribe/cancellation"
BASE = {
    "contract_version",
    "action",
    "request_nonce",
    "grace_days",
    "phi_scope",
    "scope",
    "shared_login_preserved",
    "resource_manifest_status",
}


def require(value) -> None:
    if not value:
        raise ValueError("cancellation_contract_invalid")


def uuid(value) -> None:
    require(isinstance(value, str) and str(UUID(value)) == value and UUID(value).int != 0)


def unique(pairs):
    result = {}
    for name, value in pairs:
        require(name not in result)
        result[name] = value
    return result


def validate_request(body: dict, key: str) -> None:
    require(type(body) is dict and len(json.dumps(body).encode()) <= 2048)
    uuid(body.get("request_nonce"))
    action = body.get("action")
    if action == "preview":
        require(set(body) == {"action", "request_nonce"})
    elif action == "status":
        require(
            set(body) in ({"action", "request_nonce"}, {"action", "request_nonce", "operation_id"})
        )
        if "operation_id" in body:
            uuid(body["operation_id"])
    elif action == "request":
        require(set(body) == {"action", "request_nonce", "preview_sha256", "confirmation"})
        require(
            body["confirmation"] == "CANCEL"
            and isinstance(body["preview_sha256"], str)
            and re.fullmatch(r"[a-f0-9]{64}", body["preview_sha256"])
        )
        uuid(key)
    else:
        require(False)


def validate_response(value: dict, body: dict) -> None:
    require(
        type(value) is dict
        and value.get("contract_version") == "1"
        and value.get("action") == body["action"]
        and value.get("request_nonce") == body["request_nonce"]
    )
    preview = value["action"] == "preview"
    require(
        set(value)
        == BASE
        | (
            {"preview_sha256"}
            if preview
            else {
                "operation_id",
                "received_at",
                "export_until",
                "phase",
                "access_fence_confirmed",
                "erasure_confirmed",
            }
        )
    )
    require(
        value["scope"] == "scribe-only"
        and value["shared_login_preserved"] is True
        and value["resource_manifest_status"] == "unresolved"
        and value["phi_scope"] == "core-and-scribe-clinical-records"
        and type(value["grace_days"]) is int
        and 30 <= value["grace_days"] <= 90
    )
    if preview:
        require(
            isinstance(value["preview_sha256"], str)
            and re.fullmatch(r"[a-f0-9]{64}", value["preview_sha256"])
        )
    else:
        uuid(value["operation_id"])
        require("operation_id" not in body or value["operation_id"] == body["operation_id"])
        stamps = [datetime.fromisoformat(value[name]) for name in ("received_at", "export_until")]
        require(all(stamp.tzinfo is not None for stamp in stamps) and stamps[0] < stamps[1])
        require(
            value["access_fence_confirmed"] is True
            and value["erasure_confirmed"] is False
            and value["phase"] in {"read-only-export", "read-only-expired"}
        )


class ProviderCancellationTransport:
    def __init__(
        self,
        origin: str,
        verify: Callable[[str], Awaitable[dict]],
        workload: Callable[[], Awaitable[SecretStr]],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        connections: ProviderCoreConnections | None = None,
    ):
        url = httpx.URL(origin)
        require(
            url.scheme == "https"
            and url.host
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
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def request(self, authorization: str, body: dict, key: str) -> dict:
        try:
            validate_request(body, key)
            require(authorization.startswith("Bearer ") and 8 <= len(authorization) <= 8200)
            token = authorization[7:]
            async with asyncio.timeout(30):
                before = await self.verify(token)
                workload = (await self.workload()).get_secret_value()
                require(bool(workload) and len(workload) <= 8200)
                headers = {
                    "Authorization": authorization,
                    "X-Cosmaneura-Workload-Authorization": "Bearer " + workload,
                    "X-Cosmaneura-Record-Version": "1",
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                }
                if body["action"] == "request":
                    headers["Idempotency-Key"] = key
                async with self.client.stream(
                    "POST",
                    self.origin + PATH,
                    content=json.dumps(body).encode(),
                    headers=headers,
                    timeout=httpx.Timeout(30, connect=5),
                ) as response:
                    if response.status_code != 200:
                        raise ProviderCoreUnavailable(
                            "core_cancellation_unconfirmed",
                            response.status_code
                            if response.status_code in {401, 403, 409, 422}
                            or response.status_code == 404
                            and body["action"] == "status"
                            else 503,
                        )
                    require(
                        response.headers.get_list("x-cosmaneura-record-version") == ["1"]
                        and response.headers.get("content-type", "").split(";", 1)[0]
                        == "application/json"
                        and response.headers.get("cache-control") == "no-store"
                        and not response.headers.get_list("set-cookie")
                    )
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        require(len(data) + len(chunk) <= 4096)
                        data.extend(chunk)
                value = json.loads(
                    data, object_pairs_hook=unique, parse_constant=lambda _: require(False)
                )
                validate_response(value, body)
                require(await self.verify(token) == before)
                return value
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_cancellation_unconfirmed", 503) from None
