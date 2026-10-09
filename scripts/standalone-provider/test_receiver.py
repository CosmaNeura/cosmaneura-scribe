"""Real frozen identity verifier/schema, offline signing keys and a Core wire fixture.

Run only with SCRIBE_PROVIDER_TEST_ROOT pointing at the newly owned socket-only
fixture. No real account, device, Core service, speech service or model is used.
"""

import asyncio
import hashlib
import importlib.util
import json
import os
import re
import sys
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import SecretStr
from sqlalchemy import create_engine, inspect, text, update
from sqlalchemy import event as sql_event
from sqlalchemy.orm import Session


def required_test_variable(name):
    value = os.getenv(name)
    if not value:
        # An environ.__getitem__ KeyError may expose the ambient environment in
        # a pytest traceback. Only the missing harness key belongs in this error.
        raise RuntimeError(f"Synthetic receiver test setup requires {name}")
    return value


ROOT = Path(required_test_variable("SCRIBE_PROVIDER_TEST_ROOT")).resolve()
REPO = Path(__file__).resolve().parents[2]
manifest = json.loads((ROOT / "identity-source-manifest.json").read_text())
for relative, digest in manifest["files"].items():
    assert (
        hashlib.sha256((ROOT / "identity-source/cosmas_os" / relative).read_bytes()).hexdigest()
        == digest
    )
sys.path.insert(0, str(ROOT / "identity-source"))
sys.path.insert(0, str(REPO / "services/api/src"))
spec = importlib.util.spec_from_file_location(
    "provider_receiver", Path(__file__).with_name("receiver.py")
)
receiver = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = receiver
spec.loader.exec_module(receiver)

from cosmaneura_scribe.schemas import CaptureCapabilities  # noqa: E402
from cosmas_os.api.auth import ClerkTokenVerifier  # noqa: E402
from cosmas_os.db import Base  # noqa: E402
from cosmas_os.models import (  # noqa: E402
    AppointmentObservation,
    BoxContext,
    CoreCaptureAccount,
    EncounterWorkspace,
    ExternalIdentity,
    PatientLink,
    Principal,
)

SUFFIX = "01j00000000000000000000000"
APPOINTMENT = "appointment_" + SUFFIX
BINDING = "scribe_capture_binding_" + SUFFIX
SESSION_ID = str(uuid4())
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
TABLES = [
    BoxContext,
    Principal,
    ExternalIdentity,
    CoreCaptureAccount,
    PatientLink,
    AppointmentObservation,
    EncounterWorkspace,
]


@pytest.fixture(scope="module")
def engine():
    assert ROOT.name.startswith("scribe-provider-receiver-") and (ROOT / "pg/PG_VERSION").is_file()
    database = os.environ.get("SCRIBE_PROVIDER_TEST_DATABASE", "scribe_provider_receiver_test")
    assert re.fullmatch(r"scribe_provider_receiver_test(?:_r[0-9]+)?", database)
    engine = create_engine(
        "postgresql+psycopg:///" + database,
        connect_args={
            "host": str(ROOT / "socket"),
            "port": 55483,
            "options": "-c statement_timeout=5000 -c lock_timeout=2000",
        },
        hide_parameters=True,
    )
    with engine.connect() as connection:
        assert connection.scalar(text("SHOW listen_addresses")) == ""
        assert Path(connection.scalar(text("SHOW data_directory"))).resolve() == ROOT / "pg"
    # Refuse a nonempty schema. Each invocation uses a new owned database.
    assert not inspect(engine).get_table_names()
    Base.metadata.create_all(engine, tables=[model.__table__ for model in TABLES])
    yield engine
    engine.dispose()


class OfflineKeys:
    def get_signing_keys(self, *, refresh):
        return [SimpleNamespace(key_id="offline-provider", key=KEY.public_key())]


