from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.capture_protocol_v1 import (
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_RESERVATIONS_PER_BATCH,
    PROTOCOL_VERSION,
    RESERVATION_PLAINTEXT_BUDGET_BYTES,
)
from cosmaneura_scribe.main import app
from cosmaneura_scribe.repository import (
    CaptureChannelFinalizationDraft,
    CaptureIngestModeError,
    CaptureLeaseCloseReason,
    ChunkReservationDraft,
    UploadGrantRecord,
)
from cosmaneura_scribe.schemas import (
    AudioChunk,
    CaptureChannel,
    CaptureModality,
    CaptureSession,
    ConsentMethod,
    ConsentRecord,
    SessionAudioKey,
    SessionStatus,
)
from cosmaneura_scribe.session_state_v1 import SessionIngestMode
from cosmaneura_scribe.settings import Settings, get_settings
from fastapi.testclient import TestClient


def _headers(tenant_id: UUID, key: str | None = None) -> dict[str, str]:
    headers = {"X-Tenant-ID": str(tenant_id)}
    if key is not None:
        headers["Idempotency-Key"] = key
    return headers


def _consent_and_session() -> tuple[ConsentRecord, CaptureSession]:
    now = datetime.now(UTC)
    consent = ConsentRecord(
        id=uuid4(),
        appointment_id=f"appointment-{uuid4()}",
        practitioner_id="practitioner-external-ingest",
        patient_id="patient-external-ingest",
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
        ingest_mode=SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT,
        status=SessionStatus.CREATED,
        created_at=now,
    )
    return consent, session


async def _seed_external_session(
    repository_backend: RepositoryBackend,
    tenant_id: UUID,
) -> CaptureSession:
    consent, session = _consent_and_session()
    async with repository_backend.provider.transaction(tenant_id) as store:
        await store.add_consent(tenant_id, consent)
        await store.add_session(tenant_id, session)
    return session


def _transcript_payload() -> dict[str, object]:
    return {
        "language_code": "en-US",
        "stt_provider": "synthetic_external_test",
        "segments": [
            {
                "speaker_id": "speaker-1",
                "speaker_role": "patient",
                "content": "Synthetic translated transcript fixture.",
                "start_ms": 0,
                "end_ms": 1_000,
            }
        ],
    }


def _capture_protocol_settings() -> Settings:
    return Settings(
        capture_protocol_enabled=True,
        repository_backend="postgres",
        database_url="postgresql+asyncpg://test.invalid/capture_test",
        database_ssl=False,
        workflow_authentication_enabled=True,
        entra_tenant_id=UUID("00000000-0000-4000-8000-000000000001"),
        workflow_api_audience="00000000-0000-4000-8000-000000000002",
        trusted_platform_client_id=UUID("00000000-0000-4000-8000-000000000003"),
    )


def test_public_create_request_cannot_select_external_mode(client: TestClient) -> None:
    tenant_id = uuid4()
    identity = {
        "appointment_id": "appointment-public-default",
        "practitioner_id": "practitioner-public-default",
        "patient_id": "patient-public-default",
        "modality": "virtual",
    }
    consent = client.post(
        "/v1/consents",
        headers=_headers(tenant_id, "consent-public-default"),
        json={
            **identity,
            "participant_regions": ["FL"],
            "method": "pre_visit_form",
            "all_parties_consented": True,
            "granted_at": datetime.now(UTC).isoformat(),
        },
    )
    assert consent.status_code == 201
    payload = {
        **identity,
        "consent_record_id": consent.json()["id"],
        "ingest_mode": "external_async_transcript",
    }
    created = client.post(
        "/v1/sessions",
        headers=_headers(tenant_id, "session-public-default"),
        json=payload,
    )
    replay = client.post(
        "/v1/sessions",
        headers=_headers(tenant_id, "session-public-default"),
        json={key: value for key, value in payload.items() if key != "ingest_mode"},
    )

    assert created.status_code == 201
    assert created.json()["ingest_mode"] == SessionIngestMode.CHUNK_UPLOAD
    assert replay.status_code == 201
    assert replay.json()["id"] == created.json()["id"]
    request_schema = app.openapi()["components"]["schemas"]["SessionCreate"]
    assert "ingest_mode" not in request_schema["properties"]


