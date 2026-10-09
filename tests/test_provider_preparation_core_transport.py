"""Setup has no mutation; real ordinary dispatcher keeps each registry fence."""

import json
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmaneura_scribe.provider_preparation_core_transport import PATH, prepare_then_dispatch
from pydantic import SecretStr
from test_provider_native_core_transport import ACCOUNT, BINDING, SESSION, SUFFIX

pytestmark = pytest.mark.asyncio


class Wire:
    def __init__(self):
        self.checks = 0
        self.calls = []
        self.revoke_at = None
        self.alter = lambda value: value
        self.status = 200
        self.lose = None

    async def fresh(self):
        self.checks += 1
        if self.checks == self.revoke_at:
            raise ProviderCoreUnavailable("core_provider_access_unavailable", 403)
        return ACCOUNT

    async def workload(self):
        return SecretStr("invented-workload-token")

    async def handle(self, request):
        data = json.loads(request.content)
        self.calls.append((request.url.path, data, request.headers["idempotency-key"]))
        if self.lose == request.url.path:
            raise httpx.ReadError("invented reply loss")
        if request.url.path == PATH:
            assert request.headers["authorization"] == "Bearer invented-user-session-token"
            assert (
                request.headers["x-cosmaneura-workload-authorization"]
                == "Bearer invented-workload-token"
            )
            assert (
                data["action"] == "preparation_context"
                and "operation" not in data
                and "attestation" not in data
            )
            result = {
                "contract_version": "1",
                "workspace_id": data["workspace_id"],
                "binding_ref": BINDING,
                "request_nonce": data["request_nonce"],
                "checked_at": datetime.now(UTC).isoformat(),
                "appointment_ref": "appointment_" + SUFFIX,
                "preparation": data["preparation"],
                "context_token": "invented-server-context-token",
                "interaction_ref": "invented-interaction-0123456789",
                "client_turn_id": str(uuid4()),
            }
            value = {
                "version": "1",
                "action": "preparation_context",
                "actor_ref": ACCOUNT.actor_ref,
                "tenant_ref": ACCOUNT.tenant_ref,
                "result": result,
            }
            return httpx.Response(
                self.status,
                json=self.alter(value),
                headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
            )
        assert request.url.path in {
            "/service/v1/agent/scribe/capture-admissions",
            "/service/v1/agent/scribe/capture-operations",
        }
        assert (
            request.headers["authorization"] == "Bearer invented-workload-token"
            and request.headers["x-cosmaneura-mount-context"] == "invented-server-context-token"
        )
        value = {
            "contract_version": "1",
            "workspace_id": data["workspace_id"],
            "binding_ref": BINDING,
            "request_nonce": data["request_nonce"],
            "checked_at": datetime.now(UTC).isoformat(),
        }
        if request.url.path.endswith("capture-admissions"):
            value.update(
                appointment_ref="appointment_" + SUFFIX,
                operation_ref="scribe_admission_" + SUFFIX,
                session_id=SESSION,
                consent_record_id=str(uuid4()),
                status="admitted",
                configured_capture=data["configured_capture"],
            )
        else:
            value.update(
                operation="prepare_recording_window",
                receipt={"schema_version": "1.0", "session_id": SESSION},
            )
        return httpx.Response(
            200,
            json=value,
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Capture-Version": "1"},
        )

    async def call(self, action="capture-operations"):
        body = {"workspace_id": str(uuid4()), "binding_ref": BINDING, "request_nonce": str(uuid4())}
        if action == "capture-admissions":
            body.update(
                attestation={"all_parties_consented": True},
                configured_capture={"schema_version": "1.0", "language_mode": "en-US"},
            )
        else:
            body["operation"] = {"kind": "prepare_recording_window", "payload": {}}
        return body, await prepare_then_dispatch(
            "https://core.synthetic.invalid",
            action,
            body,
            "original-retained-key",
            uuid4(),
            self.fresh,
            self.workload,
            transport=httpx.MockTransport(self.handle),
        )


@pytest.mark.parametrize("action", ["capture-admissions", "capture-operations"])
async def test_two_calls_keep_original_mutation_and_six_current_registry_checks(action):
    wire = Wire()
    body, result = await wire.call(action)
    assert wire.checks == 6 and len(wire.calls) == 2
    assert wire.calls[0][0] == PATH and wire.calls[1][0] == "/service/v1/agent/scribe/" + action
    assert (
        wire.calls[1][1] == body and [row[2] for row in wire.calls] == ["original-retained-key"] * 2
    )
    assert (
        "invented-server-context-token" not in str(result)
        and "client_turn_id" not in result
        and "interaction_ref" not in result
    )


@pytest.mark.parametrize("boundary", range(1, 7))
async def test_revocation_at_each_registry_fence_blocks_later_dispatch_or_publication(boundary):
    wire = Wire()
    wire.revoke_at = boundary
    with pytest.raises(ProviderCoreUnavailable):
        await wire.call()
    assert len(wire.calls) == (0 if boundary <= 2 else 1 if boundary <= 4 else 2)


@pytest.mark.parametrize(
    "fault",
    [
        "extra",
        "actor",
        "tenant",
        "workspace",
        "binding",
        "nonce",
        "preparation",
        "expired",
        "private_key",
        "missing_token",
        "token_type",
    ],
)
async def test_malformed_context_never_reaches_mutation(fault):
    wire = Wire()

    def alter(value):
        row = value["result"]
        if fault == "extra":
            row["permission"] = True
        elif fault in {"actor", "tenant"}:
            value[fault + "_ref"] = "unknown"
        elif fault in {"workspace", "nonce"}:
            row[{"workspace": "workspace_id", "nonce": "request_nonce"}[fault]] = str(uuid4())
        elif fault == "binding":
            row["binding_ref"] = "scribe_capture_binding_" + "0" * 26
        elif fault == "preparation":
            row["preparation"] = "source_start"
        elif fault == "expired":
            row["checked_at"] = "2020-01-01T00:00:00Z"
        elif fault == "private_key":
            row["private_key"] = "invented"
        elif fault == "token_type":
            row["context_token"] = {"invented": "private"}
        else:
            row.pop("context_token")
        return value

    wire.alter = alter
    with pytest.raises((ProviderCoreUnavailable, ValueError)):
        await wire.call()
    assert len(wire.calls) == 1


@pytest.mark.parametrize("lost", [PATH, "/service/v1/agent/scribe/capture-operations"])
async def test_ambiguous_reply_never_retries_or_falls_back(lost):
    wire = Wire()
    wire.lose = lost
    with pytest.raises((ProviderCoreUnavailable, httpx.ReadError)):
        await wire.call()
    assert len(wire.calls) == (1 if lost == PATH else 2)