class CoreWire:
    def __init__(self):
        self.selection = None
        self.calls = []
        self.after = None
        self.saved = []
        self.operations = []
        self.review_status = "created"
        self.review_http_status = 200
        self.review_schema_version = "1.0"
        self.alter = lambda _path, _data, result: result

    async def handle(self, request):
        selected = self.selection
        path = request.url.path
        data = json.loads(request.content) if request.content else None
        self.calls.append(path)
        assert request.url.host == "core.synthetic.invalid" and request.method == "POST"
        headers = {"Cache-Control": "no-store"}
        now = datetime.now(UTC)
        if path == "/embed/v1/context-tokens/exchange":
            # The original verified native user token is forwarded only to Core's
            # existing exchange. A distinct workload token is used afterward.
            assert request.headers["authorization"].startswith("Bearer ey")
            assert data["record_ref"] == selected.appointment_ref
            result = {
                "context_token": "offline-core-mount-token",
                "token_type": "Bearer",
                "issued_at": now.isoformat(),
                "refresh_after": (now + timedelta(minutes=1)).isoformat(),
                "expires_at": (now + timedelta(minutes=2)).isoformat(),
            }
            headers["X-Cosmaneura-Embed-Version"] = "1.0"
        else:
            assert request.headers["authorization"] == "Bearer offline-workload-only"
            assert request.headers["x-cosmaneura-mount-context"] == "offline-core-mount-token"
            if path.endswith("mount-context/resolve"):
                result = {
                    "surface": "provider_assistant",
                    "auth_tier": "provider",
                    "actor_id": selected.actor_ref,
                    "tenant_id": selected.tenant_ref,
                }
                headers.update(
                    {
                        "X-Cosmaneura-Client-Turn-ID": request.headers[
                            "x-cosmaneura-client-turn-id"
                        ],
                        "X-Cosmaneura-Interaction-Ref": "offline-interaction-0123456789",
                    }
                )
            else:
                headers["X-Cosmaneura-Capture-Version"] = "1"
                result = {
                    "contract_version": "1",
                    "binding_ref": BINDING,
                    "workspace_id": str(selected.workspace_id),
                    "request_nonce": data["request_nonce"],
                    "checked_at": now.isoformat(),
                }
                if path.endswith("capture-bindings/resolve"):
                    result.update(
                        appointment_ref=selected.appointment_ref,
                        actor_ref=selected.actor_ref,
                        tenant_ref=selected.tenant_ref,
                    )
                elif path.endswith("capture-admissions"):
                    assert data["attestation"]["all_parties_consented"] is True
                    assert data["configured_capture"]["language_mode"] == "en-US+es-US"
                    result.update(
                        appointment_ref=selected.appointment_ref,
                        operation_ref="scribe_admission_" + SUFFIX,
                        session_id=SESSION_ID,
                        consent_record_id=str(uuid4()),
                    )
                elif path.endswith("capture-operations"):
                    kind = data["operation"]["kind"]
                    self.operations.append(kind)
                    if kind == "capabilities":
                        # The actual receipt deliberately has no session_id.
                        receipt = CaptureCapabilities(
                            protocol_version="1.0",
                            media={
                                "media_type": "audio/wav",
                                "encoding": "pcm_s16le",
                                "channels": 1,
                                "sample_rate_hz": 16000,
                            },
                            target_chunk_duration_ms=5000,
                            max_envelope_bytes=200000,
                            max_chunks=1000,
                            remaining_aggregate_plaintext_bytes=32000000,
                            capture_lease_ttl_seconds=300,
                            reservation_window_seconds=60,
                            max_reservations_per_batch=10,
                            upload_concurrency=2,
                        ).model_dump(mode="json")
                    elif kind == "creator_review":
                        if self.review_http_status != 200:
                            return httpx.Response(self.review_http_status, headers=headers)
                        # CreatorReviewViewV1 before a source transcript exists.
                        receipt = {
                            "schema_version": self.review_schema_version,
                            "session_id": SESSION_ID,
                            "status": self.review_status,
                            "source": None,
                            "working": None,
                            "review_queue": None,
                            "translation_progress": [],
                        }
                    elif kind == "provider_encounter":
                        receipt = {
                            "schema_version": "1.0",
                            "status": "not_prepared",
                            "review": None,
                        }
                    elif kind == "preparation_metadata":
                        receipt = {
                            "schema_version": "1.0",
                            "review": {
                                "schema_version": "1.0",
                                "session_id": SESSION_ID,
                                "status": "created",
                                "source": None,
                                "working": None,
                                "review_queue": None,
                                "translation_progress": [],
                            },
                            "encryption_key": {
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
                            "capabilities": CaptureCapabilities(
                                protocol_version="1.0",
                                media={
                                    "media_type": "audio/wav",
                                    "encoding": "pcm_s16le",
                                    "channels": 1,
                                    "sample_rate_hz": 16000,
                                },
                                target_chunk_duration_ms=5000,
                                max_envelope_bytes=200000,
                                max_chunks=1000,
                                remaining_aggregate_plaintext_bytes=32000000,
                                capture_lease_ttl_seconds=300,
                                reservation_window_seconds=60,
                                max_reservations_per_batch=10,
                                upload_concurrency=2,
                            ).model_dump(mode="json"),
                        }
                    else:
                        receipt = {"session_id": SESSION_ID}
                    result.update(operation=kind, receipt=receipt)
                else:
                    result.update(action=data["action"], receipt={"session_id": SESSION_ID})
                    if data["action"] in {"save", "resolve"}:
                        self.saved.append((request.headers["idempotency-key"], data["edit"]))
        result = self.alter(path, data, result)
        if self.after:
            self.after(path)
        return httpx.Response(
            201 if path.endswith("context-tokens/exchange") else 200, json=result, headers=headers
        )


@pytest.fixture
def harness(engine):
    h = SimpleNamespace(
        engine=engine,
        box=str(uuid4()),
        actor=str(uuid4()),
        identity=str(uuid4()),
        account=str(uuid4()),
        workspace=str(uuid4()),
        other=str(uuid4()),
        link=str(uuid4()),
        appointment=str(uuid4()),
        revision=str(uuid4()),
        subject="user_" + uuid4().hex,
    )
    with Session(engine) as s:
        s.add(BoxContext(id=h.box, display_name="Invented isolated provider fixture"))
        s.flush()
        for actor in (h.actor, h.other):
            s.add(
                Principal(
                    id=actor,
                    box_id=h.box,
                    principal_type="human",
                    state="active",
                    display_name="Invented provider",
                )
            )
        s.flush()
        s.add(
            ExternalIdentity(
                id=h.identity,
                box_id=h.box,
                principal_id=h.actor,
                provider="clerk",
                issuer="https://identity.synthetic.invalid",
                subject=h.subject,
                organization_id="org_invented",
                reviewed_by="offline fixture",
                evidence_ref="offline-only",
            )
        )
        s.flush()
        s.add(
            CoreCaptureAccount(
                id=h.account,
                external_identity_id=h.identity,
                core_actor_ref="authority_actor_" + SUFFIX,
                core_tenant_ref="authority_tenant_" + SUFFIX,
                reviewed_by="offline fixture",
                evidence_ref="offline-only",
                reviewed_at=datetime.now(UTC),
            )
        )
        s.add(
            PatientLink(
                id=h.link,
                box_id=h.box,
                source_pair_key=str(uuid4()),
                label="Invented visit",
                state="confirmed",
            )
        )
        s.flush()
        s.add(
            AppointmentObservation(
                id=h.appointment,
                box_id=h.box,
                external_id=APPOINTMENT,
                source="cosmaneura_core",
                start_at=datetime.now(UTC),
                patient_label="Invented provider visit",
                patient_link_id=h.link,
            )
        )
        s.flush()
        s.add(
            EncounterWorkspace(
                id=h.workspace,
                box_id=h.box,
                owner_id=h.actor,
                appointment_id=h.appointment,
                patient_link_id=h.link,
                create_key=str(uuid4()),
            )
        )
        s.add(
            EncounterWorkspace(
                box_id=h.box,
                owner_id=h.other,
                appointment_id=h.appointment,
                patient_link_id=h.link,
                create_key=str(uuid4()),
            )
        )
        s.commit()
    h.settings = receiver.Settings(
        _env_file=None,
        auth_mode="clerk_jwt",
        synth_seed=False,
        workspace_enabled=True,
        workspace_authenticated_enabled=True,
        workspace_apple_local_transport_enabled=True,
        beta_box_id=h.box,
        clerk_issuer="https://identity.synthetic.invalid",
        clerk_jwks_url="https://identity.synthetic.invalid/.well-known/jwks.json",
        clerk_audience="offline-provider",
        clerk_organization_id="org_invented",
        clerk_authorized_parties="capacitor://localhost",
        cors_allowed_origins="capacitor://localhost",
    )
    h.verifier = ClerkTokenVerifier(
        h.settings,
        jwks_client=OfflineKeys(),
        start_background_refresh=False,
        allow_native_session_without_origin=True,
    )
    h.profile = receiver.ReceiverProfile(
        "https://provider.synthetic.invalid",
        "https://core.synthetic.invalid",
        uuid4(),
        frozenset({"capacitor://localhost"}),
    )
    h.wire = CoreWire()

    async def workload():
        return SecretStr("offline-workload-only")

    h.receiver = receiver.ProviderReceiver(
        h.profile,
        engine,
        h.settings,
        h.verifier,
        workload,
        enabled=True,
        core_http=httpx.MockTransport(h.wire.handle),
    )

    def token(**changes):
        now = datetime.now(UTC)
        native = changes.pop("native", False)
        claims = {
            "iss": h.settings.clerk_issuer,
            "aud": h.settings.clerk_audience,
            "sub": h.subject,
            "sid": "sess_invented",
            "org_id": "org_invented",
            "azp": "capacitor://localhost",
            "iat": now,
            "nbf": now,
            "exp": now + timedelta(minutes=3),
            **changes,
        }
        if native:
            claims.pop("azp")
        return jwt.encode(
            claims,
            KEY,
            algorithm="RS256",
            headers={"kid": "offline-provider"},
        )

    h.token = token
    h.headers = {
        "Origin": "capacitor://localhost",
        "Authorization": "Bearer " + token(),
        "X-Scribe-Native-Revision": h.revision,
        "Idempotency-Key": str(uuid4()),
    }
    h.wire.selection = h.receiver.context(
        h.headers["Authorization"], UUID(h.revision), UUID(h.workspace)
    ).selection
    h.app = h.receiver.app()

    def mutate(model, identity, **changes):
        with engine.begin() as c:
            c.execute(update(model).where(model.id == identity).values(**changes))

    h.mutate = mutate
    return h


def client(h):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=h.app), base_url=h.profile.origin, headers=h.headers
    )


