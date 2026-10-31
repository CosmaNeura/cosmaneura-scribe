"""Qualified offline Clerk verifier, Core context/catalog and no SQL startup."""

import hashlib
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from core_context_receiver import CoreContextReceiver
from cosmaneura_scribe.provider_core_transport import ProviderCoreUnavailable
from cosmas_os.api import auth
from cosmas_os.config import Settings
from pydantic import SecretStr
from receiver import ProviderReceiver, ReceiverProfile
from receiver_runtime import ReceiverConfiguration, build_runtime
from test_production_composition import configured, production, validate
from test_production_native_policy import OfflineKeys, claims, settings, signed

ORIGIN = "https://synthetic-fixture-production.example.azurecontainerapps.io"
ACTOR = "authority_actor_00000000000000000000000001"
TENANT = "authority_tenant_00000000000000000000000002"
WORKSPACE = str(uuid4())
ROW = {
    "workspace_id": WORKSPACE,
    "appointment_ref": "appointment_00000000000000000000000003",
    "patient_name": "Synthetic person",
    "title": "Synthetic visit",
    "appointment_at": "2026-01-01",
}


def config(**changes):
    return validate(
        configured(
            profile="core-production-organization-v1",
            production=production(),
            authority_backend="core-provider-context-v1",
            database_host=None,
            database_name=None,
            database_reader_role=None,
            **changes,
        )
    )


def test_new_mode_is_default_off_and_cannot_mix_registry_or_staging():
    assert ReceiverConfiguration().authority_backend == "registry"
    assert not ReceiverConfiguration().enabled
    assert config().database_host is None
    for changes in (
        {"profile": "core-staging-personal-v1", "production": None},
        {"database_name": "forbidden"},
        {"core_scope": "api://00000000-0000-0000-0000-000000000000/.default"},
    ):
        values = json.loads(config().model_dump_json()) | changes
        with pytest.raises(ValueError):
            ReceiverConfiguration.model_validate_json(json.dumps(values))


