"""Fresh Core-owned provider context; no shadow registry or credential fallback."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import cast
from uuid import UUID, uuid4, uuid5

import httpx
from pydantic import SecretStr

from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import (
    ProviderCoreUnavailable,
    core_wire_object,
    core_wire_require,
    core_wire_secret,
    provider_cookie_jar,
)
from .provider_encounter_transport import ProviderEncounterAccount

PATH = "/service/v1/agent/scribe/provider-context"
MAX_RESPONSE_BYTES = 1_048_576
_TYPEID = r"_[0-7][0-9a-hjkmnp-tv-z]{25}"


def _unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for name, value in pairs:
        core_wire_require(name not in result)
        result[name] = value
    return result


class ProviderContextTransport:
    def __init__(
        self,
        origin: str,
        environment_id: UUID,
        box_id: str,
        verify: Callable[[str], Awaitable[dict[str, object]]],
        workload: Callable[[], Awaitable[SecretStr]],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        connections: ProviderCoreConnections | None = None,
    ):
        url = httpx.URL(origin)
        if (
            url.scheme != "https"
            or not url.host
            or url.userinfo
            or url.path != "/"
            or url.query
            or url.fragment
        ):
            raise ValueError("core_context_origin_invalid")
        self.origin, self.environment_id, self.box_id = origin.rstrip("/"), environment_id, box_id
        self.verify, self.workload = verify, workload
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
        self, authorization: str, action: str
    ) -> tuple[ProviderEncounterAccount, dict[str, object] | None]:
        try:
            async with asyncio.timeout(30):
                core_wire_require(action in {"connection", "catalog"})
                core_wire_require(authorization.startswith("Bearer "))
                token = core_wire_secret(SecretStr(authorization[7:]))
                before = await self.verify(token)
                nonce = str(uuid4())
                workload = core_wire_secret(await self.workload())
                async with self.client.stream(
                    "POST",
                    self.origin + PATH,
                    json={"action": action, "request_nonce": nonce},
                    headers={
                        "Authorization": "Bearer " + token,
                        "X-Cosmaneura-Workload-Authorization": "Bearer " + workload,
                        "X-Cosmaneura-Record-Version": "1",
                        "Content-Type": "application/json",
                    },
                ) as response:
                    if response.status_code in {401, 403}:
                        raise ProviderCoreUnavailable(
                            "core_provider_access_unavailable", response.status_code
                        )
                    core_wire_require(
                        response.status_code == 200
                        and response.headers.get("content-type", "").split(";", 1)[0]
                        == "application/json"
                        and response.headers.get("cache-control") == "no-store"
                        and response.headers.get("x-cosmaneura-record-version") == "1"
                        and not response.headers.get_list("set-cookie")
                    )
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        core_wire_require(len(raw) + len(chunk) <= MAX_RESPONSE_BYTES)
                        raw.extend(chunk)
                value = core_wire_object(
                    json.loads(
                        raw,
                        object_pairs_hook=_unique,
                        parse_constant=lambda _: core_wire_require(False),
                    )
                )
                core_wire_require(
                    set(value)
                    == {
                        "contract_version",
                        "action",
                        "request_nonce",
                        "checked_at",
                        "connection",
                        "catalog",
                    }
                )
                core_wire_require(
                    value["contract_version"] == "1"
                    and value["action"] == action
                    and value["request_nonce"] == nonce
                )
                checked = datetime.fromisoformat(str(value["checked_at"]).replace("Z", "+00:00"))
                core_wire_require(
                    checked.tzinfo is not None
                    and -5 <= (datetime.now(UTC) - checked).total_seconds() <= 35
                )
                connection = core_wire_object(value["connection"])
                core_wire_require(
                    set(connection)
                    == {
                        "actor_ref",
                        "tenant_ref",
                        "provider_link_ref",
                        "practice_ref",
                        "practice_label",
                        "review_sha256",
                        "connection_sha256",
                    }
                )
                for name, prefix in (
                    ("actor_ref", "authority_actor"),
                    ("tenant_ref", "authority_tenant"),
                    ("provider_link_ref", "scribe_provider_link"),
                    ("practice_ref", "practice"),
                ):
                    core_wire_require(
                        isinstance(connection[name], str)
                        and re.fullmatch(prefix + _TYPEID, str(connection[name])) is not None
                    )
                label = connection["practice_label"]
                core_wire_require(
                    isinstance(label, str) and 0 < len(label) <= 200 and "\x00" not in label
                )
                core_wire_require(
                    re.fullmatch(r"[0-9a-f]{64}", str(connection["review_sha256"])) is not None
                )
                digest = hashlib.sha256(
                    json.dumps(
                        {k: v for k, v in connection.items() if k != "connection_sha256"},
                        sort_keys=True,
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ).encode()
                ).hexdigest()
                core_wire_require(connection["connection_sha256"] == digest)
                after = await self.verify(token)
                core_wire_require(after == before)
                recovery = uuid5(
                    self.environment_id,
                    f"core-provider-context-v1:{self.box_id}:{connection['provider_link_ref']}:{digest}",
                )
                account = ProviderEncounterAccount(
                    str(connection["provider_link_ref"]),
                    recovery,
                    str(connection["actor_ref"]),
                    str(connection["tenant_ref"]),
                    SecretStr(token),
                )
                raw_catalog = value["catalog"]
                catalog: dict[str, object] | None = None
                if action == "connection":
                    core_wire_require(raw_catalog is None)
                else:
                    catalog = core_wire_object(raw_catalog)
                    owner = core_wire_object(catalog.get("account"))
                    core_wire_require(
                        set(catalog)
                        == {"version", "action", "request_nonce", "account", "encounters"}
                        and {"actor_ref", "tenant_ref"} <= set(owner)
                        and set(owner) <= {"actor_ref", "tenant_ref", "doctor_ref", "email"}
                        and catalog.get("version") == "1"
                        and catalog.get("action") == "list"
                        and catalog.get("request_nonce") == nonce
                        and owner.get("actor_ref") == account.actor_ref
                        and owner.get("tenant_ref") == account.tenant_ref
                    )
                    rows = catalog.get("encounters")
                    core_wire_require(
                        isinstance(rows, list) and len(cast(list[object], rows)) <= 1000
                    )
                return account, catalog
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_provider_context_unconfirmed") from None