@pytest.mark.asyncio
async def test_request_phase_timings_cover_real_receiver_without_private_values(
    harness,
    monkeypatch,
):
    from cosmaneura_scribe import provider_performance

    h = harness
    events = []
    monkeypatch.setattr(provider_performance, "log_event", lambda **event: events.append(event))
    assert set(receiver._LIMITS) == provider_performance.PROVIDER_ACTIONS
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/mount",
            json={
                "workspace_id": h.workspace,
                "opening_nonce": str(uuid4()),
            },
        )
    assert result.status_code == 200
    assert {event["action"] for event in events} == {
        "provider.registry",
        "provider.workload_token",
        "provider.mount.total",
        "provider.core_exchange",
        "provider.core_mount",
        "provider.core_binding",
        "provider.core_operation",
    }
    assert all(set(event) == {"action", "duration_ms"} for event in events)
    assert all(event["duration_ms"] >= 0 for event in events)
    header = result.headers["server-timing"]
    metrics = dict(part.split(";dur=") for part in header.split(", "))
    assert set(metrics) == {
        "scribe_registry",
        "scribe_workload_token",
        "scribe_core_exchange",
        "scribe_core_mount",
        "scribe_core_binding",
        "scribe_core_operation",
        "scribe_core_encounter_lookup",
        "scribe_total",
    }
    for event in events:
        phase = "total" if event["action"].endswith(".total") else event["action"].split(".")[1]
        assert float(metrics["scribe_" + phase]) == round(event["duration_ms"], 3)
    for private in (h.headers["Authorization"], h.workspace, h.revision, APPOINTMENT, BINDING):
        assert private not in repr(events)
        assert private not in header


@pytest.mark.asyncio
async def test_server_timing_replaces_downstream_header_without_changing_reply(
    harness,
    monkeypatch,
):
    original = receiver._reply

    def with_untrusted_timing(*args, **kwargs):
        response = original(*args, **kwargs)
        response.headers.append("Server-Timing", "private_forbidden;desc=private")
        response.headers.append("Server-Timing", "other_forbidden;dur=1")
        return response

    monkeypatch.setattr(receiver, "_reply", with_untrusted_timing)
    async with client(harness) as connection:
        result = await connection.post(
            "/provider/v1/mount",
            json={"workspace_id": harness.workspace},
        )
    assert result.status_code == 200
    assert len(result.headers.get_list("server-timing")) == 1
    assert "private" not in result.headers["server-timing"]
    assert "forbidden" not in result.headers["server-timing"]
    assert result.headers["cache-control"] == "no-store"


def test_provider_trace_gate_is_off_by_default_and_requires_exact_staging_profile(harness):
    h = harness
    assert h.receiver._provider_trace_enabled is False
    general = receiver.ProviderReceiver(
        h.profile,
        h.receiver.engine,
        h.settings,
        h.receiver.verifier,
        h.receiver.workload_token,
        enabled=True,
        provider_trace_enabled=True,
    )
    assert general._provider_trace_enabled is False
    staging = receiver.ReceiverProfile(
        "https://cosmaneura-staging-scribe-native."
        "politesmoke-7989878f.northcentralus.azurecontainerapps.io",
        "https://staging-app.cosmaneura.com",
        uuid4(),
        frozenset({"app://cosmas"}),
        receiver.CORE_STAGING_PERSONAL,
    )
    assert staging.allows_provider_trace()
    assert not replace(staging, identity_profile="clerk-organization-v1").allows_provider_trace()
    for field in ("origin", "core_origin"):
        with pytest.raises(ValueError, match="provider_profile_invalid"):
            replace(staging, **{field: "https://production.synthetic.invalid"})


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
async def test_trace_cannot_be_spoofed_by_downstream_or_request_headers(
    harness,
    monkeypatch,
    enabled,
):
    h = harness
    # Diagnostic-only seam: retain this fixture's actual organization identity
    # verifier and synthetic hosts. Production gate is tested separately above.
    h.receiver._provider_trace_enabled = enabled
    original = receiver._reply

    def with_untrusted_trace(*args, **kwargs):
        response = original(*args, **kwargs)
        response.headers.append("X-Scribe-Provider-Trace", "private-first")
        response.headers.append("X-Scribe-Provider-Trace", "private-second")
        return response

    with monkeypatch.context() as patch:
        patch.setattr(receiver, "_reply", with_untrusted_trace)
        async with client(h) as connection:
            result = await connection.post(
                "/provider/v1/mount",
                json={"workspace_id": h.workspace},
            )
    assert result.status_code == 200
    headers = result.headers.get_list("x-scribe-provider-trace")
    assert len(headers) == int(enabled) and "private" not in repr(headers)
    assert result.headers["cache-control"] == "no-store"
    async with client(h) as connection:
        denied = await connection.post(
            "/provider/v1/mount",
            json={"workspace_id": h.workspace},
            headers={"X-Scribe-Provider-Trace": "enable"},
        )
    assert denied.status_code == 404 and "x-scribe-provider-trace" not in denied.headers


@pytest.mark.asyncio
async def test_catalog_mount_and_recorder_use_existing_identity_and_core(harness):
    h = harness
    async with client(h) as c:
        catalog = await c.post("/provider/v1/catalog", json={})
        assert catalog.status_code == 200 and catalog.headers["cache-control"] == "no-store"
        assert catalog.json()["opening_review_v1"] is True
        assert catalog.json()["note_opening_v1"] is True
        assert catalog.json()["encounters"] == [
            {
                "workspaceId": h.workspace,
                "appointmentRef": APPOINTMENT,
                "title": "Invented provider visit",
                "detail": "",
            }
        ]
        mounted = await c.post("/provider/v1/mount", json={"workspace_id": h.workspace})
        assert mounted.status_code == 200
        assert "openingReview" not in mounted.json()
        assert mounted.json()["bindingRef"] == BINDING
        for secret in (h.token(), "offline-workload-only", "offline-core-mount-token", h.subject):
            assert secret not in mounted.text
        # Recovery survives a native restart; the server authorization epoch does not.
        again = await c.post(
            "/provider/v1/mount",
            json={"workspace_id": h.workspace},
            headers={"X-Scribe-Native-Revision": str(uuid4())},
        )
        assert again.json()["recoveryScope"] == mounted.json()["recoveryScope"]
        recorder = await c.post(
            "/provider/v1/recorder",
            json={
                "workspace_id": h.workspace,
                "binding_ref": BINDING,
                "session_id": SESSION_ID,
                "request_nonce": str(uuid4()),
            },
        )
        assert recorder.status_code == 200 and recorder.json()["session_id"] == SESSION_ID
        wrong = await c.post(
            "/provider/v1/recorder",
            json={
                "workspace_id": h.workspace,
                "binding_ref": BINDING,
                "session_id": str(uuid4()),
                "request_nonce": str(uuid4()),
            },
        )
        assert wrong.status_code == 422


@pytest.mark.asyncio
async def test_optional_opening_read_reuses_setup_and_keeps_legacy_mount(harness):
    h = harness
    nonce = str(uuid4())
    async with client(h) as c:
        reply = await c.post(
            "/provider/v1/mount",
            json={
                "workspace_id": h.workspace,
                "opening_nonce": nonce,
            },
        )
        assert reply.status_code == 200 and reply.headers["cache-control"] == "no-store"
        value = reply.json()
        assert value["bindingRef"] == BINDING
        assert value["openingReview"]["request_nonce"] == nonce
        assert value["openingReview"]["operation"] == "provider_encounter"
        assert value["openingReview"]["receipt"] == {
            "schema_version": "1.0",
            "status": "not_prepared",
            "review": None,
        }
        assert len(h.wire.calls) == 4 and h.wire.operations == ["provider_encounter"]
        for secret in (h.token(), "offline-workload-only", "offline-core-mount-token", h.subject):
            assert secret not in reply.text
        legacy = await c.post("/provider/v1/mount", json={"workspace_id": h.workspace})
        assert legacy.status_code == 200 and "openingReview" not in legacy.json()
        assert len(h.wire.calls) == 7 and h.wire.operations == ["provider_encounter"]


