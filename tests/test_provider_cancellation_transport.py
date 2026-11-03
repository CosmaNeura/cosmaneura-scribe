from uuid import uuid4

import httpx
import pytest
from cosmaneura_scribe.provider_cancellation_transport import (
    PATH,
    ProviderCancellationTransport,
    validate_request,
    validate_response,
)
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from pydantic import SecretStr


def preview(body):
    return {
        "contract_version": "1",
        "action": "preview",
        "request_nonce": body["request_nonce"],
        "preview_sha256": "a" * 64,
        "grace_days": 90,
        "phi_scope": "core-and-scribe-clinical-records",
        "scope": "scribe-only",
        "shared_login_preserved": True,
        "resource_manifest_status": "unresolved",
    }


@pytest.mark.asyncio
async def test_fixed_account_path_and_fresh_dual_auth_without_encounter_lookup():
    seen = []

    async def verify(token):
        assert token == "synthetic-clerk-token"
        return {
            "iss": "https://synthetic.invalid",
            "sub": "synthetic-user",
            "sid": "synthetic-session",
        }

    async def workload():
        return SecretStr("synthetic-workload-token")

    def core(request):
        import json

        body = json.loads(request.content)
        seen.append(request)
        assert request.url.path == PATH and not request.url.query
        assert request.headers["Authorization"] == "Bearer synthetic-clerk-token"
        assert (
            request.headers["X-Cosmaneura-Workload-Authorization"]
            == "Bearer synthetic-workload-token"
        )
        assert "Idempotency-Key" not in request.headers
        return httpx.Response(
            200,
            json=preview(body),
            headers={"X-Cosmaneura-Record-Version": "1", "Cache-Control": "no-store"},
        )

    transport = ProviderCancellationTransport(
        "https://synthetic.invalid", verify, workload, transport=httpx.MockTransport(core)
    )
    try:
        result = await transport.request(
            "Bearer synthetic-clerk-token",
            {"action": "preview", "request_nonce": str(uuid4())},
            str(uuid4()),
        )
        assert result["shared_login_preserved"] is True
        assert len(seen) == 1
    finally:
        await transport.close()


@pytest.mark.parametrize(
    "change", [{"doctor_ref": "other"}, {"workspace_id": str(uuid4())}, {"confirmation": "DELETE"}]
)
def test_request_cannot_select_other_doctor_or_delete_shared_login(change):
    body = {
        "action": "request",
        "request_nonce": str(uuid4()),
        "preview_sha256": "a" * 64,
        "confirmation": "CANCEL",
    }
    with pytest.raises(ValueError):
        validate_request({**body, **change}, str(uuid4()))


def test_receipt_cannot_claim_erasure_or_missing_fence():
    body = {"action": "status", "request_nonce": str(uuid4())}
    result = preview(body)
    result.pop("preview_sha256")
    result.update(
        action="status",
        operation_id=str(uuid4()),
        received_at="2026-11-02T12:00:00Z",
        export_until="2027-01-31T12:00:00Z",
        phase="read-only-export",
        access_fence_confirmed=True,
        erasure_confirmed=False,
    )
    validate_response(result, body)
    for change in (
        {"erasure_confirmed": True},
        {"access_fence_confirmed": False},
        {"shared_login_preserved": False},
    ):
        with pytest.raises(ValueError):
            validate_response({**result, **change}, body)


@pytest.mark.asyncio
async def test_status_not_found_is_preserved_for_own_discovery():
    async def verify(_token):
        return {"sub": "synthetic-user"}

    async def workload():
        return SecretStr("synthetic-workload")

    transport = ProviderCancellationTransport(
        "https://synthetic.invalid",
        verify,
        workload,
        transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )
    try:
        with pytest.raises(ProviderCoreUnavailable) as error:
            await transport.request(
                "Bearer synthetic-clerk-token",
                {"action": "status", "request_nonce": str(uuid4())},
                str(uuid4()),
            )
        assert error.value.status == 404
    finally:
        await transport.close()


@pytest.mark.asyncio
async def test_account_change_during_core_call_is_not_published():
    count = 0

    async def verify(_token):
        nonlocal count
        count += 1
        return {"sub": f"synthetic-user-{count}"}

    async def workload():
        return SecretStr("synthetic-workload")

    def core(request):
        import json

        return httpx.Response(
            200,
            json=preview(json.loads(request.content)),
            headers={"X-Cosmaneura-Record-Version": "1", "Cache-Control": "no-store"},
        )

    transport = ProviderCancellationTransport(
        "https://synthetic.invalid", verify, workload, transport=httpx.MockTransport(core)
    )
    try:
        with pytest.raises(ProviderCoreUnavailable):
            await transport.request(
                "Bearer synthetic-clerk-token",
                {"action": "preview", "request_nonce": str(uuid4())},
                str(uuid4()),
            )
    finally:
        await transport.close()
