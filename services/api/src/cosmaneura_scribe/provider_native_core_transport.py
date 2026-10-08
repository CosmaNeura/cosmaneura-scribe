"""One fixed Core facade call; local account checks bracket its service scope."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import uuid4

import httpx
from pydantic import BaseModel, ConfigDict, SecretStr

from .creator_review_routes import CreatorReviewViewV1
from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import (
    MAX_CORE_CAPTURE_RESPONSE_BYTES,
    ProviderCoreUnavailable,
    provider_cookie_jar,
)
from .provider_core_transport import (
    core_wire_object as _object,
)
from .provider_core_transport import (
    core_wire_require as _require,
)
from .provider_core_transport import (
    core_wire_secret as _secret,
)
from .provider_core_transport import (
    core_wire_snapshot as _snapshot,
)
from .provider_core_transport import (
    core_wire_uuid as _uuid,
)
from .provider_encounter_transport import ProviderEncounterAccount
from .provider_performance import provider_phase_timing
from .schemas import AudioEncryptionPublicKey, CaptureCapabilities

PATH = "/service/v1/agent/scribe/native-capture"
NATIVE_READ_OPERATIONS = frozenset(
    {
        "creator_review",
        "provider_encounter",
        "capabilities",
        "native_recording_context",
        # Existing public wrapping-key read, qualified Core receiver first.
        "encryption_key",
        "preparation_metadata",
    }
)


class PreparationMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    schema_version: Literal["1.0"]
    review: CreatorReviewViewV1
    encryption_key: AudioEncryptionPublicKey
    capabilities: CaptureCapabilities


class ProviderNativeCoreTransport:
    def __init__(
        self,
        origin: str,
        fresh: Callable[[], Awaitable[ProviderEncounterAccount]],
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
            raise ValueError("core_native_origin_invalid")
        self.origin, self.fresh, self.workload = origin.rstrip("/"), fresh, workload
        self.client = httpx.AsyncClient(
            transport=connections.borrow(origin) if connections else transport,
            trust_env=False,
            follow_redirects=False,
            cookies=provider_cookie_jar(),
            timeout=httpx.Timeout(40, connect=5),
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def request(
        self, action: str, body: dict[str, object], key: str
    ) -> tuple[ProviderEncounterAccount, dict[str, object]]:
        _require(action in {"mount", "capture-operations", "recorder"})
        payload = _snapshot(body, 4_194_304)
        workspace = _uuid(payload.get("workspace_id"))
        _require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key))
        nonce = _uuid(payload.get("request_nonce")) if action != "mount" else str(uuid4())
        request: dict[str, object] = {
            "action": "mount" if action == "mount" else "operation",
            "workspace_id": workspace,
            "request_nonce": nonce,
        }
        if action == "mount":
            _require(set(payload) in ({"workspace_id"}, {"workspace_id", "opening_nonce"}))
            if "opening_nonce" in payload:
                request["opening_nonce"] = _uuid(payload["opening_nonce"])
        else:
            binding = payload.get("binding_ref")
            _require(
                isinstance(binding, str)
                and re.fullmatch(r"scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}", binding)
            )
            request["binding_ref"] = binding
            if action == "recorder":
                _require(
                    set(payload) == {"workspace_id", "binding_ref", "session_id", "request_nonce"}
                )
                _uuid(payload["session_id"])
                request["operation"] = {"kind": "creator_review"}
            else:
                _require(
                    set(payload) == {"workspace_id", "binding_ref", "request_nonce", "operation"}
                )
                operation = _object(payload["operation"])
                _require(
                    isinstance(operation.get("kind"), str)
                    and operation["kind"] in NATIVE_READ_OPERATIONS
                )
                if operation["kind"] in {
                    "native_recording_context",
                    "encryption_key",
                    "preparation_metadata",
                }:
                    _require(set(operation) == {"kind"})
                request["operation"] = operation
        try:
            async with asyncio.timeout(60):
                before = await self.fresh()
                request.update(
                    expected_actor_ref=before.actor_ref, expected_tenant_ref=before.tenant_ref
                )
                with provider_phase_timing("workload_token"):
                    workload = await self.workload()
                workload_secret = _secret(workload)
                user_secret = _secret(before.user_token)
                if await self.fresh() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                with provider_phase_timing("core_operation"):
                    async with self.client.stream(
                        "POST",
                        self.origin + PATH,
                        content=json.dumps(request, ensure_ascii=False, allow_nan=False).encode(),
                        headers={
                            "Authorization": "Bearer " + user_secret,
                            "X-Cosmaneura-Workload-Authorization": "Bearer " + workload_secret,
                            "X-Cosmaneura-Native-Capture-Version": "1",
                            "Idempotency-Key": key,
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "Cache-Control": "no-store",
                        },
                    ) as response:
                        if response.status_code != 200:
                            status = (
                                response.status_code
                                if response.status_code in {401, 403, 409, 422}
                                else 503
                            )
                            raise ProviderCoreUnavailable(
                                "core_provider_request_unconfirmed", status
                            )
                        _require(
                            response.headers.get("x-cosmaneura-native-capture-version") == "1"
                            and response.headers.get("content-type", "").split(";", 1)[0]
                            == "application/json"
                            and "no-store" in response.headers.get("cache-control", "").lower()
                        )
                        raw = bytearray()
                        async for chunk in response.aiter_bytes():
                            _require(
                                len(raw) + len(chunk) <= MAX_CORE_CAPTURE_RESPONSE_BYTES + 24_576
                            )
                            raw.extend(chunk)
                    value = _object(
                        json.loads(
                            raw, object_pairs_hook=_unique, parse_constant=lambda _: _require(False)
                        )
                    )
                    _require(
                        set(value) == {"version", "action", "actor_ref", "tenant_ref", "result"}
                        and value["version"] == "1"
                        and value["action"] == request["action"]
                        and value["actor_ref"] == before.actor_ref
                        and value["tenant_ref"] == before.tenant_ref
                    )
                    result = _object(value["result"])
                    _require(
                        result.get("contract_version") == "1"
                        and result.get("workspace_id") == workspace
                        and result.get("request_nonce") == nonce
                    )
                    stamp = datetime.fromisoformat(str(result.get("checked_at")))
                    _require(
                        stamp.tzinfo is not None
                        and datetime.now(UTC) - timedelta(seconds=30)
                        <= stamp
                        <= datetime.now(UTC) + timedelta(seconds=5)
                    )
                    binding = result.get("binding_ref")
                    _require(
                        isinstance(binding, str)
                        and re.fullmatch(
                            r"scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}", binding
                        )
                    )
                    if action != "mount":
                        _require(
                            set(result)
                            == {
                                "contract_version",
                                "workspace_id",
                                "binding_ref",
                                "request_nonce",
                                "checked_at",
                                "operation",
                                "receipt",
                            }
                        )
                        _require(
                            binding == request["binding_ref"]
                            and result.get("operation") == _object(request["operation"])["kind"]
                        )
                        receipt = _object(result.get("receipt"))
                        if _object(request["operation"])["kind"] == "preparation_metadata":
                            metadata = PreparationMetadata.model_validate(receipt)
                            public = _object(receipt.get("encryption_key"))
                            wrapping_jwk = _object(public.get("public_jwk"))
                            _require(
                                set(public) == {"key_version", "algorithm", "public_jwk"}
                                and set(wrapping_jwk) == {"kty", "n", "e", "alg", "ext", "key_ops"}
                                and wrapping_jwk.get("key_ops") == ["wrapKey"]
                            )
                            result["receipt"] = metadata.model_dump(mode="json")
                        if _object(request["operation"])["kind"] == "encryption_key":
                            public = _object(receipt.get("public_jwk"))
                            _require(
                                set(receipt) == {"key_version", "algorithm", "public_jwk"}
                                and set(public) == {"kty", "n", "e", "alg", "ext", "key_ops"}
                                and public.get("key_ops") == ["wrapKey"]
                            )
                            result["receipt"] = AudioEncryptionPublicKey.model_validate(
                                receipt
                            ).model_dump(mode="json")
                        if action == "recorder":
                            _require(
                                receipt.get("schema_version") == "1.0"
                                and receipt.get("session_id") == payload["session_id"]
                            )
                    else:
                        _require(
                            set(result)
                            == {
                                "contract_version",
                                "workspace_id",
                                "binding_ref",
                                "request_nonce",
                                "checked_at",
                                "appointment_ref",
                                "encounter",
                            }
                            | ({"opening_review"} if "opening_nonce" in payload else set())
                        )
                        _object(result.get("encounter"))
                        if "opening_nonce" in payload:
                            review = _object(result["opening_review"])
                            _require(
                                review.get("request_nonce") == payload["opening_nonce"]
                                and review.get("workspace_id") == workspace
                                and review.get("binding_ref") == binding
                                and review.get("operation") == "provider_encounter"
                            )
                # This is a publication fence. It cannot undo a remote mutation;
                # Core keeps its own current authorization around downstream I/O.
                if await self.fresh() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                return before, result
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_provider_request_unconfirmed") from None


def _unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, entry in pairs:
        if key in value:
            raise ValueError("ambiguous_native_receipt")
        value[key] = entry
    return value