@pytest.mark.asyncio
@pytest.mark.parametrize("nonce", [None, 4, "", "not-a-uuid"])
async def test_invalid_opening_nonce_does_not_reach_core(harness, nonce):
    h = harness
    async with client(h) as c:
        reply = await c.post(
            "/provider/v1/mount",
            json={
                "workspace_id": h.workspace,
                "opening_nonce": nonce,
            },
        )
    assert reply.status_code == 422 and h.wire.calls == []


def note_opening_body(h):
    return {
        "workspace_id": h.workspace,
        "binding_ref": BINDING,
        "expected_session_id": SESSION_ID,
        "request_nonce": str(uuid4()),
    }


def ready_note(h):
    """Only metadata for the receiver boundary; full UI parsing has its own fixtures."""
    source = {
        "kind": "reviewed_english",
        "source_version": 1,
        "working_transcript_id": str(uuid4()),
        "working_version": 1,
    }
    schema = "doctor_note_schema_" + SUFFIX

    def alter(path, data, result):
        if data and data.get("operation") == {"kind": "creator_review"}:
            result["receipt"].update(
                status="transcript_ready",
                source={"source_transcript_version": 1},
                working={
                    "working_transcript_id": source["working_transcript_id"],
                    "working_transcript_version": 1,
                    "note_ready": True,
                },
            )
        elif path.endswith("capture-notes") and data["action"] == "templates":
            result["receipt"]["templates"] = [
                {"schema_ref": schema, "note_type": "Synthetic SOAP", "field_names": ["Subjective"]}
            ]
        elif path.endswith("capture-notes") and data["action"] == "read":
            result["receipt"].update(schema_ref=schema, reviewed_source=source)
        return result

    h.wire.alter = alter


@pytest.mark.asyncio
@pytest.mark.parametrize("ready", [False, True])
async def test_note_opening_uses_real_authorization_and_read_only_core(harness, ready):
    h = harness
    if ready:
        ready_note(h)
    body = note_opening_body(h)
    async with client(h) as c:
        reply = await c.post("/provider/v1/note-opening", json=body)
    assert reply.status_code == 200 and reply.headers["cache-control"] == "no-store"
    value = reply.json()
    assert value["binding_ref"] == BINDING and value["workspace_id"] == h.workspace
    assert value["request_nonce"] == body["request_nonce"] and value["operation"] == "note_opening"
    assert value["receipt"]["session_id"] == SESSION_ID
    assert (value["receipt"]["note"] is not None) == ready
    assert len(h.wire.calls) == (6 if ready else 4)
    assert h.wire.operations == ["creator_review"] and h.wire.saved == []
    for secret in (h.token(), "offline-workload-only", "offline-core-mount-token", h.subject):
        assert secret not in reply.text


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["nonce", "session", "write", "edit", "schema"])
async def test_note_opening_rejects_unexpected_or_write_inputs_before_core(harness, change):
    h = harness
    body = note_opening_body(h)
    if change == "nonce":
        body["request_nonce"] = "invalid"
    elif change == "session":
        body["expected_session_id"] = "invalid"
    else:
        body[{"write": "action", "edit": "edit", "schema": "schema_ref"}[change]] = "forbidden"
    async with client(h) as c:
        reply = await c.post("/provider/v1/note-opening", json=body)
    assert reply.status_code == 422 and h.wire.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", range(1, 7))
async def test_note_opening_hides_every_reply_after_committed_revocation(harness, boundary):
    h = harness
    ready_note(h)

    def after(_path):
        if len(h.wire.calls) == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))

    h.wire.after = after
    async with client(h) as c:
        reply = await c.post("/provider/v1/note-opening", json=note_opening_body(h))
    assert reply.status_code == 403 and "receipt" not in reply.json()
    assert len(h.wire.calls) == boundary and h.wire.saved == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "boundary",
    [
        "/embed/v1/context-tokens/exchange",
        "/service/v1/agent/mount-context/resolve",
        "/service/v1/agent/scribe/capture-bindings/resolve",
        "/service/v1/agent/scribe/capture-operations",
    ],
)
async def test_opening_hides_reply_after_committed_registry_revocation(harness, boundary):
    h = harness

    def after(path):
        if path == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))

    h.wire.after = after
    async with client(h) as c:
        reply = await c.post(
            "/provider/v1/mount",
            json={
                "workspace_id": h.workspace,
                "opening_nonce": str(uuid4()),
            },
        )
    assert reply.status_code == 403 and "openingReview" not in reply.text
    assert h.wire.calls[-1] == boundary


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["created", "capturing", "uploaded"])
async def test_recorder_uses_session_review_and_returns_only_native_scope(harness, status):
    h = harness
    h.wire.review_status = status
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/recorder",
            json={
                "workspace_id": h.workspace,
                "binding_ref": BINDING,
                "session_id": SESSION_ID,
                "request_nonce": str(uuid4()),
            },
        )
    assert result.status_code == 200
    assert result.json() == {"revision": h.revision, "session_id": SESSION_ID}
    assert result.headers["cache-control"] == "no-store"
    assert h.wire.operations == ["creator_review"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["core_denied", "unsupported_schema", "revoked_during_reply"])
async def test_recorder_does_not_publish_denied_or_revoked_session(harness, failure):
    h = harness
    if failure == "core_denied":
        h.wire.review_http_status = 403
    elif failure == "unsupported_schema":
        h.wire.review_schema_version = "2.0"
    else:

        def revoke_after_review(path):
            if path.endswith("capture-operations"):
                h.mutate(ExternalIdentity, h.identity, active=False)

        h.wire.after = revoke_after_review
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/recorder",
            json={
                "workspace_id": h.workspace,
                "binding_ref": BINDING,
                "session_id": SESSION_ID,
                "request_nonce": str(uuid4()),
            },
        )
    assert result.status_code == (422 if failure == "unsupported_schema" else 403)
    assert "session_id" not in result.json() and "revision" not in result.json()
    assert h.wire.operations == ["creator_review"]


def source_payload(h, action):
    return {
        "workspace_id": h.workspace,
        "binding_ref": BINDING,
        "request_nonce": str(uuid4()),
        "operation": {
            "kind": "source_start",
            "action": action,
            "payload": {
                "schema_version": "1.0",
                "attempt_id": str(uuid4()),
                "source": "ios_microphone",
                "owner_proof": "d" * 64,
                "lease_id": str(uuid4()),
                "lease_receipt_id": str(uuid4()),
                "lease_generation": 1,
                "capture_authorized_until": (datetime.now(UTC) + timedelta(minutes=15)).isoformat(),
            },
        },
    }


def source_sequence_payload(h):
    def alter(path, data, response):
        if response.get("operation") != "source_start_sequence":
            return response
        intent = data["operation"]["payload"]
        now = datetime.now(UTC)
        common = {
            **{key: value for key, value in intent.items() if key != "owner_proof"},
            "session_id": SESSION_ID,
            "source_start_id": intent["attempt_id"],
            "creator_actor_id": h.wire.selection.actor_ref,
            "consent_record_id": str(uuid4()),
            "capability_id": str(uuid4()),
            "preparation_expires_at": (now + timedelta(seconds=30)).isoformat(),
        }
        prepared = {**common, "state": "prepared", "issued_at": None, "expires_at": None}
        issued = {
            **common,
            "state": "issued",
            "issued_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=15)).isoformat(),
        }
        return {
            **response,
            "receipt": {
                "preparation": prepared,
                "authorization": {"receipt": issued, "secret": intent["owner_proof"]},
            },
        }

    h.wire.alter = alter
    return {
        **source_payload(h, "prepare"),
        "authorize_idempotency_key": "offline-authorize-" + str(uuid4()),
        "authorize_request_nonce": str(uuid4()),
    }


