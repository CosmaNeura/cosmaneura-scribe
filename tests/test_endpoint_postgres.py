from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
from collections.abc import AsyncGenerator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from cosmaneura_scribe import database_bootstrap
from cosmaneura_scribe.canonical_json import canonical_sha256
from cosmaneura_scribe.delivery_reconciler import DeliveryReconciler
from cosmaneura_scribe.handoff import to_master_platform_payload
from cosmaneura_scribe.main import (
    app,
    get_delivery_claim_policy,
    get_master_platform_handoff,
    get_repository_provider,
)
from cosmaneura_scribe.postgres_repository import (
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import DeliveryClaimPolicy, Repository
from cosmaneura_scribe.schemas import (
    CaptureModality,
    CaptureSession,
    ConsentMethod,
    ConsentRecord,
    DeliveryAttempt,
    DeliveryStatus,
    MasterTranscriptDeliveryRequest,
    MasterTranscriptDeliveryResponse,
    SessionStatus,
    SpeakerRole,
    Transcript,
    TranscriptDelivery,
    TranscriptSegment,
)
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

CONSENT_REQUEST_PROGRAM = r"""
import json
import os
from uuid import UUID

from cosmaneura_scribe.main import app, get_repository_provider
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.service_auth import get_verified_tenant_id
from cosmaneura_scribe.settings import Settings
from fastapi.testclient import TestClient

tenant_id = UUID(os.environ["SCRIBE_TEST_TENANT_ID"])
provider = build_postgres_provider(
    Settings(
        repository_backend="postgres",
        database_url=os.environ["SCRIBE_TEST_APP_DATABASE_URL"],
        database_ssl=False,
        database_pool_size=1,
        database_max_overflow=0,
    )
)
app.dependency_overrides[get_repository_provider] = lambda: provider
app.dependency_overrides[get_verified_tenant_id] = lambda: tenant_id
try:
    with TestClient(app) as client:
        response = client.post(
            "/v1/consents",
            headers={
                "X-Tenant-ID": str(tenant_id),
                "Idempotency-Key": "cross-process-consent-0001",
            },
            json={
                "appointment_id": "appointment-cross-process",
                "practitioner_id": "practitioner-cross-process",
                "patient_id": "patient-cross-process",
                "modality": "virtual",
                "participant_regions": ["FL", "OH"],
                "method": "pre_visit_form",
                "all_parties_consented": True,
                "granted_at": "2026-08-15T12:00:00Z",
            },
        )
        client.portal.call(provider.close)
finally:
    app.dependency_overrides.clear()

print(json.dumps({"status_code": response.status_code, "body": response.json()}, sort_keys=True))
"""


def _request_consent_in_fresh_process(
    *,
    app_url: str,
    tenant_id: str,
    hash_seed: str,
) -> dict[str, Any]:
    root = Path(__file__).resolve().parents[1]
    environment = os.environ.copy()
    source_path = str(root / "services" / "api" / "src")
    existing_pythonpath = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = (
        source_path
        if not existing_pythonpath
        else os.pathsep.join((source_path, existing_pythonpath))
    )
    environment.update(
        {
            "PYTHONHASHSEED": hash_seed,
            "SCRIBE_TEST_APP_DATABASE_URL": app_url,
            "SCRIBE_TEST_TENANT_ID": tenant_id,
        }
    )
    completed = subprocess.run(
        [sys.executable, "-c", CONSENT_REQUEST_PROGRAM],
        cwd=root,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


@pytest.mark.postgres
def test_consent_replay_survives_provider_restart_in_a_new_process(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = str(uuid4())

    first = _request_consent_in_fresh_process(
        app_url=app_url,
        tenant_id=tenant_id,
        hash_seed="1",
    )
    replay = _request_consent_in_fresh_process(
        app_url=app_url,
        tenant_id=tenant_id,
        hash_seed="2",
    )

    assert first["status_code"] == 201
    assert replay["status_code"] == 201
    assert replay["body"]["id"] == first["body"]["id"]


class ConcurrentClaimGate:
    def __init__(self) -> None:
        self._entered = 0
        self._lock = asyncio.Lock()
        self._both_entered = asyncio.Event()

    async def wait(self) -> None:
        async with self._lock:
            self._entered += 1
            if self._entered == 2:
                self._both_entered.set()
        await asyncio.wait_for(self._both_entered.wait(), timeout=5)


class CoordinatedRepository:
    def __init__(self, repository: Repository, gate: ConcurrentClaimGate) -> None:
        self._repository = repository
        self._gate = gate

    def __getattr__(self, name: str) -> Any:
        return getattr(self._repository, name)

    async def claim_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
        request_fingerprint: str,
        entity_id: UUID,
    ) -> UUID | None:
        await self._gate.wait()
        return await self._repository.claim_idempotency(
            tenant_id=tenant_id,
            operation=operation,
            key=key,
            request_fingerprint=request_fingerprint,
            entity_id=entity_id,
        )

    async def claim_delivery_attempt(
        self,
        tenant_id: UUID,
        *,
        policy: DeliveryClaimPolicy,
        delivery_id: UUID | None = None,
        excluded_delivery_ids: frozenset[UUID] = frozenset(),
    ) -> DeliveryAttempt | None:
        await self._gate.wait()
        return await self._repository.claim_delivery_attempt(
            tenant_id,
            policy=policy,
            delivery_id=delivery_id,
            excluded_delivery_ids=excluded_delivery_ids,
        )


class CoordinatedProvider:
    def __init__(
        self,
        provider: PostgresRepositoryProvider,
        gate: ConcurrentClaimGate,
    ) -> None:
        self._provider = provider
        self._gate = gate

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[Repository]:
        async with self._provider.transaction(tenant_id) as repository:
            yield CoordinatedRepository(repository, self._gate)  # type: ignore[misc]

    async def health(self) -> None:
        await self._provider.health()

    async def close(self) -> None:
        await self._provider.close()


async def _idempotency_row_count(
    database_url: str,
    *,
    tenant_id: UUID,
    key: str,
) -> int:
    engine = create_async_engine(database_url, connect_args={"ssl": False})
    try:
        async with engine.connect() as connection:
            count = await connection.scalar(
                text(
                    "SELECT count(*) FROM idempotency_records "
                    "WHERE tenant_id = :tenant_id "
                    "AND operation = 'consent.create' "
                    "AND idempotency_key = :key"
                ),
                {"tenant_id": tenant_id, "key": key},
            )
            return int(count or 0)
    finally:
        await engine.dispose()


@pytest.mark.postgres
@pytest.mark.parametrize("same_body", [True, False], ids=["replay", "conflict"])
def test_concurrent_http_idempotency_claims_are_serialized(
    postgres_urls: tuple[str, str],
    same_body: bool,
) -> None:
    admin_url, app_url = postgres_urls
    tenant_id = uuid4()
    key = f"concurrent-consent-{uuid4()}"
    provider = build_postgres_provider(
        Settings(
            repository_backend="postgres",
            database_url=app_url,
            database_ssl=False,
            database_pool_size=4,
            database_max_overflow=0,
        )
    )
    coordinated = CoordinatedProvider(provider, ConcurrentClaimGate())
    app.dependency_overrides[get_repository_provider] = lambda: coordinated
    app.dependency_overrides[get_verified_tenant_id] = lambda: tenant_id
    first_body = {
        "appointment_id": "appointment-concurrent-a",
        "practitioner_id": "practitioner-concurrent",
        "patient_id": "patient-concurrent",
        "modality": "virtual",
        "participant_regions": ["FL", "OH"],
        "method": "pre_visit_form",
        "all_parties_consented": True,
        "granted_at": "2026-08-15T12:00:00Z",
    }
    second_body = dict(first_body)
    if not same_body:
        second_body["appointment_id"] = "appointment-concurrent-b"
    request_barrier = threading.Barrier(3)

    try:
        with TestClient(app, raise_server_exceptions=False) as client:

            def submit(body: dict[str, object]) -> tuple[int, dict[str, object]]:
                request_barrier.wait(timeout=5)
                response = client.post(
                    "/v1/consents",
                    headers={
                        "X-Tenant-ID": str(tenant_id),
                        "Idempotency-Key": key,
                    },
                    json=body,
                )
                return response.status_code, response.json()

            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(submit, first_body)
                second = executor.submit(submit, second_body)
                request_barrier.wait(timeout=5)
                responses = [first.result(timeout=10), second.result(timeout=10)]
            client.portal.call(coordinated.close)
    finally:
        app.dependency_overrides.clear()

    statuses = sorted(status_code for status_code, _ in responses)
    if same_body:
        assert statuses == [201, 201]
        assert responses[0][1]["id"] == responses[1][1]["id"]
    else:
        assert statuses == [201, 409]
    assert asyncio.run(_idempotency_row_count(admin_url, tenant_id=tenant_id, key=key)) == 1


class RecordingDeliveryHandoff:
    def __init__(self) -> None:
        self.requests: list[MasterTranscriptDeliveryRequest] = []

    async def deliver(
        self,
        payload: MasterTranscriptDeliveryRequest,
        *,
        idempotency_key: str,
    ) -> MasterTranscriptDeliveryResponse:
        del idempotency_key
        self.requests.append(payload)
        return MasterTranscriptDeliveryResponse(
            schema_version="1.0",
            transcript_id="ai_visit_transcript_postgres_race",
            disposition="created",
        )

    async def close(self) -> None:
        return None


async def _seed_retryable_delivery(
    provider: PostgresRepositoryProvider,
    tenant_id: UUID,
) -> tuple[CaptureSession, TranscriptDelivery]:
    now = datetime.now(UTC)
    consent = ConsentRecord(
        id=uuid4(),
        appointment_id=f"appointment-{uuid4()}",
        practitioner_id="practitioner-postgres-race",
        patient_id="patient-postgres-race",
        modality=CaptureModality.VIRTUAL,
        participant_regions={"FL"},
        method=ConsentMethod.PRE_VISIT_FORM,
        all_parties_consented=True,
        granted_at=now,
        policy_version="all-party-v1",
    )
    session = CaptureSession(
        id=uuid4(),
        appointment_id=consent.appointment_id,
        practitioner_id=consent.practitioner_id,
        patient_id=consent.patient_id,
        consent_record_id=consent.id,
        modality=consent.modality,
        status=SessionStatus.TRANSCRIPT_READY,
        created_at=now,
    )
    transcript = Transcript(
        id=uuid4(),
        session_id=session.id,
        language_code="en-US",
        stt_provider="postgres-race-fixture",
        segments=[
            TranscriptSegment(
                speaker_id="speaker-1",
                speaker_role=SpeakerRole.CLINICIAN,
                content="Synthetic concurrent delivery fixture.",
                start_ms=0,
                end_ms=1_000,
            )
        ],
        created_at=now,
    )
    delivery = TranscriptDelivery(
        id=uuid4(),
        session_id=session.id,
        idempotency_key=f"scribe-{session.id}-v1",
        payload_sha256=canonical_sha256(to_master_platform_payload(session, transcript)),
        status=DeliveryStatus.RETRYABLE,
        attempt_count=1,
        last_error_code="transport_unavailable",
        created_at=now - timedelta(minutes=10),
        updated_at=now - timedelta(minutes=10),
    )
    async with provider.transaction(tenant_id) as store:
        await store.add_consent(tenant_id, consent)
        await store.add_session(tenant_id, session)
        await store.add_transcript(tenant_id, transcript)
        await store.add_delivery(tenant_id, delivery)
    return session, delivery


@pytest.mark.postgres
def test_concurrent_http_and_reconciler_claim_one_postgres_delivery(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = uuid4()
    provider = build_postgres_provider(
        Settings(
            repository_backend="postgres",
            database_url=app_url,
            database_ssl=False,
            database_pool_size=4,
            database_max_overflow=0,
        )
    )
    claim_policy = DeliveryClaimPolicy(retry_delay=timedelta(seconds=1))
    coordinated = CoordinatedProvider(provider, ConcurrentClaimGate())
    handoff = RecordingDeliveryHandoff()
    reconciler = DeliveryReconciler(
        repositories=coordinated,
        handoff=handoff,
        claim_policy=claim_policy,
        maximum_deliveries=1,
    )
    app.dependency_overrides[get_repository_provider] = lambda: coordinated
    app.dependency_overrides[get_verified_tenant_id] = lambda: tenant_id
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    app.dependency_overrides[get_delivery_claim_policy] = lambda: claim_policy

    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            try:
                session, original = client.portal.call(
                    _seed_retryable_delivery,
                    provider,
                    tenant_id,
                )
                with ThreadPoolExecutor(max_workers=2) as executor:
                    http_future = executor.submit(
                        client.post,
                        f"/v1/sessions/{session.id}/deliver",
                        headers={
                            "X-Tenant-ID": str(tenant_id),
                            "Idempotency-Key": "postgres-delivery-race-0001",
                        },
                    )
                    reconciler_future = executor.submit(
                        client.portal.call,
                        partial(reconciler.reconcile, tenant_id=tenant_id),
                    )
                    http_response = http_future.result(timeout=15)
                    reconcile_result = reconciler_future.result(timeout=15)

                async def read_delivery() -> TranscriptDelivery | None:
                    async with provider.transaction(tenant_id) as store:
                        return await store.get_delivery(tenant_id, original.id)

                persisted = client.portal.call(read_delivery)
            finally:
                client.portal.call(coordinated.close)
    finally:
        app.dependency_overrides.clear()

    assert http_response.status_code in {200, 409}
    assert reconcile_result.claimed in {0, 1}
    assert http_response.status_code == 200 or reconcile_result.claimed == 1
    assert len(handoff.requests) == 1
    assert persisted is not None
    assert persisted.status == DeliveryStatus.DELIVERED
    assert persisted.attempt_count == 2


@pytest.mark.postgres
def test_postgres_claim_uses_database_time_for_fresh_and_stale_pending(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    tenant_id = uuid4()
    provider = build_postgres_provider(
        Settings(
            repository_backend="postgres",
            database_url=app_url,
            database_ssl=False,
        )
    )

    async def exercise() -> tuple[DeliveryAttempt | None, DeliveryAttempt | None]:
        try:
            _, delivery = await _seed_retryable_delivery(provider, tenant_id)
            async with provider.engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        "UPDATE transcript_deliveries "
                        "SET status = 'pending', updated_at = statement_timestamp() "
                        "WHERE tenant_id = :tenant_id AND id = :delivery_id"
                    ),
                    {"tenant_id": tenant_id, "delivery_id": delivery.id},
                )
            async with provider.transaction(tenant_id) as store:
                fresh = await store.claim_delivery_attempt(
                    tenant_id,
                    delivery_id=delivery.id,
                    policy=DeliveryClaimPolicy(pending_timeout=timedelta(minutes=5)),
                )
            async with provider.engine.begin() as connection:
                await connection.execute(
                    text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                    {"tenant_id": str(tenant_id)},
                )
                await connection.execute(
                    text(
                        "UPDATE transcript_deliveries "
                        "SET updated_at = statement_timestamp() - INTERVAL '10 minutes' "
                        "WHERE tenant_id = :tenant_id AND id = :delivery_id"
                    ),
                    {"tenant_id": tenant_id, "delivery_id": delivery.id},
                )
            async with provider.transaction(tenant_id) as store:
                stale = await store.claim_delivery_attempt(
                    tenant_id,
                    delivery_id=delivery.id,
                    policy=DeliveryClaimPolicy(pending_timeout=timedelta(minutes=5)),
                )
            return fresh, stale
        finally:
            await provider.close()

    fresh, stale = asyncio.run(exercise())

    assert fresh is None
    assert stale is not None
    assert stale.attempt_count == 2


@pytest.mark.postgres
def test_delivery_reconciler_operates_with_only_approved_column_grants(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, app_url = postgres_urls
    database_name = make_url(admin_url).database
    assert database_name is not None
    role_name = f"scribe_reconciler_test_{uuid4().hex}"
    admin_engine = create_async_engine(admin_url, connect_args={"ssl": False})
    app_provider = build_postgres_provider(
        Settings(
            repository_backend="postgres",
            database_url=app_url,
            database_ssl=False,
        )
    )

    async def exercise() -> None:
        role_created = False
        restricted_provider: PostgresRepositoryProvider | None = None
        try:
            async with admin_engine.begin() as connection:
                await connection.execute(text(f"CREATE ROLE {role_name} NOLOGIN NOSUPERUSER"))
            role_created = True
            grant_settings = Settings(
                repository_backend="postgres",
                database_url=admin_url,
                database_name=database_name,
                database_ssl=False,
                database_delivery_reconciler_principal_name=role_name,
                database_delivery_reconciler_principal_object_id=uuid4(),
            )
            await database_bootstrap._grant_delivery_reconciler_permissions(grant_settings)

            restricted_engine = create_async_engine(
                admin_url,
                connect_args={
                    "ssl": False,
                    "server_settings": {"role": role_name},
                },
                pool_size=1,
                max_overflow=0,
            )
            restricted_provider = PostgresRepositoryProvider(restricted_engine)
            tenant_id = uuid4()
            session, delivery = await _seed_retryable_delivery(app_provider, tenant_id)
            handoff = RecordingDeliveryHandoff()
            reconciler = DeliveryReconciler(
                repositories=restricted_provider,
                handoff=handoff,
                claim_policy=DeliveryClaimPolicy(retry_delay=timedelta(seconds=1)),
                maximum_deliveries=1,
            )

            result = await reconciler.reconcile(tenant_id=tenant_id)
            assert result.claimed == 1
            assert result.delivered == 1
            assert len(handoff.requests) == 1
            async with app_provider.transaction(tenant_id) as store:
                persisted = await store.get_delivery(tenant_id, delivery.id)
                persisted_session = await store.get_session(tenant_id, session.id)
            assert persisted is not None
            assert persisted.status == DeliveryStatus.DELIVERED
            assert persisted_session is not None
            assert persisted_session.status == SessionStatus.HANDED_OFF
        finally:
            if restricted_provider is not None:
                await restricted_provider.close()
            await app_provider.close()
            if role_created:
                async with admin_engine.begin() as connection:
                    await connection.execute(text(f"DROP OWNED BY {role_name}"))
                    await connection.execute(text(f"DROP ROLE IF EXISTS {role_name}"))
            await admin_engine.dispose()

    asyncio.run(exercise())