def test_repositories_round_trip_external_mode_and_enforce_immutability(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    other_tenant_id = uuid4()

    async def scenario() -> None:
        session = await _seed_external_session(repository_backend, tenant_id)
        async with repository_backend.provider.transaction(tenant_id) as store:
            persisted = await store.get_session(tenant_id, session.id)
            assert persisted == session
            context = await store.lock_capture_context(tenant_id, session.id)
            assert context is not None
            assert context.session.ingest_mode == SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT
            ready = session.model_copy(update={"status": SessionStatus.TRANSCRIPT_READY})
            await store.update_session(tenant_id, ready)

        async with repository_backend.provider.transaction(tenant_id) as store:
            persisted = await store.get_session(tenant_id, session.id)
            assert persisted is not None
            assert persisted.status == SessionStatus.TRANSCRIPT_READY
            assert persisted.ingest_mode == SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT
            with pytest.raises(ValueError, match="ingest mode is immutable"):
                await store.update_session(
                    tenant_id,
                    persisted.model_copy(
                        update={"ingest_mode": SessionIngestMode.CHUNK_UPLOAD}
                    ),
                )

        async with repository_backend.provider.transaction(other_tenant_id) as store:
            assert await store.get_session(other_tenant_id, session.id) is None

    repository_backend.run(scenario)


def test_repository_audio_mutations_reject_external_sessions(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()

    async def scenario() -> None:
        session = await _seed_external_session(repository_backend, tenant_id)
        now = datetime.now(UTC)
        object_id = uuid4()
        batch_id = uuid4()
        lease_id = uuid4()
        lease_receipt_id = uuid4()
        renewal_receipt_id = uuid4()
        upload_receipt_id = uuid4()
        chunk = AudioChunk(
            id=uuid4(),
            session_id=session.id,
            sequence_number=0,
            channel=CaptureChannel.MICROPHONE,
            object_id=object_id,
            sha256="a" * 64,
            ciphertext_size_bytes=4_096,
            registered_at=now,
        )
        audio_key = SessionAudioKey(
            session_id=session.id,
            key_version="synthetic-external-key-v1",
            wrapped_dek="A" * 512,
            created_at=now,
        )
        grant = UploadGrantRecord(
            object_id=object_id,
            session_id=session.id,
            sequence_number=0,
            channel=CaptureChannel.MICROPHONE,
            expires_at=now + timedelta(minutes=15),
        )
        draft = ChunkReservationDraft(
            object_id=object_id,
            sequence_number=0,
            channel=CaptureChannel.MICROPHONE,
            protocol_version=PROTOCOL_VERSION,
            additional_data=b"synthetic-external-ingest-aad",
            plaintext_budget_bytes=RESERVATION_PLAINTEXT_BUDGET_BYTES,
        )
        def ingest_mode_error() -> pytest.RaisesExc[CaptureIngestModeError]:
            return pytest.raises(
                CaptureIngestModeError,
                match="does not accept audio chunk capture",
            )

        async with repository_backend.provider.transaction(tenant_id) as store:
            with ingest_mode_error():
                await store.add_session_audio_key(tenant_id, audio_key)
            with ingest_mode_error():
                await store.issue_capture_lease(
                    tenant_id,
                    session.id,
                    lease_id=lease_id,
                    receipt_id=lease_receipt_id,
                    duration=timedelta(minutes=15),
                )
            with ingest_mode_error():
                await store.renew_capture_lease(
                    tenant_id,
                    session.id,
                    expected_lease_id=lease_id,
                    expected_generation=1,
                    receipt_id=renewal_receipt_id,
                    duration=timedelta(minutes=15),
                )
            with ingest_mode_error():
                await store.create_chunk_reservation_batch(
                    tenant_id,
                    session.id,
                    batch_id=batch_id,
                    lease_id=lease_id,
                    lease_generation=1,
                    requested_protocol_version=PROTOCOL_VERSION,
                    drafts=(draft,),
                    maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                    maximum_chunks=MAX_CHUNKS,
                    maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
                )
            with ingest_mode_error():
                await store.add_upload_authorization_receipt(
                    tenant_id,
                    session.id,
                    object_id,
                    receipt_id=upload_receipt_id,
                    duration=timedelta(minutes=15),
                )
            with ingest_mode_error():
                await store.add_reserved_chunk(
                    tenant_id,
                    chunk,
                    protocol_version=PROTOCOL_VERSION,
                )
            with ingest_mode_error():
                await store.finalize_capture_channels(
                    tenant_id,
                    session.id,
                    (
                        CaptureChannelFinalizationDraft(
                            channel=CaptureChannel.MICROPHONE,
                            last_sequence_number=0,
                        ),
                    ),
                )
            with ingest_mode_error():
                await store.add_chunk(tenant_id, chunk)
            with ingest_mode_error():
                await store.add_upload_grant(tenant_id, grant)
            with ingest_mode_error():
                await store.claim_transcription_job(
                    tenant_id,
                    session.id,
                    job_id=uuid4(),
                    lease_token=uuid4(),
                    now=now,
                    lease_until=now + timedelta(minutes=5),
                    max_attempts=3,
                )

            assert await store.get_session_audio_key(tenant_id, session.id) is None
            assert await store.get_capture_lease(tenant_id, session.id) is None
            assert (
                await store.get_capture_lease_receipt(tenant_id, lease_receipt_id)
                is None
            )
            assert (
                await store.get_capture_lease_receipt(tenant_id, renewal_receipt_id)
                is None
            )
            assert await store.get_chunk_reservation_batch(tenant_id, batch_id) is None
            assert (
                await store.get_chunk_reservation(tenant_id, session.id, object_id)
                is None
            )
            assert (
                await store.get_upload_authorization_receipt(
                    tenant_id,
                    upload_receipt_id,
                )
                is None
            )
            assert await store.get_chunk(tenant_id, chunk.id) is None
            assert await store.get_upload_grant(tenant_id, object_id) is None
            assert await store.transcription_job_for(tenant_id, session.id) is None
            assert await store.capture_finalizations_for(tenant_id, session.id) == ()
            assert not await store.close_capture_lease(
                tenant_id,
                session.id,
                expected_lease_id=lease_id,
                expected_generation=1,
                reason=CaptureLeaseCloseReason.CAPTURE_STOPPED,
            )

    repository_backend.run(scenario)


def test_external_session_accepts_transcript_but_rejects_audio_capture(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    session = repository_backend.run(_seed_external_session, repository_backend, tenant_id)

    legacy_requests = (
        (
            "POST",
            f"/v1/sessions/{session.id}/audio-key",
            {"key_version": "synthetic-key", "wrapped_dek": "A" * 512},
        ),
        (
            "POST",
            f"/v1/sessions/{session.id}/chunks/upload-grant",
            {"sequence_number": 0, "channel": "microphone"},
        ),
        (
            "POST",
            f"/v1/sessions/{session.id}/chunks",
            {
                "sequence_number": 0,
                "channel": "microphone",
                "object_id": str(uuid4()),
                "sha256": "a" * 64,
                "ciphertext_size_bytes": 4_096,
            },
        ),
        ("POST", f"/v1/sessions/{session.id}/complete", None),
    )
    for index, (method, path, body) in enumerate(legacy_requests):
        response = client.request(
            method,
            path,
            headers=_headers(tenant_id, f"external-legacy-{index:04d}"),
            json=body,
        )
        assert response.status_code == 409
        assert response.json() == {"detail": "Session does not accept audio chunk capture."}

    app.dependency_overrides[get_settings] = _capture_protocol_settings
    lease_id = uuid4()
    object_id = uuid4()
    protocol_requests = (
        ("GET", f"/v1/sessions/{session.id}/capture-capabilities", None),
        (
            "POST",
            f"/v1/sessions/{session.id}/capture-lease",
            {"protocol_version": "1.0"},
        ),
        (
            "POST",
            f"/v1/sessions/{session.id}/capture-leases/{lease_id}/renew",
            {"protocol_version": "1.0", "expected_generation": 1},
        ),
        (
            "POST",
            f"/v1/sessions/{session.id}/chunk-reservations",
            {
                "protocol_version": "1.0",
                "capture_lease_id": str(lease_id),
                "capture_lease_generation": 1,
                "channel": "microphone",
                "first_sequence_number": 0,
                "count": 1,
            },
        ),
        (
            "POST",
            f"/v1/sessions/{session.id}/chunks/{object_id}/upload-authorization",
            {"protocol_version": "1.0"},
        ),
        (
            "POST",
            f"/v1/sessions/{session.id}/chunks",
            {
                "sequence_number": 0,
                "channel": "microphone",
                "object_id": str(object_id),
                "sha256": "b" * 64,
                "ciphertext_size_bytes": 4_096,
            },
        ),
        (
            "POST",
            f"/v1/sessions/{session.id}/capture-complete",
            {
                "protocol_version": "1.0",
                "capture_lease_id": str(lease_id),
                "capture_lease_generation": 1,
                "channels": [{"channel": "microphone", "final_sequence_number": 0}],
            },
        ),
    )
    for index, (method, path, body) in enumerate(protocol_requests):
        response = client.request(
            method,
            path,
            headers=_headers(tenant_id, f"external-protocol-{index:04d}"),
            json=body,
        )
        assert response.status_code == 409
        assert response.json() == {"detail": "Session does not accept audio chunk capture."}

    assert repository_backend.audit_actions(tenant_id) == []

    async def assert_no_audio_state() -> None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.get_session_audio_key(tenant_id, session.id) is None
            assert await store.chunks_for(tenant_id, session.id) == []

    repository_backend.run(assert_no_audio_state)
    transcript = client.post(
        f"/v1/sessions/{session.id}/transcript",
        headers=_headers(tenant_id, "external-transcript-0001"),
        json=_transcript_payload(),
    )
    assert transcript.status_code == 201
    assert transcript.json()["session_id"] == str(session.id)
    hidden = client.get(
        f"/v1/sessions/{session.id}/transcript",
        headers=_headers(uuid4()),
    )
    assert hidden.status_code == 404
    persisted = repository_backend.session_for(tenant_id, session.id)
    assert persisted is not None
    assert persisted.status == SessionStatus.TRANSCRIPT_READY
    assert persisted.ingest_mode == SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT
    assert repository_backend.audit_actions(tenant_id) == ["transcript.created"]