@pytest.mark.asyncio
async def test_native_source_sequence_reuses_core_setup_and_rejects_generic_route(harness):
    h = harness
    payload = source_sequence_payload(h)
    async with client(h) as c:
        denied = await c.post("/provider/v1/capture-operations", json=payload)
        assert denied.status_code == 503 and not h.wire.calls
        result = await c.post("/provider/v1/source-start-ready", json=payload)
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
    assert result.json()["preparation"]["request_nonce"] == payload["request_nonce"]
    assert result.json()["authorization"]["request_nonce"] == payload["authorize_request_nonce"]
    assert h.wire.calls == [
        "/embed/v1/context-tokens/exchange",
        "/service/v1/agent/mount-context/resolve",
        "/service/v1/agent/scribe/capture-operations",
    ]
    assert h.wire.operations == ["source_start_sequence"]


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["capture-operations", "source-start", "source-start-ready"])
async def test_receiver_rejects_direct_core_sequence_operation(harness, route):
    h = harness
    payload = source_sequence_payload(h)
    direct = {key: value for key, value in payload.items() if not key.startswith("authorize_")}
    direct["operation"] = {
        "kind": "source_start_sequence",
        "payload": payload["operation"]["payload"],
        "authorize_idempotency_key": payload["authorize_idempotency_key"],
    }
    async with client(h) as c:
        result = await c.post("/provider/v1/" + route, json=direct)
    assert result.status_code == 503 and not h.wire.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", [1, 2, 3])
async def test_native_source_sequence_rechecks_frozen_account_after_each_core_request(
    harness,
    boundary,
):
    h = harness
    payload = source_sequence_payload(h)

    def revoke(_):
        if len(h.wire.calls) == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))

    h.wire.after = revoke
    async with client(h) as c:
        result = await c.post("/provider/v1/source-start-ready", json=payload)
    assert result.status_code == 403
    assert "preparation" not in result.json() and "authorization" not in result.json()
    assert len(h.wire.calls) == boundary
    assert h.wire.operations == ["source_start_sequence"] * max(0, boundary - 2)


@pytest.mark.asyncio
async def test_native_source_sequence_rejects_missing_second_intent_without_core_work(harness):
    h = harness
    async with client(h) as c:
        result = await c.post("/provider/v1/source-start-ready", json=source_payload(h, "prepare"))
    assert result.status_code == 503 and not h.wire.calls


@pytest.mark.asyncio
async def test_native_source_route_keeps_scope_and_generic_route_cannot_start(harness):
    h = harness
    payload = source_payload(h, "prepare")
    async with client(h) as c:
        denied = await c.post("/provider/v1/capture-operations", json=payload)
        # The existing generic transport reports unlisted operations as 503.
        # Rejection must happen before any Core request, regardless of the code.
        assert denied.status_code == 503 and not h.wire.calls
        result = await c.post("/provider/v1/source-start", json=payload)
    assert result.status_code == 200
    assert result.json()["binding_ref"] == BINDING
    assert result.json()["request_nonce"] == payload["request_nonce"]
    assert h.wire.calls == [
        "/embed/v1/context-tokens/exchange",
        "/service/v1/agent/mount-context/resolve",
        "/service/v1/agent/scribe/capture-operations",
    ]
    assert h.wire.operations == ["source_start"]


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["prepare", "authorize"])
@pytest.mark.parametrize("boundary", [1, 2, 3])
async def test_native_source_request_rechecks_frozen_account_at_each_core_boundary(
    harness,
    action,
    boundary,
):
    h = harness

    def revoke(_):
        if len(h.wire.calls) == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))

    h.wire.after = revoke
    async with client(h) as c:
        result = await c.post("/provider/v1/source-start", json=source_payload(h, action))
    assert result.status_code == 403 and "receipt" not in result.json()
    assert len(h.wire.calls) == boundary
    assert h.wire.operations == (["source_start"] if boundary == 3 else [])


@pytest.mark.asyncio
async def test_qualified_native_profile_uses_unchanged_verifier(harness):
    h = harness
    async with client(h) as c:
        good = await c.post(
            "/provider/v1/mount",
            json={"workspace_id": h.workspace},
            headers={"Authorization": "Bearer " + h.token(native=True)},
        )
        assert good.status_code == 200
        bad = await c.post(
            "/provider/v1/mount",
            json={"workspace_id": h.workspace},
            headers={"Authorization": "Bearer " + h.token(azp=None)},
        )
        # Core transport deliberately normalizes failed fresh authorization to 403.
        assert bad.status_code == 403


@pytest.mark.asyncio
async def test_account_correspondence_change_during_core_io_is_denied(harness):
    h = harness
    h.wire.after = lambda path: h.mutate(
        CoreCaptureAccount, h.account, core_actor_ref="authority_actor_01j00000000000000000000001"
    )
    async with client(h) as c:
        result = await c.post("/provider/v1/mount", json={"workspace_id": h.workspace})
    assert result.status_code == 403
    assert h.wire.calls == ["/embed/v1/context-tokens/exchange"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change,status",
    [
        ({"sub": "user_unprovisioned"}, 403),
        ({"org_id": "org_other"}, 403),
        ({"azp": "https://unapproved.invalid"}, 401),
        ({"exp": datetime.now(UTC) - timedelta(minutes=1)}, 401),
    ],
)
async def test_real_verifier_rejects_invalid_identity(harness, change, status):
    h = harness
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/catalog",
            json={},
            headers={"Authorization": "Bearer " + h.token(**change)},
        )
    assert result.status_code == status and not h.wire.calls
    assert "Invented provider visit" not in result.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model,field",
    [
        (CoreCaptureAccount, "revoked_at"),
        (PatientLink, "revoked_at"),
        (ExternalIdentity, "active"),
        (Principal, "state"),
    ],
)
async def test_committed_revocation_during_core_io_hides_reply(harness, model, field):
    h = harness
    identity = {
        CoreCaptureAccount: h.account,
        PatientLink: h.link,
        ExternalIdentity: h.identity,
        Principal: h.actor,
    }[model]
    value = {"revoked_at": datetime.now(UTC), "active": False, "state": "suspended"}[field]
    h.wire.after = lambda path: h.mutate(model, identity, **{field: value})
    async with client(h) as c:
        result = await c.post("/provider/v1/mount", json={"workspace_id": h.workspace})
    assert result.status_code == 403 and "bindingRef" not in result.text
    assert h.wire.calls == ["/embed/v1/context-tokens/exchange"]


@pytest.mark.asyncio
async def test_foreign_workspace_and_synthetic_observation_never_reach_core(harness):
    h = harness
    with Session(h.engine) as s:
        foreign = s.scalar(
            receiver.select(EncounterWorkspace.id).where(EncounterWorkspace.owner_id == h.other)
        )
    async with client(h) as c:
        assert (
            await c.post("/provider/v1/mount", json={"workspace_id": foreign})
        ).status_code == 403
        h.mutate(AppointmentObservation, h.appointment, source="synthetic")
        assert (await c.post("/provider/v1/catalog", json={})).json()["encounters"] == []
        assert (
            await c.post("/provider/v1/mount", json={"workspace_id": h.workspace})
        ).status_code == 403
    assert not h.wire.calls