def receiver(*, deny=False, revoke_after_native=False):
    projected = settings(Settings, "app://cosmas")
    verifier = auth.ClerkTokenVerifier(
        projected,
        jwks_client=OfflineKeys(),
        start_background_refresh=False,
        production_native_origin="app://cosmas",
        production_native_policy_receipt_sha256="4" * 64,
    )
    token = signed(claims(azp="app://cosmas"))
    calls = []
    revoked = False

    async def workload():
        return SecretStr("synthetic-workload-token")

    def reply(request):
        nonlocal revoked
        calls.append(str(request.url))
        assert request.headers["authorization"] == "Bearer " + token
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer synthetic-workload-token"
        )
        if request.url.path == "/service/v1/agent/scribe/native-capture":
            body = json.loads(request.content)
            assert body["expected_actor_ref"] == ACTOR and body["expected_tenant_ref"] == TENANT
            result = {
                "contract_version": "1",
                "workspace_id": body["workspace_id"],
                "binding_ref": body["binding_ref"],
                "request_nonce": body["request_nonce"],
                "checked_at": datetime.now(UTC).isoformat(),
                "operation": "encryption_key",
                "receipt": {
                    "key_version": "synthetic-key",
                    "algorithm": "RSA-OAEP-256",
                    "public_jwk": {
                        "kty": "RSA",
                        "n": "a" * 512,
                        "e": "AQAB",
                        "alg": "RSA-OAEP-256",
                        "ext": True,
                        "key_ops": ["wrapKey"],
                    },
                },
            }
            revoked = revoke_after_native
            return httpx.Response(
                200,
                json={
                    "version": "1",
                    "action": body["action"],
                    "actor_ref": ACTOR,
                    "tenant_ref": TENANT,
                    "result": result,
                },
                headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
            )
        assert (
            str(request.url)
            == "https://app.cosmaneura.com/service/v1/agent/scribe/provider-context"
        )
        if deny or revoked:
            return httpx.Response(403)
        body = json.loads(request.content)
        connection = {
            "actor_ref": ACTOR,
            "tenant_ref": TENANT,
            "provider_link_ref": "scribe_provider_link_00000000000000000000000004",
            "practice_ref": "practice_00000000000000000000000005",
            "practice_label": "Synthetic practice",
            "review_sha256": "a" * 64,
        }
        connection["connection_sha256"] = hashlib.sha256(
            json.dumps(
                connection, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest()
        catalog = (
            None
            if body["action"] == "connection"
            else {
                "version": "1",
                "action": "list",
                "request_nonce": body["request_nonce"],
                "account": {"actor_ref": ACTOR, "tenant_ref": TENANT},
                "encounters": [ROW],
            }
        )
        return httpx.Response(
            200,
            json={
                "contract_version": "1",
                **body,
                "checked_at": datetime.now(UTC).isoformat(),
                "connection": connection,
                "catalog": catalog,
            },
            headers={
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "X-Cosmaneura-Record-Version": "1",
            },
        )

    result = CoreContextReceiver(
        ReceiverProfile(ORIGIN, "https://app.cosmaneura.com", uuid4(), frozenset({"app://cosmas"})),
        None,
        projected,
        verifier,
        workload,
        enabled=True,
        encounter_creation_enabled=True,
        core_http=httpx.MockTransport(reply),
    )
    return result, token, calls, verifier


@pytest.mark.asyncio
async def test_catalog_and_selection_revalidate_core_without_any_registry(monkeypatch):
    def no_sql(*args, **kwargs):
        raise AssertionError("No registry SQL may run")

    monkeypatch.setattr("receiver.Session", no_sql)
    client, token, calls, verifier = receiver()
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app()), base_url=ORIGIN
        ) as http:
            response = await http.post(
                "/provider/v1/catalog",
                json={},
                headers={
                    "Origin": "app://cosmas",
                    "Authorization": "Bearer " + token,
                    "X-Scribe-Native-Revision": str(uuid4()),
                },
            )
            assert response.status_code == 200
            value = response.json()
            assert value["environment"] == "Production" and value["encounter_creation_v1"] is True
            assert value["existing_patient_visits_v1"] is True
            assert value["encounters"][0]["workspaceId"] == WORKSPACE
            assert response.headers["cache-control"] == "no-store"
        selected, _ = await client.selected_current("Bearer " + token, uuid4(), UUID(WORKSPACE))
        assert selected.selection.actor_ref == ACTOR and selected.selection.tenant_ref == TENANT
        assert len(calls) >= 6 and client.engine is None
        with pytest.raises(ProviderCoreUnavailable):
            await client.encounters("Bearer " + token, {"action": "create"}, str(uuid4()))
    finally:
        verifier.close()


@pytest.mark.asyncio
async def test_qualified_existing_patient_creation_uses_native_core_and_no_registry(monkeypatch):
    monkeypatch.setattr(
        "receiver.Session", lambda *_args, **_kwargs: pytest.fail("Registry forbidden")
    )
    client, token, calls, verifier = receiver()
    original = client.core_http
    assert isinstance(original, httpx.MockTransport)
    creation_key = str(uuid4())
    patient = "patient_00000000000000000000000007"

    def reply(request):
        if request.url.path != "/service/v1/agent/scribe/native-encounters":
            return original.handle_request(request)
        calls.append(str(request.url))
        assert request.headers["authorization"] == "Bearer " + token
        assert (
            request.headers["x-cosmaneura-workload-authorization"]
            == "Bearer synthetic-workload-token"
        )
        assert request.headers["idempotency-key"] == creation_key
        body = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "version": "1",
                "action": "create",
                "request_nonce": body["request_nonce"],
                "account": {"actor_ref": ACTOR, "tenant_ref": TENANT},
                "creation_key": creation_key,
                "encounter": {**ROW, "patient_ref": patient},
            },
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Scribe-Encounter-Version": "1"},
        )

    client.core_http = httpx.MockTransport(reply)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app()), base_url=ORIGIN
        ) as http:
            response = await http.post(
                "/provider/v1/encounters",
                json={
                    "action": "create",
                    "request_nonce": str(uuid4()),
                    "creation_key": creation_key,
                    "patient": {"kind": "existing", "patient_ref": patient},
                    "appointment_at": datetime.now(UTC).isoformat(),
                    "title": "Visit",
                },
                headers={
                    "Origin": "app://cosmas",
                    "Authorization": "Bearer " + token,
                    "X-Scribe-Native-Revision": str(uuid4()),
                    "Idempotency-Key": creation_key,
                },
            )
            assert response.status_code == 200 and response.json()["creation_key"] == creation_key
            assert sum("native-encounters" in path for path in calls) == 1
            assert not any("/embed/" in path for path in calls) and client.engine is None
        client.encounter_creation_enabled = False
        with pytest.raises(ProviderCoreUnavailable):
            await client.encounters("Bearer " + token, {"action": "patients"}, str(uuid4()))
    finally:
        verifier.close()


