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
from sqlalchemy.orm import Session

ROOT = Path(os.environ["SCRIBE_PROVIDER_TEST_ROOT"]).resolve()
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
                    result.update(
                        operation=data["operation"]["kind"], receipt={"session_id": SESSION_ID}
                    )
                else:
                    result.update(action=data["action"], receipt={"session_id": SESSION_ID})
                    if data["action"] in {"save", "resolve"}:
                        self.saved.append((request.headers["idempotency-key"], data["edit"]))
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
async def test_catalog_mount_and_recorder_use_existing_identity_and_core(harness):
    h = harness
    async with client(h) as c:
        catalog = await c.post("/provider/v1/catalog", json={})
        assert catalog.status_code == 200 and catalog.headers["cache-control"] == "no-store"
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
    node = os.environ["SCRIBE_PROVIDER_NODE"]
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
