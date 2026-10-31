"""Core-owned visit creation/discovery with a fresh reviewed native account.

No registry writes, synthetic identity, patient matching or automatic retries.
The human bearer goes only to the configured Core origin, never to the renderer.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from contextlib import nullcontext
from dataclasses import dataclass
from typing import cast
from uuid import UUID

import httpx
from pydantic import SecretStr

from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import ProviderCoreUnavailable, provider_cookie_jar
from .provider_performance import provider_phase_timing

PATH = "/embed/v1/scribe/encounters"


@dataclass(frozen=True, repr=False)
class ProviderEncounterAccount:
    account_id: str
    recovery_scope: UUID
    actor_ref: str
    tenant_ref: str
    user_token: SecretStr
    # Server-only digest of the freshly verified issuer/subject/session. General
    # receivers and older callers retain the exact-token match by leaving None.
    session_fingerprint: bytes | None = None
    # A fresh, opted-in Core reply owns this capability; it is never renderer input.
    native_visit_actions_v2: bool = False

    def __post_init__(self) -> None:
        if type(self.native_visit_actions_v2) is not bool:
            raise ValueError("provider_visit_capability_invalid")
        if self.session_fingerprint is not None and (
            type(self.session_fingerprint) is not bytes or len(self.session_fingerprint) != 32
        ):
            raise ValueError("provider_session_fingerprint_invalid")


class ProviderEncounterTransport:
    def __init__(
        self,
        origin: str,
        fresh: Callable[[], Awaitable[ProviderEncounterAccount]],
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
            raise ValueError("core_encounter_origin_invalid")
        self.origin, self.fresh = origin.rstrip("/"), fresh
        self.client = httpx.AsyncClient(
            transport=connections.borrow(origin) if connections else transport,
            trust_env=False,
            follow_redirects=False,
            cookies=provider_cookie_jar(),
            timeout=httpx.Timeout(20, connect=5),
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def account(self) -> ProviderEncounterAccount:
        try:
            return await self.fresh()
        except Exception:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403) from None

    async def request(self, body: dict[str, object], key: str) -> dict[str, object]:
        try:
            async with asyncio.timeout(30):
                before = await self.account()
                if (
                    not re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key)
                    or set(body) & {"expected_actor_ref", "expected_tenant_ref"}
                    or body.get("action")
                    not in {
                        "patients",
                        "list",
                        "lookup",
                        "create",
                        "add_birth_date",
                        "private_note_read",
                        "private_note_save",
                        "patient_match_candidates",
                        "patient_match_save",
                    }
                ):
                    raise ValueError
                payload = {
                    **body,
                    "expected_actor_ref": before.actor_ref,
                    "expected_tenant_ref": before.tenant_ref,
                }
                raw = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
                if len(raw) > (16384 if body.get("action") == "private_note_save" else 4096):
                    raise ValueError
                # Only a fixed label and duration enter diagnostics. Account
                # checks remain outside this HTTP/decode timing interval.
                with (
                    provider_phase_timing("core_encounter_lookup")
                    if body["action"] == "lookup"
                    else nullcontext()
                ):
                    async with self.client.stream(
                        "POST",
                        self.origin + PATH,
                        content=raw,
                        headers={
                            "Authorization": "Bearer " + before.user_token.get_secret_value(),
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "Cache-Control": "no-store",
                            "X-Cosmaneura-Scribe-Encounter-Version": "1",
                            "Idempotency-Key": key,
                        },
                    ) as response:
                        if response.status_code != 200:
                            status = (
                                response.status_code
                                if response.status_code in {401, 403, 409, 422}
                                else 503
                            )
                            raise ProviderCoreUnavailable("core_encounter_unconfirmed", status)
                        if (
                            response.headers.get("x-cosmaneura-scribe-encounter-version") != "1"
                            or response.headers.get("content-type", "").split(";", 1)[0]
                            != "application/json"
                            or "no-store" not in response.headers.get("cache-control", "").lower()
                        ):
                            raise ValueError
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            if len(content) + len(chunk) > 1_048_576:
                                raise ValueError
                            content.extend(chunk)
                    raw_value: object = json.loads(content, object_pairs_hook=_unique)
                    if not isinstance(raw_value, dict):
                        raise ValueError
                    value = cast(dict[str, object], raw_value)
                    raw_account = value.get("account")
                    if not isinstance(raw_account, dict):
                        raise ValueError
                    account = cast(dict[str, object], raw_account)
                    if (
                        value.get("version") != "1"
                        or value.get("action") != body["action"]
                        or value.get("request_nonce") != body.get("request_nonce")
                        or account.get("actor_ref") != before.actor_ref
                        or account.get("tenant_ref") != before.tenant_ref
                    ):
                        raise ValueError
                after = await self.account()
                if after != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                return {**value, "recoveryScope": str(before.recovery_scope)}
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_encounter_unconfirmed") from None


def _unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, entry in pairs:
        if key in value:
            raise ValueError
        value[key] = entry
    return value
