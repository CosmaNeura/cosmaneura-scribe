"""Closed native capture/note workflow; no generic API negotiation or retry."""

from __future__ import annotations

import asyncio
import hmac
import json
import re
from datetime import UTC, datetime, timedelta
from typing import cast

import httpx

from .provider_core_transport import (
    MAX_CORE_CAPTURE_RESPONSE_BYTES,
    CoreProviderMount,
    ProviderCoreUnavailable,
    source_start_reply,
    source_start_sequence,
)
from .provider_core_transport import (
    core_wire_object as obj,
)
from .provider_core_transport import (
    core_wire_require as require,
)
from .provider_core_transport import (
    core_wire_secret as secret,
)
from .provider_core_transport import (
    core_wire_snapshot as snapshot,
)
from .provider_core_transport import (
    core_wire_uuid as uuid,
)
from .provider_encounter_transport import ProviderEncounterAccount
from .provider_native_core_transport import (
    PATH,
    ProviderNativeCoreTransport,
)
from .provider_performance import observe_core_response
from .source_start_contract import (
    SourceStartCapability,
    SourceStartIntent,
    SourceStartReceipt,
    SourceStartRetirementReceipt,
)

OPERATIONS = frozenset(
    {
        "prepare_recording_window",
        "prepare_continuation_window",
        "bind_key",
        "issue_lease",
        "renew_lease",
        "reserve_chunks",
        "authorize_upload",
        "chunk_receipt",
        "register_chunk",
        "complete",
        "decide_translation",
        "edit_transcript",
    }
)
SCOPE = {"workspace_id", "binding_ref", "request_nonce"}