@pytest.mark.asyncio
async def test_core_denial_and_missing_signed_session_never_fall_back(monkeypatch):
    client, token, calls, verifier = receiver(deny=True)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app()), base_url=ORIGIN
        ) as http:
            response = await http.post(
                "/provider/v1/catalog",
                json={},
                headers={
                    "Origin": "app://cosmas",
                    "Authorization": "Bearer " + token,
                    "X-Scribe-Native-Revision": str(uuid4()),
                },
            )
            assert response.status_code == 403 and len(calls) == 1
        invalid = signed(claims(sid=None, azp="app://cosmas"))
        with pytest.raises(ProviderCoreUnavailable):
            await client.encounter_account("Bearer " + invalid, bind=None)
        assert len(calls) == 1
    finally:
        verifier.close()


@pytest.mark.asyncio
async def test_runtime_new_mode_never_constructs_engine_or_requests_pg_token(monkeypatch):
    calls = []
    original = auth.ClerkTokenVerifier

    class Credential:
        def __init__(self, **kwargs):
            calls.append("identity")

        async def get_token(self, scope):
            assert scope == config().core_scope
            calls.append("core-token")
            return SimpleNamespace(token="synthetic-workload-token", expires_on=10**10)

        async def close(self):
            calls.append("close")

    def make_verifier(settings, **kwargs):
        kwargs["start_background_refresh"] = False
        kwargs["jwks_client"] = OfflineKeys()
        return original(settings, **kwargs)

    def forbidden_engine(*args, **kwargs):
        raise AssertionError("No PostgreSQL engine may be created")

    monkeypatch.setattr("azure.identity.aio.ManagedIdentityCredential", Credential)
    monkeypatch.setattr(auth, "ClerkTokenVerifier", make_verifier)
    monkeypatch.setattr("sqlalchemy.ext.asyncio.create_async_engine", forbidden_engine)
    resources = await build_runtime(config())
    await resources.close()
    assert calls == ["identity", "close"]


def test_legacy_receiver_source_is_unchanged():
    import subprocess
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    original = subprocess.run(
        [
            "git",
            "show",
            "629633c6571104dc485a75f111535cc26d781d01:scripts/standalone-provider/receiver.py",
        ],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    assert original == (root / "scripts/standalone-provider/receiver.py").read_bytes()
    assert CoreContextReceiver.app is not ProviderReceiver.app


@pytest.mark.asyncio
@pytest.mark.parametrize("revoked", [False, True])
async def test_native_read_brackets_one_core_call_with_current_context(revoked, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("No registry SQL may run")

    monkeypatch.setattr("receiver.Session", forbidden)
    client, token, calls, verifier = receiver(revoke_after_native=revoked)
    body = {
        "workspace_id": WORKSPACE,
        "binding_ref": "scribe_capture_binding_00000000000000000000000006",
        "request_nonce": str(uuid4()),
        "operation": {"kind": "encryption_key"},
    }
    try:
        if revoked:
            with pytest.raises(ProviderCoreUnavailable) as denied:
                await client.native_core_read(
                    "Bearer " + token, uuid4(), "capture-operations", body, str(uuid4())
                )
            assert denied.value.status == 403
        else:
            value = await client.native_core_read(
                "Bearer " + token, uuid4(), "capture-operations", body, str(uuid4())
            )
            assert value["operation"] == "encryption_key"
        assert sum(url.endswith("/native-capture") for url in calls) == 1
        assert sum(url.endswith("/provider-context") for url in calls) >= 2
    finally:
        verifier.close()