@pytest.mark.asyncio
async def test_fixed_boundary_and_bounded_bodies(harness):
    h = harness
    async with client(h) as c:
        for headers in (
            {"Origin": "https://foreign.invalid"},
            {"X-Actor-Principal-ID": h.actor},
            {"X-Cosmaneura-Mount-Context": "caller-mount"},
            {"Cookie": "session=caller"},
            {"Host": "foreign.invalid"},
            {"X-Forwarded-Host": "caller"},
        ):
            assert (
                await c.post("/provider/v1/catalog", json={}, headers=headers)
            ).status_code == 404
        for path in ("/workspaces", "/provider/v1/catalog?actor=caller", "/provider/v1/unknown"):
            assert (await c.post(path, json={})).status_code == 404
        assert (await c.get("/provider/v1/catalog")).status_code == 404
        for data in ('{"extra":1}', '{"workspace_id":"a","workspace_id":"b"}', "[]"):
            action = "catalog" if data == '{"extra":1}' else "mount"
            assert (
                await c.post(
                    "/provider/v1/" + action,
                    content=data,
                    headers={"Content-Type": "application/json"},
                )
            ).status_code == 422
        h.receiver.enabled = False
        assert (await c.post("/provider/v1/catalog", json={})).status_code == 404
    assert not h.wire.calls


@pytest.mark.asyncio
async def test_current_typescript_client_runs_through_receiver(harness):
    h = harness
    node = required_test_variable("SCRIBE_PROVIDER_NODE")
    scope = {"workspaceId": h.workspace, "appointmentRef": APPOINTMENT, "bindingRef": BINDING}
    process = await asyncio.create_subprocess_exec(
        node,
        "--import",
        "tsx",
        str(REPO / "tests/browser/provider-core-client.mjs"),
        json.dumps({"scope": scope, "session": SESSION_ID}),
        cwd=REPO,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    async with client(h) as c:
        try:
            async with asyncio.timeout(30):
                while True:
                    line = await process.stdout.readline()
                    assert line, (await process.stderr.read()).decode()
                    message = json.loads(line)
                    if message.get("done"):
                        break
                    action = message["path"].removeprefix("/service/v1/agent/scribe/")
                    result = await c.post(
                        "/provider/v1/" + action,
                        json=message["body"],
                        headers={"Idempotency-Key": message["key"]},
                    )
                    assert result.status_code == 200, result.text
                    process.stdin.write(result.content + b"\n")
                    await process.stdin.drain()
                assert await process.wait() == 0
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
    assert len(h.wire.saved) == 2 and h.wire.saved[0] == h.wire.saved[1]
    assert h.wire.saved[0][1]["fields"] == {"Plan": "Invented follow-up plan"}


def test_missing_node_configuration_reports_only_the_required_key(monkeypatch):
    monkeypatch.delenv("SCRIBE_PROVIDER_NODE", raising=False)
    with pytest.raises(RuntimeError) as failure:
        required_test_variable("SCRIBE_PROVIDER_NODE")
    assert str(failure.value) == "Synthetic receiver test setup requires SCRIBE_PROVIDER_NODE"
    assert failure.value.__context__ is None


@pytest.mark.asyncio
async def test_core_owned_encounters_join_legacy_catalog_without_registry_writes(harness):
    h = harness
    h.receiver.encounter_creation_enabled = True
    entries, calls = {}, []
    original = h.wire.handle
    actor, tenant = h.wire.selection.actor_ref, h.wire.selection.tenant_ref

    async def workflow(request):
        if request.url.path != "/embed/v1/scribe/encounters":
            return await original(request)
        body = json.loads(request.content)
        calls.append(body)
        assert body["expected_actor_ref"] == actor and body["expected_tenant_ref"] == tenant
        result = {
            "version": "1",
            "action": body["action"],
            "request_nonce": body["request_nonce"],
            "account": {
                "actor_ref": actor,
                "tenant_ref": tenant,
                "email": "provider@synthetic.invalid",
            },
        }
        if body["action"] == "create":
            assert request.headers["idempotency-key"] == body["creation_key"]
            entries.setdefault(
                body["creation_key"],
                {
                    "workspace_id": str(uuid4()),
                    "appointment_ref": "appointment_" + f"{len(entries) + 1:026d}",
                    "patient_name": "Synthetic Patient",
                    "title": "Visit",
                    "appointment_at": "2026-09-29T12:00:00Z",
                },
            )
            result.update(
                creation_key=body["creation_key"], encounter=entries[body["creation_key"]]
            )
        elif body["action"] == "list":
            result["encounters"] = list(entries.values())
        else:
            result["encounter"] = next(
                e for e in entries.values() if e["workspace_id"] == body["workspace_id"]
            )
        return httpx.Response(
            200,
            json=result,
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Scribe-Encounter-Version": "1"},
        )

    h.receiver.core_http = httpx.MockTransport(workflow)
    with h.receiver.engine.connect() as connection:
        before = connection.scalar(text("SELECT count(*) FROM encounter_workspaces"))
    async with client(h) as c:
        for _ in range(3):
            key = str(uuid4())
            body = {"action": "create", "creation_key": key, "request_nonce": str(uuid4())}
            created = await c.post(
                "/provider/v1/encounters", json=body, headers={"Idempotency-Key": key}
            )
            assert created.status_code == 200
            repeated = await c.post(
                "/provider/v1/encounters",
                json={**body, "request_nonce": str(uuid4())},
                headers={"Idempotency-Key": key},
            )
            assert repeated.json()["encounter"] == created.json()["encounter"]
        catalog = await c.post("/provider/v1/catalog", json={})
        assert catalog.status_code == 200 and len(catalog.json()["encounters"]) == 4
        assert catalog.json()["account"]["email"] == "provider@synthetic.invalid"
        assert catalog.json()["environment"] == "Staging"
        for entry in entries.values():
            selected, display = await h.receiver.selected_current(
                h.headers["Authorization"], UUID(h.revision), UUID(entry["workspace_id"])
            )
            assert selected.selection.appointment_ref == entry["appointment_ref"]
            assert selected.selection.recovery_scope == h.wire.selection.recovery_scope
            assert display["title"] == "Synthetic Patient"
            assert display["patientName"] == entry["patient_name"]
            catalog_entry = next(
                e
                for e in catalog.json()["encounters"]
                if e["appointmentRef"] == entry["appointment_ref"]
            )
            assert catalog_entry["patientName"] == entry["patient_name"]
        legacy, _ = await h.receiver.selected_current(
            h.headers["Authorization"], UUID(h.revision), UUID(h.workspace)
        )
        assert legacy.selection == h.wire.selection
    with h.receiver.engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM encounter_workspaces")) == before


@pytest.mark.asyncio
async def test_new_workflow_disabled_and_legacy_revocation_cannot_fall_through(harness):
    h = harness
    async with client(h) as c:
        reply = await c.post("/provider/v1/encounters", json={"action": "list"})
        assert reply.status_code == 422 and h.wire.calls == []
        h.receiver.encounter_creation_enabled = True
        h.mutate(PatientLink, h.link, revoked_at=datetime.now(UTC))
        reply = await c.post("/provider/v1/mount", json={"workspace_id": h.workspace})
        assert reply.status_code == 403 and h.wire.calls == []


def core_created_opening(h, after_lookup=None):
    """Core-owned synthetic visit; real registry checks plus a counted Core wire."""
    h.receiver.encounter_creation_enabled = True
    workspace = uuid4()
    h.wire.selection = replace(h.wire.selection, workspace_id=workspace)
    lookups = []

    async def handle(request):
        if request.url.path == "/service/v1/agent/scribe/native-capture":
            body = json.loads(request.content)
            assert request.headers["authorization"].startswith("Bearer ey")
            assert (
                request.headers["x-cosmaneura-workload-authorization"]
                == "Bearer offline-workload-only"
            )
            assert body["workspace_id"] == str(workspace)
            assert body["expected_actor_ref"] == h.wire.selection.actor_ref
            assert body["expected_tenant_ref"] == h.wire.selection.tenant_ref
            h.wire.calls.append(request.url.path)
            value = {
                "contract_version": "1",
                "workspace_id": str(workspace),
                "binding_ref": BINDING,
                "request_nonce": body["request_nonce"],
                "checked_at": datetime.now(UTC).isoformat(),
            }
            kind = body.get("operation", {}).get("kind", "provider_encounter")
            if body["action"] != "preparation_context":
                h.wire.operations.append(kind)
            receipt = {"schema_version": "1.0", "status": "not_prepared", "review": None}
            if kind == "encryption_key":
                receipt = {
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
                }
            if kind == "native_recording_preparation":
                receipt = {
                    "schema_version": "1.0",
                    "context": {
                        "schema_version": "1.0",
                        "workspace_id": str(workspace),
                        "tenant_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                        "session_id": SESSION_ID,
                        "status": "created",
                    },
                    "encryption_key": {
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
            if body["action"] == "preparation_context":
                value.update(
                    appointment_ref=APPOINTMENT,
                    preparation=body["preparation"],
                    context_token="offline-core-mount-token",
                    interaction_ref="offline-interaction-0123456789",
                    client_turn_id=str(uuid4()),
                )
            elif body["action"] == "mount":
                value.update(
                    appointment_ref=APPOINTMENT,
                    encounter={
                        "workspace_id": str(workspace),
                        "appointment_ref": APPOINTMENT,
                        "patient_name": "Synthetic checked display",
                        "title": "Visit",
                        "appointment_at": "2026-09-30T12:00:00Z",
                    },
                )
                if "opening_nonce" in body:
                    value["opening_review"] = {
                        k: v for k, v in value.items() if k not in {"encounter", "appointment_ref"}
                    }
                    value["opening_review"].update(
                        request_nonce=body["opening_nonce"], operation=kind, receipt=receipt
                    )
            else:
                value.update(operation=kind, receipt=receipt)
            if after_lookup:
                after_lookup(1)
            return httpx.Response(
                200,
                json={
                    "version": "1",
                    "action": body["action"],
                    "actor_ref": h.wire.selection.actor_ref,
                    "tenant_ref": h.wire.selection.tenant_ref,
                    "result": value,
                },
                headers={"Cache-Control": "no-store", "X-Cosmaneura-Native-Capture-Version": "1"},
            )
        if request.url.path != "/embed/v1/scribe/encounters":
            return await h.wire.handle(request)
        body = json.loads(request.content)
        assert body["action"] == "lookup" and body["workspace_id"] == str(workspace)
        lookups.append(body["action"])
        value = {
            "version": "1",
            "action": "lookup",
            "request_nonce": body["request_nonce"],
            "account": {
                "actor_ref": h.wire.selection.actor_ref,
                "tenant_ref": h.wire.selection.tenant_ref,
            },
            "encounter": {
                "workspace_id": str(workspace),
                "appointment_ref": APPOINTMENT,
                "patient_name": f"Synthetic display {len(lookups)}",
                "title": "Visit",
                "appointment_at": "2026-09-30T12:00:00Z",
            },
        }
        if after_lookup:
            after_lookup(len(lookups))
        return httpx.Response(
            200,
            json=value,
            headers={"Cache-Control": "no-store", "X-Cosmaneura-Scribe-Encounter-Version": "1"},
        )

    h.receiver.core_http = httpx.MockTransport(handle)
    return workspace, lookups


@pytest.mark.asyncio
async def test_core_created_opening_uses_one_facade_and_keeps_checked_display(harness):
    h = harness
    workspace, lookups = core_created_opening(h)
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/mount",
            json={"workspace_id": str(workspace), "opening_nonce": str(uuid4())},
        )
    assert result.status_code == 200
    assert lookups == [] and len(h.wire.calls) == 1
    assert result.json()["encounter"]["title"] == "Synthetic checked display"
    assert result.json()["encounter"]["patientName"] == "Synthetic checked display"
    assert result.json()["encounter"]["admission_metadata_v1"] is True
    assert result.json()["encounter"]["native_recording_preparation_v1"] is True
    assert set(result.json()) == {
        "revision",
        "recoveryScope",
        "workspaceId",
        "appointmentRef",
        "bindingRef",
        "encounter",
        "openingReview",
    }
    assert h.wire.operations == ["provider_encounter"]


@pytest.mark.asyncio
async def test_core_created_opening_cannot_publish_account_revoked_during_facade(harness):
    boundary = 1
    h = harness

    def after_lookup(number):
        if number == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))

    workspace, lookups = core_created_opening(h, after_lookup)
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/mount",
            json={"workspace_id": str(workspace), "opening_nonce": str(uuid4())},
        )
    assert result.status_code == 403
    assert lookups == [] and len(h.wire.calls) == 1
    assert "Synthetic display" not in result.text