class ProviderNativeWorkflowTransport(ProviderNativeCoreTransport):
    async def workflow(
        self,
        action: str,
        body: dict[str, object],
        key: str,
        *,
        mount: CoreProviderMount | None = None,
        before: ProviderEncounterAccount | None = None,
    ) -> dict[str, object]:
        """`before` is the caller's account snapshot when no I/O separates it
        from this call; the dispatch and publication checks still follow."""
        require(
            action
            in {
                "capture-operations",
                "capture-admissions",
                "capture-notes",
                "source-start",
                "source-start-ready",
            }
        )
        payload = snapshot(body, 270_336 if action == "capture-notes" else 4_194_304)
        require(re.fullmatch(r"[A-Za-z0-9._:-]{8,255}", key))
        uuid(payload.get("workspace_id"))
        uuid(payload.get("request_nonce"))
        binding = payload.get("binding_ref")
        require(
            isinstance(binding, str)
            and re.fullmatch(r"scribe_capture_binding_[0-7][0-9a-hjkmnp-tv-z]{25}", binding)
        )
        sequence = intent = authorize_nonce = source_intent = None
        if action in {"source-start", "source-start-ready"}:
            require(mount is not None)
            assert mount is not None
            require(
                payload["workspace_id"] == str(mount.selection.workspace_id)
                and binding == mount.binding_ref
            )
            if action == "source-start-ready":
                sequence, intent, authorize_nonce = source_start_sequence(mount, payload, key)
                payload = sequence
            else:
                require(set(payload) == SCOPE | {"operation"})
                operation = obj(payload["operation"])
                # Ready preparation carries no start authority. Its separate
                # native authorization uses the same Core checks as the pair.
                require(
                    set(operation) == {"kind", "action", "payload"}
                    and operation.get("kind") == "source_start"
                    and operation.get("action") in {"prepare", "authorize", "stop", "cancel"}
                )
                source_intent = SourceStartIntent.model_validate(operation["payload"])
        elif action == "capture-operations":
            require(set(payload) == SCOPE | {"operation"})
            require(obj(payload["operation"]).get("kind") in OPERATIONS)
        elif action == "capture-admissions":
            require(set(payload) == SCOPE | {"attestation", "configured_capture"})
        else:
            require(set(payload) <= SCOPE | {"expected_session_id", "action", "schema_ref", "edit"})
            uuid(payload.get("expected_session_id"))
            note_action = payload.get("action")
            require(
                note_action
                in {
                    "templates",
                    "template_preference",
                    "read",
                    "prepare",
                    "save",
                    "resolve",
                    "save_status",
                }
            )
            require(
                (note_action in {"templates", "template_preference"})
                == ("schema_ref" not in payload)
            )
            require((note_action in {"save", "resolve", "save_status"}) == ("edit" in payload))
            if "edit" in payload:
                require(obj(payload["edit"]).get("client_key") == key)
        wire_action = (
            "workflow_admission"
            if action == "capture-admissions"
            else "workflow_notes"
            if action == "capture-notes"
            else "workflow_operation"
        )
        request: dict[str, object] = {**{k: payload[k] for k in SCOPE}, "action": wire_action}
        if action == "capture-notes":
            request["note_request"] = payload
        else:
            request.update({k: v for k, v in payload.items() if k not in SCOPE})
        try:
            async with asyncio.timeout(
                100 if action in {"capture-notes", "capture-admissions"} else 60
            ):
                if before is None:
                    before = await self.fresh()
                if mount is not None:
                    require(
                        (before.actor_ref, before.tenant_ref, before.recovery_scope)
                        == (
                            mount.selection.actor_ref,
                            mount.selection.tenant_ref,
                            mount.selection.recovery_scope,
                        )
                    )
                workload = await self.workload()
                request.update(
                    expected_actor_ref=before.actor_ref, expected_tenant_ref=before.tenant_ref
                )
                if await self.fresh() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                async with self.client.stream(
                    "POST",
                    self.origin + PATH,
                    content=json.dumps(request, allow_nan=False).encode(),
                    timeout=httpx.Timeout(
                        100 if action in {"capture-notes", "capture-admissions"} else 60, connect=5
                    ),
                    headers={
                        "Authorization": "Bearer " + secret(before.user_token),
                        "X-Cosmaneura-Workload-Authorization": "Bearer " + secret(workload),
                        "X-Cosmaneura-Native-Capture-Version": "1",
                        "Idempotency-Key": key,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Cache-Control": "no-store",
                    },
                ) as response:
                    observe_core_response(response.headers)
                    if response.status_code != 200:
                        raise ProviderCoreUnavailable(
                            "core_provider_request_unconfirmed",
                            response.status_code
                            if response.status_code in {401, 403, 409, 422}
                            else 503,
                        )
                    require(
                        response.headers.get_list("x-cosmaneura-native-capture-version") == ["1"]
                        and response.headers.get("content-type", "").split(";", 1)[0]
                        == "application/json"
                        and _has_no_store_directive(response.headers.get("cache-control", ""))
                        and not response.headers.get_list("set-cookie")
                    )
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        require(len(raw) + len(chunk) <= MAX_CORE_CAPTURE_RESPONSE_BYTES + 32_768)
                        raw.extend(chunk)
                value = obj(
                    json.loads(
                        raw, object_pairs_hook=unique, parse_constant=lambda _: require(False)
                    )
                )
                require(
                    set(value) == {"version", "action", "actor_ref", "tenant_ref", "result"}
                    and value["version"] == "1"
                    and value["action"] == wire_action
                    and value["actor_ref"] == before.actor_ref
                    and value["tenant_ref"] == before.tenant_ref
                )
                result = obj(value["result"])
                require(
                    result.get("contract_version") == "1"
                    and all(result.get(k) == payload[k] for k in SCOPE)
                )
                stamp = datetime.fromisoformat(cast(str, result.get("checked_at")))
                require(
                    stamp.tzinfo is not None
                    and datetime.now(UTC) - timedelta(seconds=30)
                    <= stamp
                    <= datetime.now(UTC) + timedelta(seconds=5)
                )
                if action == "capture-admissions":
                    require(
                        set(result)
                        == SCOPE
                        | {
                            "contract_version",
                            "checked_at",
                            "appointment_ref",
                            "operation_ref",
                            "session_id",
                            "consent_record_id",
                            "status",
                            "configured_capture",
                        }
                    )
                    require(
                        result["status"] == "admitted"
                        and result["configured_capture"] == payload["configured_capture"]
                    )
                    uuid(result["session_id"])
                    uuid(result["consent_record_id"])
                else:
                    discriminator = "action" if action == "capture-notes" else "operation"
                    require(
                        set(result)
                        == SCOPE | {"contract_version", "checked_at", discriminator, "receipt"}
                    )
                    require(
                        result[discriminator]
                        == (
                            payload["action"]
                            if action == "capture-notes"
                            else obj(payload["operation"])["kind"]
                        )
                    )
                    receipt = obj(result["receipt"])
                    if action == "capture-notes":
                        require(receipt.get("session_id") == payload["expected_session_id"])
                    if action == "source-start":
                        assert source_intent is not None
                        source_action = obj(payload["operation"])["action"]
                        now = datetime.now(UTC)
                        if source_action == "authorize":
                            decision = SourceStartCapability.model_validate(receipt)
                            checked_source = decision.receipt
                            require(
                                checked_source.state == "issued"
                                and checked_source.issued_at is not None
                                and checked_source.expires_at is not None
                                and checked_source.issued_at <= now + timedelta(seconds=5)
                                and checked_source.issued_at < checked_source.preparation_expires_at
                                and now
                                < checked_source.expires_at
                                <= checked_source.capture_authorized_until
                                and timedelta(0)
                                < checked_source.expires_at - checked_source.issued_at
                                <= timedelta(seconds=15)
                                and hmac.compare_digest(
                                    decision.secret.get_secret_value().encode("utf-8"),
                                    source_intent.owner_proof.get_secret_value().encode("ascii"),
                                )
                            )
                        elif source_action == "prepare":
                            checked_source = SourceStartReceipt.model_validate(receipt)
                            require(
                                checked_source.state == "prepared"
                                and checked_source.issued_at is None
                                and checked_source.expires_at is None
                                and now
                                < checked_source.preparation_expires_at
                                <= checked_source.capture_authorized_until
                            )
                        else:
                            checked_source = (
                                SourceStartRetirementReceipt.model_validate(receipt)
                                if receipt.get("state") == "unstarted"
                                else SourceStartReceipt.model_validate(receipt)
                            )
                            require(
                                checked_source.state
                                in {"cancelled", "stopped", "expired", "unstarted"}
                            )
                        require(checked_source.creator_actor_id == before.actor_ref)
                        require(
                            all(
                                getattr(checked_source, field) == getattr(source_intent, field)
                                for field in (
                                    "attempt_id",
                                    "source",
                                    "lease_id",
                                    "lease_receipt_id",
                                    "lease_generation",
                                    "capture_authorized_until",
                                    "first_sequence_number",
                                )
                            )
                        )
                        if isinstance(checked_source, SourceStartRetirementReceipt):
                            require(checked_source.owner_proof_sha256 == source_intent.proof_digest)
                if sequence is not None:
                    assert mount is not None and intent is not None and authorize_nonce is not None
                    result = source_start_reply(
                        mount, sequence, result, intent, authorize_nonce, datetime.now(UTC)
                    )
                # One publication check after parsing and pair validation. Both are
                # local, so a second adjacent check could observe nothing new.
                if await self.fresh() != before:
                    raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
                return result
        except ProviderCoreUnavailable:
            raise
        except Exception:
            raise ProviderCoreUnavailable("core_provider_request_unconfirmed") from None


def _has_no_store_directive(value: str) -> bool:
    """Recognize the directive without splitting quoted extension values."""
    start, quoted, escaped, found = 0, False, False, False
    for index, character in enumerate(value):
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character == ",":
            found |= value[start:index].strip(" \t").lower() == "no-store"
            start = index + 1
    return not quoted and (found or value[start:].strip(" \t").lower() == "no-store")


def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result
