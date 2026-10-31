"""Closed versioned visit calls through Core's dual-auth native facade."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from typing import Literal, cast

import httpx
from pydantic import SecretStr

from . import provider_native_visit_actions as v2
from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import (
    ProviderCoreUnavailable,
    core_wire_object,
    core_wire_require,
    core_wire_secret,
    core_wire_snapshot,
    core_wire_uuid,
)
from .provider_encounter_transport import ProviderEncounterAccount, ProviderEncounterTransport

PATH = "/service/v1/agent/scribe/native-encounters"


class ProviderNativeEncounterTransport(ProviderEncounterTransport):
    # The legacy transport's construction and account checks are reused without
    # changing its request path, token policy or current registry behavior.
    def __init__(
        self,
        origin: str,
        fresh: Callable[[], Awaitable[ProviderEncounterAccount]],
        workload: Callable[[], Awaitable[SecretStr]],
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        connections: ProviderCoreConnections | None = None,
        version: Literal["1", "2"] = "1",
    ):
        super().__init__(origin, fresh, transport=transport, connections=connections)
        if version not in {"1", "2"}:
            raise ValueError("native_visit_version_invalid")
        self.workload, self.version = workload, version

    async def request(self, body: dict[str, object], key: str) -> dict[str, object]:
        try:
            async with asyncio.timeout(30):
                private_save = self.version == "2" and body.get("action") == "private_note_save"
                # The shared snapshot escapes Unicode. Enforce the native/Core
                # UTF-8 envelope too, without excluding valid multibyte reminders.
                payload = core_wire_snapshot(body, 32768 if private_save else 4096)
                if private_save:
                    core_wire_require(
                        len(
                            json.dumps(
                                payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")
                            ).encode("utf-8")
                        )
                        <= 16384
                    )
                core_wire_require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key))
                if self.version == "2":
                    action = v2.request(payload, key)
                else:
                    action = payload.get("action")
                    core_wire_require(action in {"patients", "create"})
                    core_wire_require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key))
                    core_wire_uuid(payload.get("request_nonce"))
                    if action == "patients":
                        core_wire_require(set(payload) <= {"action", "request_nonce", "query"})
                        query = payload.get("query", "")
                        core_wire_require(
                            isinstance(query, str) and len(query) <= 200 and "\x00" not in query
                        )
                    else:
                        core_wire_require(
                            set(payload)
                            == {
                                "action",
                                "request_nonce",
                                "creation_key",
                                "patient",
                                "appointment_at",
                                "title",
                            }
                        )
                        core_wire_require(core_wire_uuid(payload["creation_key"]) == key)
                        patient = core_wire_object(payload["patient"])
                        core_wire_require(
                            set(patient) == {"kind", "patient_ref"}
                            and patient.get("kind") == "existing"
                        )
                        core_wire_require(
                            isinstance(patient.get("patient_ref"), str)
                            and re.fullmatch(
                                r"patient_[0-7][0-9a-hjkmnp-tv-z]{25}",
                                cast(str, patient.get("patient_ref")),
                            )
                        )
                before = await self.account()
                core_wire_require(self.version == "1" or before.native_visit_actions_v2)
                workload = core_wire_secret(await self.workload())
                # Credential acquisition can yield; current authority must still
                # match immediately before the one fixed mutation dispatch.
                if await self.account() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                async with self.client.stream(
                    "POST",
                    self.origin + PATH,
                    json={
                        **payload,
                        "expected_actor_ref": before.actor_ref,
                        "expected_tenant_ref": before.tenant_ref,
                    },
                    headers={
                        "Authorization": "Bearer " + core_wire_secret(before.user_token),
                        "X-Cosmaneura-Workload-Authorization": "Bearer " + workload,
                        "X-Cosmaneura-Scribe-Encounter-Version": self.version,
                        "Idempotency-Key": key,
                        "Content-Type": "application/json",
                    },
                ) as response:
                    if response.status_code != 200:
                        status = (
                            response.status_code
                            if response.status_code in {401, 403, 409, 422}
                            else 503
                        )
                        raise ProviderCoreUnavailable("core_encounter_unconfirmed", status)
                    core_wire_require(
                        response.headers.get("x-cosmaneura-scribe-encounter-version")
                        == self.version
                        and response.headers.get("content-type", "").split(";", 1)[0]
                        == "application/json"
                        and response.headers.get("cache-control") == "no-store"
                        and not response.headers.get_list("set-cookie")
                    )
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        core_wire_require(len(content) + len(chunk) <= 1_048_576)
                        content.extend(chunk)

                def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
                    result: dict[str, object] = {}
                    for name, value in pairs:
                        core_wire_require(name not in result)
                        result[name] = value
                    return result

                value = core_wire_object(
                    json.loads(
                        content,
                        object_pairs_hook=unique,
                        parse_constant=lambda _: core_wire_require(False),
                    )
                )
                account = core_wire_object(value.get("account"))
                expected = {"version", "action", "request_nonce", "account"}
                if self.version == "2":
                    expected |= v2.EXTRAS[str(action)]
                else:
                    expected |= (
                        {"creation_key", "encounter"}
                        if action == "create"
                        else {"patients", "more_results"}
                    )
                core_wire_require(set(value) == expected)
                core_wire_require(
                    {"actor_ref", "tenant_ref"}
                    <= set(account)
                    <= {"actor_ref", "tenant_ref", "doctor_ref", "email"}
                )
                if action == "patients":
                    patients = value["patients"]
                    core_wire_require(
                        isinstance(patients, list)
                        and len(cast(list[object], patients)) <= 100
                        and type(value["more_results"]) is bool
                    )
                core_wire_require(
                    value.get("version") == self.version
                    and value.get("action") == action
                    and value.get("request_nonce") == payload["request_nonce"]
                    and account.get("actor_ref") == before.actor_ref
                    and account.get("tenant_ref") == before.tenant_ref
                )
                if self.version == "2":
                    v2.response(value, payload, key)
                else:
                    if action == "create":
                        core_wire_require(value.get("creation_key") == key)
                        encounter = core_wire_object(value.get("encounter"))
                        core_wire_require(
                            encounter.get("patient_ref")
                            == core_wire_object(payload["patient"])["patient_ref"]
                        )
                if await self.account() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                return {**value, "recoveryScope": str(before.recovery_scope)}
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_encounter_unconfirmed") from None
