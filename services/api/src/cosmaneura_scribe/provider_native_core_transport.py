"""One fixed Core facade call; local account checks bracket its service scope."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Literal, cast
from uuid import UUID, uuid4, uuid5

import httpx
from pydantic import BaseModel, ConfigDict, SecretStr

from .creator_review_routes import CreatorReviewViewV1
from .provider_core_connections import ProviderCoreConnections
from .provider_core_transport import (
    MAX_CORE_CAPTURE_RESPONSE_BYTES,
    CoreProviderMount,
    CoreProviderSelection,
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
from .provider_preparation_handoff import PreparationHandoff, PreparedContext
from .schemas import AudioEncryptionPublicKey, CaptureCapabilities

PATH = "/service/v1/agent/scribe/native-capture"
NATIVE_READ_OPERATIONS = frozenset(
    {
        "creator_review",
        "provider_encounter",
        "capabilities",
        "native_recording_context",
        "native_recording_preparation",
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


class NativeRecordingContext(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    schema_version: Literal["1.0"]
    workspace_id: UUID
    tenant_id: UUID
    session_id: UUID
    status: Literal["created", "capturing"]


class NativeRecordingPreparation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    schema_version: Literal["1.0"]
    context: NativeRecordingContext
    encryption_key: AudioEncryptionPublicKey


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

    async def prepared_operation(
        self,
        payload: dict[str, object],
        key: str,
        before: ProviderEncounterAccount,
        context: PreparedContext,
        workload: SecretStr,
        *,
        admission: bool = False,
        native_read: bool = False,
        admission_native_preparation: bool = False,
        admission_preparation_metadata: bool = False,
    ) -> dict[str, object]:
        """Use one server-only context through the fully authenticated native route."""
        selection = context.mount.selection
        _require(
            not (admission and native_read)
            and (not (admission_native_preparation or admission_preparation_metadata) or admission)
            and not (admission_native_preparation and admission_preparation_metadata)
        )
        _require(
            (
                set(payload)
                == {
                    "workspace_id",
                    "binding_ref",
                    "request_nonce",
                    "attestation",
                    "configured_capture",
                }
                if admission
                else set(payload) == {"workspace_id", "binding_ref", "request_nonce", "operation"}
                and _object(payload["operation"]).get("kind")
                == ("native_recording_preparation" if native_read else "prepare_recording_window")
                and (not native_read or set(_object(payload["operation"])) == {"kind"})
            )
            and payload["workspace_id"] == str(selection.workspace_id)
            and payload["binding_ref"] == context.mount.binding_ref
            and (before.actor_ref, before.tenant_ref) == (selection.actor_ref, selection.tenant_ref)
        )
        request = {
            **payload,
            "action": "prepared_admission"
            if admission
            else ("prepared_native_read" if native_read else "prepared_window"),
            "expected_actor_ref": before.actor_ref,
            "expected_tenant_ref": before.tenant_ref,
            "prepared_context": {
                "context_token": _secret(context.token),
                "interaction_ref": context.interaction_ref,
                "client_turn_id": str(context.turn),
            },
        }
        if admission_native_preparation:
            request["include_native_preparation"] = True
        if admission_preparation_metadata:
            request["include_preparation_metadata"] = True
        # The preparation caller already checked before/after workload I/O.
        # Keep its separate third fence, plus the ordinary adjacent pre-I/O,
        # post-I/O and final publication checks (six total for the window).
        # The read caller uses its original two adjacent account checks above
        # and this method's publication check: the same three as a fresh read.
        try:
            if not native_read and (await self.fresh() != before or await self.fresh() != before):
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            async with self.client.stream(
                "POST",
                self.origin + PATH,
                content=json.dumps(request, allow_nan=False).encode(),
                headers={
                    "Authorization": "Bearer " + _secret(before.user_token),
                    "X-Cosmaneura-Workload-Authorization": "Bearer " + _secret(workload),
                    "X-Cosmaneura-Native-Capture-Version": "1",
                    "Idempotency-Key": key,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Cache-Control": "no-store",
                },
            ) as response:
                if response.status_code != 200:
                    raise ProviderCoreUnavailable(
                        "core_provider_request_unconfirmed",
                        response.status_code
                        if response.status_code in {401, 403, 409, 422}
                        else 503,
                    )
                _require(
                    response.headers.get("x-cosmaneura-native-capture-version") == "1"
                    and response.headers.get("content-type", "").split(";", 1)[0]
                    == "application/json"
                    and "no-store" in response.headers.get("cache-control", "").lower()
                )
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    _require(len(raw) + len(chunk) <= MAX_CORE_CAPTURE_RESPONSE_BYTES)
                    raw.extend(chunk)
            value = _object(
                json.loads(raw, object_pairs_hook=_unique, parse_constant=lambda _: _require(False))
            )
            _require(
                set(value) == {"version", "action", "actor_ref", "tenant_ref", "result"}
                and value["version"] == "1"
                and value["action"] == request["action"]
                and value["actor_ref"] == before.actor_ref
                and value["tenant_ref"] == before.tenant_ref
            )
            result = _object(value["result"])
            if admission:
                _require(
                    set(result)
                    == {
                        "contract_version",
                        "workspace_id",
                        "binding_ref",
                        "request_nonce",
                        "checked_at",
                        "appointment_ref",
                        "operation_ref",
                        "session_id",
                        "consent_record_id",
                        "status",
                        "configured_capture",
                    }
                    | ({"native_recording_preparation"} if admission_native_preparation else set())
                    | ({"preparation_metadata"} if admission_preparation_metadata else set())
                    and result["appointment_ref"] == selection.appointment_ref
                    and isinstance(result["operation_ref"], str)
                    and re.fullmatch(
                        r"scribe_admission_[0-7][0-9a-hjkmnp-tv-z]{25}", result["operation_ref"]
                    )
                    and result["status"] == "admitted"
                    and result["configured_capture"] == payload["configured_capture"]
                )
                _uuid(result["session_id"])
                _uuid(result["consent_record_id"])
                if admission_native_preparation:
                    prepared = _validated_native_preparation(
                        result["native_recording_preparation"], payload["workspace_id"]
                    )
                    _require(_object(prepared["context"])["session_id"] == result["session_id"])
                    result["native_recording_preparation"] = prepared
                if admission_preparation_metadata:
                    prepared = _validated_preparation_metadata(result["preparation_metadata"])
                    _require(_object(prepared["review"])["session_id"] == result["session_id"])
                    result["preparation_metadata"] = prepared
            else:
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
                    and result["operation"]
                    == (
                        "native_recording_preparation"
                        if native_read
                        else "prepare_recording_window"
                    )
                )
                _object(result["receipt"])
                if native_read:
                    result["receipt"] = _validated_native_preparation(
                        result["receipt"], payload["workspace_id"]
                    )
            _require(
                result["contract_version"] == "1"
                and all(
                    result[k] == payload[k]
                    for k in ("workspace_id", "binding_ref", "request_nonce")
                )
            )
            stamp = datetime.fromisoformat(str(result["checked_at"]))
            _require(
                stamp.tzinfo is not None
                and datetime.now(UTC) - timedelta(seconds=30)
                <= stamp
                <= datetime.now(UTC) + timedelta(seconds=5)
            )
            if await self.fresh() != before:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            if not admission and not native_read and await self.fresh() != before:
                raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
            return result
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_provider_request_unconfirmed") from None

    async def request(
        self,
        action: str,
        body: dict[str, object],
        key: str,
        *,
        handoff: PreparationHandoff | None = None,
        revision: UUID | None = None,
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
            if handoff is not None:
                _require(revision is not None)
                request["retain_preparation_context"] = True
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
                    "native_recording_preparation",
                    "encryption_key",
                    "preparation_metadata",
                }:
                    _require(set(operation) == {"kind"})
                request["operation"] = operation
        try:
            async with asyncio.timeout(60):
                before = await self.fresh()
                issued_at = handoff.now() if handoff is not None else 0.0
                request.update(
                    expected_actor_ref=before.actor_ref, expected_tenant_ref=before.tenant_ref
                )
                with provider_phase_timing("workload_token"):
                    workload = await self.workload()
                workload_secret = _secret(workload)
                user_secret = _secret(before.user_token)
                if await self.fresh() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                retained_read = None
                if (
                    action == "capture-operations"
                    and _object(request["operation"])["kind"] == "native_recording_preparation"
                    and handoff is not None
                ):
                    if revision is None:
                        raise ProviderCoreUnavailable()
                    retained = handoff.take(
                        self.origin, before, revision, workspace, cast(str, request["binding_ref"])
                    )
                    if (
                        retained is not None
                        and not retained.native_read_done
                        and retained.native_read_supported
                    ):
                        result = await self.prepared_operation(
                            payload, key, before, retained, workload, native_read=True
                        )
                        # Carry the same credential to the first window only after
                        # all read fences succeed. Never refresh its issue time or
                        # retain an access decision; failures are destructive.
                        handoff.retain(
                            self.origin,
                            before,
                            revision,
                            workspace,
                            cast(str, request["binding_ref"]),
                            replace(retained, native_read_done=True),
                        )
                        return before, result
                    if retained is not None and not retained.native_read_done:
                        retained_read = retained
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
                        if _object(request["operation"])["kind"] == "native_recording_preparation":
                            result["receipt"] = _validated_native_preparation(receipt, workspace)
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
                            | ({"prepared_context"} if handoff is not None else set())
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
                if retained_read is not None:
                    assert handoff is not None and revision is not None
                    handoff.retain(
                        self.origin,
                        before,
                        revision,
                        workspace,
                        cast(str, request["binding_ref"]),
                        replace(retained_read, native_read_done=True),
                    )
                if action == "mount" and handoff is not None:
                    assert revision is not None
                    private = _object(result.pop("prepared_context"))
                    _require(set(private) == {"context_token", "interaction_ref", "client_turn_id"})
                    _require(
                        isinstance(private["context_token"], str)
                        and isinstance(private["interaction_ref"], str)
                        and re.fullmatch(r"[A-Za-z0-9._~-]{16,160}", private["interaction_ref"])
                    )
                    context_token = SecretStr(cast(str, private["context_token"]))
                    _secret(context_token)
                    selection = CoreProviderSelection(
                        before.recovery_scope,
                        uuid5(before.recovery_scope, str(revision)),
                        UUID(workspace),
                        cast(str, result["appointment_ref"]),
                        before.actor_ref,
                        before.tenant_ref,
                    )
                    handoff.retain(
                        self.origin,
                        before,
                        revision,
                        workspace,
                        cast(str, binding),
                        PreparedContext(
                            CoreProviderMount(selection, cast(str, binding)),
                            context_token,
                            cast(str, private["interaction_ref"]),
                            UUID(_uuid(private["client_turn_id"])),
                            issued_at,
                            stage="admission",
                            native_read_supported=(
                                response.headers.get_list(
                                    "x-cosmaneura-prepared-native-read-version"
                                )
                                == ["1"]
                            ),
                            admission_native_preparation_supported=(
                                response.headers.get_list(
                                    "x-cosmaneura-admission-native-preparation-version"
                                )
                                == ["1"]
                            ),
                            admission_preparation_metadata_supported=(
                                response.headers.get_list(
                                    "x-cosmaneura-admission-preparation-metadata-version"
                                )
                                == ["1"]
                            ),
                            source_start_supported=(
                                response.headers.get_list(
                                    "x-cosmaneura-prepared-source-start-version"
                                )
                                == ["1"]
                            ),
                        ),
                    )
                return before, result
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_provider_request_unconfirmed") from None


def _validated_preparation_metadata(value: object) -> dict[str, object]:
    receipt = _object(value)
    prepared = PreparationMetadata.model_validate(receipt)
    public = _object(receipt.get("encryption_key"))
    wrapping = _object(public.get("public_jwk"))
    _require(
        set(public) == {"key_version", "algorithm", "public_jwk"}
        and set(wrapping) == {"kty", "n", "e", "alg", "ext", "key_ops"}
        and wrapping.get("key_ops") == ["wrapKey"]
    )
    return prepared.model_dump(mode="json")


def _validated_native_preparation(value: object, workspace: object) -> dict[str, object]:
    receipt = _object(value)
    prepared = NativeRecordingPreparation.model_validate(receipt)
    context = _object(receipt.get("context"))
    _require(
        _uuid(context.get("workspace_id")) == workspace
        and context.get("workspace_id") == workspace
        and _uuid(context.get("tenant_id")) == context.get("tenant_id")
        and _uuid(context.get("session_id")) == context.get("session_id")
    )
    public = _object(receipt.get("encryption_key"))
    wrapping_jwk = _object(public.get("public_jwk"))
    _require(
        set(public) == {"key_version", "algorithm", "public_jwk"}
        and set(wrapping_jwk) == {"kty", "n", "e", "alg", "ext", "key_ops"}
        and wrapping_jwk.get("key_ops") == ["wrapKey"]
    )
    return prepared.model_dump(mode="json")


def _unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, entry in pairs:
        if key in value:
            raise ValueError("ambiguous_native_receipt")
        value[key] = entry
    return value