@pytest.mark.asyncio
async def test_opening_rechecks_real_account_after_workload_token_await(harness):
    h = harness
    workspace, lookups = core_created_opening(h)

    async def workload():
        await asyncio.sleep(0)
        h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))
        return SecretStr("offline-workload-only")

    h.receiver.workload_token = workload
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/mount",
            json={"workspace_id": str(workspace), "opening_nonce": str(uuid4())},
        )
    assert result.status_code == 403 and lookups == []
    assert h.wire.calls == []
    assert "Synthetic display" not in result.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [
        "creator_review",
        "native_recording_context",
        "native_recording_preparation",
        "encryption_key",
        "prepare_recording_window",
        "authorize_upload",
        "register_chunk",
        "complete",
        "source-start-ready",
    ],
)
async def test_core_created_capture_uses_six_checks_and_keeps_outer_boundaries(harness, kind):
    h = harness
    workspace, lookups = core_created_opening(h)
    body = (
        {**source_sequence_payload(h), "workspace_id": str(workspace)}
        if kind == "source-start-ready"
        else {
            "workspace_id": str(workspace),
            "binding_ref": BINDING,
            "request_nonce": str(uuid4()),
            "operation": {"kind": kind},
        }
    )
    route = kind if kind == "source-start-ready" else "capture-operations"
    async with client(h) as c:
        result = await c.post("/provider/v1/" + route, json=body)
    assert result.status_code == 200
    if kind in {
        "creator_review",
        "native_recording_context",
        "native_recording_preparation",
        "encryption_key",
    }:
        assert lookups == [] and len(h.wire.calls) == 1
    elif kind == "prepare_recording_window":
        assert lookups == [] and len(h.wire.calls) == 2
    else:
        assert len(lookups) == 6 and len(h.wire.calls) == 3
    assert h.wire.operations == ["source_start_sequence" if kind == "source-start-ready" else kind]
    assert result.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", [1, 2, 3])
async def test_native_preparation_keeps_every_real_account_fence(harness, boundary):
    h = harness
    workspace, lookups = core_created_opening(h)
    original = h.receiver.encounter_account
    calls = 0

    def account(authorization, *, bind):
        nonlocal calls
        calls += 1
        if calls == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))
        return original(authorization, bind=bind)

    h.receiver.encounter_account = account
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/capture-operations",
            json={
                "workspace_id": str(workspace),
                "binding_ref": BINDING,
                "request_nonce": str(uuid4()),
                "operation": {"kind": "native_recording_preparation"},
            },
        )
    assert result.status_code == 403 and lookups == []
    assert len(h.wire.calls) == (1 if boundary == 3 else 0)
    assert "receipt" not in result.text and "encryption_key" not in result.text


@pytest.mark.asyncio
async def test_source_start_trace_proves_order_counts_and_no_added_sql_or_core_requests(harness):
    from cosmaneura_scribe.provider_performance import TRACE_PHASES

    h = harness
    workspace, lookups = core_created_opening(h)
    select_counts = []

    def count_select(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT "):
            select_counts[-1] += 1

    sql_event.listen(h.receiver.engine, "before_cursor_execute", count_select)
    try:
        async with client(h) as connection:
            for enabled in (False, True):
                # Counts start after all fixture/identity/driver setup and reset
                # before each request; no SQL text or parameters are retained.
                select_counts.append(0)
                h.wire.calls.clear()
                lookups.clear()
                h.receiver._provider_trace_enabled = enabled
                result = await connection.post(
                    "/provider/v1/source-start-ready",
                    json={
                        **source_sequence_payload(h),
                        "workspace_id": str(workspace),
                    },
                )
                assert result.status_code == 200
                assert len(lookups) == 6 and len(h.wire.calls) == 3
                assert ("x-scribe-provider-trace" in result.headers) is enabled
    finally:
        sql_event.remove(h.receiver.engine, "before_cursor_execute", count_select)
    assert select_counts[0] == select_counts[1] > 0
    trace = result.json()  # Response contract remains source-start receipts only.
    assert set(trace) == {"preparation", "authorization"}
    value = json.loads(result.headers["x-scribe-provider-trace"])
    assert set(value) == {"v", "total_us", "counts", "spans"} and value["v"] == 1
    assert set(value["counts"]) == set(TRACE_PHASES)
    assert value["counts"]["selection_check"] == 6
    assert value["counts"]["identity_check"] == 24
    assert value["counts"]["registry"] == 30
    assert [span["phase"] for span in value["spans"] if span["phase"].startswith("core_")] == [
        "core_encounter_lookup",
        "core_encounter_lookup",
        "core_exchange",
        "core_encounter_lookup",
        "core_mount",
        "core_encounter_lookup",
        "core_operation",
        "core_encounter_lookup",
        "core_encounter_lookup",
    ]
    for span in value["spans"]:
        assert set(span) == {"phase", "start_us", "duration_us"}
        assert span["start_us"] + span["duration_us"] <= value["total_us"]
    for private in (
        h.headers["Authorization"],
        str(workspace),
        h.revision,
        APPOINTMENT,
        BINDING,
        h.wire.selection.actor_ref,
        h.wire.selection.tenant_ref,
        "Synthetic display",
    ):
        assert private not in result.headers["x-scribe-provider-trace"]


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", range(1, 7))
@pytest.mark.parametrize("source_sequence", [False, True])
async def test_capture_lookup_revocation_blocks_initial_adjacent_and_final_publication(
    harness,
    boundary,
    source_sequence,
):
    h = harness
    h.receiver._provider_trace_enabled = True

    def after_lookup(number):
        if number == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))

    workspace, lookups = core_created_opening(h, after_lookup)
    body = (
        {**source_sequence_payload(h), "workspace_id": str(workspace)}
        if source_sequence
        else {
            "workspace_id": str(workspace),
            "binding_ref": BINDING,
            "request_nonce": str(uuid4()),
            "operation": {"kind": "complete"},
        }
    )
    route = "source-start-ready" if source_sequence else "capture-operations"
    async with client(h) as c:
        result = await c.post("/provider/v1/" + route, json=body)
    assert result.status_code == 403 and len(lookups) == boundary
    assert len(h.wire.calls) == [0, 0, 1, 2, 3, 3][boundary - 1]
    assert "receipt" not in result.json() and "authorization" not in result.json()
    assert len(h.wire.operations) == (1 if boundary >= 5 else 0)
    trace = json.loads(result.headers["x-scribe-provider-trace"])
    assert trace["counts"]["core_encounter_lookup"] == boundary
    assert trace["counts"]["selection_check"] == boundary
    assert sum(n for phase, n in trace["counts"].items() if phase.startswith("core_")) == (
        boundary + len(h.wire.calls)
    )
    if boundary == 6:
        # The operation already returned before this final receiver check.
        # Its durable remote effect must not make a revoked reply publishable.
        assert len(h.wire.operations) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["capture-admissions", "capture-operations"])
async def test_core_preparation_setup_keeps_six_real_account_fences(harness, action):
    h = harness
    workspace, lookups = core_created_opening(h)
    h.receiver._provider_trace_enabled = True
    body = {"workspace_id": str(workspace), "binding_ref": BINDING, "request_nonce": str(uuid4())}
    if action == "capture-admissions":
        body.update(
            attestation={"all_parties_consented": True},
            configured_capture={"schema_version": "1.0", "language_mode": "en-US+es-US"},
        )
    else:
        body["operation"] = {"kind": "prepare_recording_window"}
    async with client(h) as c:
        result = await c.post("/provider/v1/" + action, json=body)
    assert result.status_code == 200 and lookups == [] and len(h.wire.calls) == 2
    trace = json.loads(result.headers["x-scribe-provider-trace"])
    assert trace["counts"]["selection_check"] == 0 and trace["counts"]["identity_check"] == 6
    assert "offline-core-mount-token" not in result.text and "interaction_ref" not in result.text


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", range(1, 7))
async def test_preparation_real_registry_revocation_stops_before_mutation_or_publication(
    harness, boundary
):
    h = harness
    workspace, lookups = core_created_opening(h)
    original = h.receiver.encounter_account
    calls = 0

    def account(authorization, *, bind):
        nonlocal calls
        calls += 1
        if calls == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))
        return original(authorization, bind=bind)

    h.receiver.encounter_account = account
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/capture-operations",
            json={
                "workspace_id": str(workspace),
                "binding_ref": BINDING,
                "request_nonce": str(uuid4()),
                "operation": {"kind": "prepare_recording_window"},
            },
        )
    assert result.status_code == 403 and lookups == []
    assert len(h.wire.calls) == (0 if boundary <= 2 else 1 if boundary <= 4 else 2)
    assert "receipt" not in result.text and "offline-core-mount-token" not in result.text


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", range(10))
async def test_combined_admission_metadata_keeps_nine_real_registry_fences(harness, boundary):
    h = harness
    workspace, lookups = core_created_opening(h)
    original = h.receiver.encounter_account
    checks = 0

    def account(authorization, *, bind):
        nonlocal checks
        checks += 1
        if checks == boundary:
            h.mutate(CoreCaptureAccount, h.account, revoked_at=datetime.now(UTC))
        return original(authorization, bind=bind)

    h.receiver.encounter_account = account
    h.receiver._provider_trace_enabled = True
    async with client(h) as c:
        result = await c.post(
            "/provider/v1/capture-admissions",
            json={
                "workspace_id": str(workspace),
                "binding_ref": BINDING,
                "request_nonce": str(uuid4()),
                "attestation": {"all_parties_consented": True},
                "configured_capture": {"schema_version": "1.0", "language_mode": "en-US+es-US"},
                "preparation_metadata": True,
            },
        )
    assert lookups == []
    assert "offline-core-mount-token" not in result.text and "interaction_ref" not in result.text
    if boundary:
        assert result.status_code == 403 and "preparation_metadata" not in result.text
        assert len(h.wire.calls) == (
            0 if boundary <= 2 else 1 if boundary <= 4 else 2 if boundary <= 7 else 3
        )
    else:
        assert result.status_code == 200 and len(h.wire.calls) == 3
        assert result.json()["preparation_metadata"]["review"]["session_id"] == SESSION_ID
        assert (
            json.loads(result.headers["x-scribe-provider-trace"])["counts"]["identity_check"] == 9
        )
