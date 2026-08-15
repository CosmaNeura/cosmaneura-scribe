from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.handoff import HandoffRetryableError
from cosmaneura_scribe.main import app, get_consent_policy, get_master_platform_handoff
from cosmaneura_scribe.schemas import (
    CaptureChannel,
    MasterTranscriptDeliveryRequest,
    MasterTranscriptDeliveryResponse,
    SessionStatus,
    SpeakerRole,
    Transcript,
    TranscriptionJobStatus,
    TranscriptSegment,
)
from cosmaneura_scribe.transcription import (
    AudioTrack,
    SttResult,
    SttSegment,
    TranscriptionRequest,
)
from cosmaneura_scribe.transcription_worker import (
    AudioAssemblyRequest,
    TranscriptionWorker,
    TranscriptionWorkerError,
)
from fastapi.testclient import TestClient


def headers(tenant_id: object, key: str) -> dict[str, str]:
    return {"X-Tenant-ID": str(tenant_id), "Idempotency-Key": key}


def create_session(
    client: TestClient, tenant_id: object
) -> tuple[dict[str, object], dict[str, object]]:
    identity = {
        "appointment_id": "appointment_01kzy09rxaepjt63rb0pv1256p",
        "practitioner_id": "doctor_01kzy09rx9emh9n9q0p0e6neam",
        "patient_id": "patient_01kzy09rxben2txt3pfy34bn6h",
        "modality": "virtual",
    }
    consent = client.post(
        "/v1/consents",
        headers=headers(tenant_id, "consent-key-1000"),
        json={
            **identity,
            "participant_regions": ["FL", "OH"],
            "method": "pre_visit_form",
            "all_parties_consented": True,
            "granted_at": datetime.now(UTC).isoformat(),
        },
    ).json()
    session = client.post(
        "/v1/sessions",
        headers=headers(tenant_id, "session-key-1000"),
        json={**identity, "consent_record_id": consent["id"]},
    ).json()
    return identity, session


class RecordingHandoff:
    def __init__(self, *, failures: int = 0) -> None:
        self.failures = failures
        self.requests: list[MasterTranscriptDeliveryRequest] = []
        self.idempotency_keys: list[str] = []

    async def deliver(
        self,
        payload: MasterTranscriptDeliveryRequest,
        *,
        idempotency_key: str,
    ) -> MasterTranscriptDeliveryResponse:
        self.requests.append(payload)
        self.idempotency_keys.append(idempotency_key)
        if self.failures:
            self.failures -= 1
            raise HandoffRetryableError("platform_http_503")
        return MasterTranscriptDeliveryResponse(
            schema_version="1.0",
            transcript_id="ai_visit_transcript_01kzy0c3m3e74q9s19kgjhrjra",
            disposition="created",
        )

    async def close(self) -> None:
        return None


class SyntheticAssembler:
    @asynccontextmanager
    async def assemble(
        self,
        request: AudioAssemblyRequest,
    ) -> AsyncIterator[tuple[AudioTrack, ...]]:
        assert request.chunks
        yield (
            AudioTrack(
                object_id=uuid4(),
                channel=CaptureChannel.MIXED,
                local_path=Path("/secure/synthetic-recovery.enc"),
            ),
        )


class RecoveryTranscriber:
    def __init__(self) -> None:
        self.call_count = 0

    @property
    def name(self) -> str:
        return "recovery_fixture"

    async def transcribe(self, request: TranscriptionRequest) -> SttResult:
        self.call_count += 1
        starts = (1_000, 0) if self.call_count == 1 else (0, 1_000)
        return SttResult(
            provider=self.name,
            language_code=request.language_code,
            duration_ms=2_000,
            segments=tuple(
                SttSegment(
                    channel=CaptureChannel.MIXED,
                    provider_speaker_id=f"speaker-{index}",
                    content="Synthetic recovery fixture.",
                    start_ms=start_ms,
                    end_ms=start_ms + 500,
                    confidence=0.95,
                )
                for index, start_ms in enumerate(starts)
            ),
        )

    async def close(self) -> None:
        return None


@pytest.fixture
def handoff_client(client: TestClient) -> tuple[TestClient, RecordingHandoff]:
    handoff = RecordingHandoff()
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    return client, handoff


def create_ready_transcript(
    client: TestClient, tenant_id: object
) -> tuple[dict[str, object], dict[str, object]]:
    identity, session = create_uploaded_session(client, tenant_id)
    transcript = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, "delivery-transcript-key-1000"),
        json={
            "language_code": "en-US",
            "stt_provider": "test_adapter",
            "segments": [
                {
                    "speaker_id": "channel-mic",
                    "speaker_role": "clinician",
                    "content": "Synthetic contract fixture.",
                    "start_ms": 0,
                    "end_ms": 1200,
                }
            ],
        },
    )
    assert transcript.status_code == 201
    return identity, session


def create_uploaded_session(
    client: TestClient, tenant_id: object
) -> tuple[dict[str, object], dict[str, object]]:
    identity, session = create_session(client, tenant_id)
    grant = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "delivery-grant-key-1000"),
        json={"sequence_number": 0, "channel": "microphone"},
    ).json()
    client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, "delivery-chunk-key-1000"),
        json={
            "sequence_number": 0,
            "channel": "microphone",
            "object_id": grant["object_id"],
            "sha256": "b" * 64,
            "ciphertext_size_bytes": 4096,
        },
    )
    complete = client.post(
        f"/v1/sessions/{session['id']}/complete",
        headers=headers(tenant_id, "delivery-complete-key-1000"),
    )
    assert complete.status_code == 200
    assert complete.json()["status"] == "uploaded"
    return identity, session


def test_consent_gated_pipeline_and_legacy_handoff(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    identity, session = create_session(client, tenant_id)
    grant = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "grant-key-1000"),
        json={"sequence_number": 0, "channel": "microphone"},
    ).json()
    chunk_body = {
        "sequence_number": 0,
        "channel": "microphone",
        "object_id": grant["object_id"],
        "sha256": "a" * 64,
        "ciphertext_size_bytes": 4096,
    }
    first_chunk = client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, "chunk-key-1000"),
        json=chunk_body,
    )
    replay = client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, "chunk-key-1000"),
        json=chunk_body,
    )
    assert replay.json()["id"] == first_chunk.json()["id"]

    complete = client.post(
        f"/v1/sessions/{session['id']}/complete",
        headers=headers(tenant_id, "complete-key-1000"),
    )
    assert complete.json()["status"] == "uploaded"

    transcript_body = {
        "language_code": "en-US",
        "stt_provider": "azure_speech",
        "segments": [
            {
                "speaker_id": "channel-mic",
                "speaker_role": "clinician",
                "content": "How have you been feeling?",
                "start_ms": 0,
                "end_ms": 1200,
                "confidence": 0.97,
            },
            {
                "speaker_id": "channel-system",
                "speaker_role": "patient",
                "content": "Much better this week.",
                "start_ms": 1400,
                "end_ms": 2900,
                "confidence": 0.95,
            },
        ],
    }
    transcript = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, "transcript-key-1000"),
        json=transcript_body,
    )
    assert transcript.status_code == 201

    handoff = client.post(
        f"/v1/sessions/{session['id']}/handoff",
        headers=headers(tenant_id, "handoff-key-1000"),
    )
    payload = handoff.json()
    assert payload["doctor_id"] == identity["practitioner_id"]
    assert payload["transcript_data"][0] == {
        "speaker": "Doctor",
        "content": "How have you been feeling?",
        "startTime": 0,
        "endTime": 1200,
    }
    assert payload["transcript_data"][1]["speaker"] == "Patient"
    assert all(
        set(event) <= {"tenant_id", "action", "entity_type", "entity_id", "occurred_at"}
        for event in repository_backend.audit_events(tenant_id)
    )


def test_upload_grant_is_short_lived_idempotent_and_metadata_only(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session = create_session(client, tenant_id)
    request = {"sequence_number": 0, "channel": "microphone"}

    first = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "grant-key-1000"),
        json=request,
    )
    replay = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, "grant-key-1000"),
        json=request,
    )

    assert first.status_code == 201
    assert replay.json() == first.json()
    assert first.json()["upload_url"].startswith("https://storage.invalid/")
    events = repository_backend.audit_events(tenant_id)
    assert [event["action"] for event in events].count("audio_upload_grant.issued") == 1
    assert all("upload_url" not in event for event in events)


def test_tenant_isolation_hides_session(client: TestClient) -> None:
    owner_tenant = uuid4()
    _, session = create_session(client, owner_tenant)
    response = client.get(
        f"/v1/sessions/{session['id']}/transcript",
        headers={"X-Tenant-ID": str(uuid4())},
    )
    assert response.status_code == 404


def test_session_cannot_complete_without_audio(client: TestClient) -> None:
    tenant_id = uuid4()
    _, session = create_session(client, tenant_id)
    response = client.post(
        f"/v1/sessions/{session['id']}/complete",
        headers=headers(tenant_id, "complete-key-2000"),
    )
    assert response.status_code == 409


def test_audio_registration_must_match_an_issued_grant(client: TestClient) -> None:
    tenant_id = uuid4()
    _, session = create_session(client, tenant_id)
    response = client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, "chunk-key-unguarded"),
        json={
            "sequence_number": 0,
            "channel": "microphone",
            "object_id": str(uuid4()),
            "sha256": "a" * 64,
            "ciphertext_size_bytes": 4096,
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "Audio object does not have an upload grant."


@pytest.mark.parametrize("invalid_case", ["unordered", "too_many", "content", "duration"])
def test_transcript_create_rejects_payloads_that_cannot_be_delivered(
    client: TestClient,
    repository_backend: RepositoryBackend,
    invalid_case: str,
) -> None:
    tenant_id = uuid4()
    _, session = create_uploaded_session(client, tenant_id)
    base_segment = {
        "speaker_id": "channel-mic",
        "speaker_role": "clinician",
        "content": "Synthetic constraint fixture.",
        "start_ms": 0,
        "end_ms": 1,
    }
    if invalid_case == "unordered":
        segments = [
            {**base_segment, "start_ms": 10, "end_ms": 20},
            {**base_segment, "start_ms": 0, "end_ms": 5},
        ]
    elif invalid_case == "too_many":
        segments = [base_segment] * 10_001
    elif invalid_case == "content":
        segments = [{**base_segment, "content": "x" * 100_001}]
    else:
        segments = [{**base_segment, "end_ms": 86_400_001}]

    response = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, f"invalid-transcript-{invalid_case}"),
        json={
            "language_code": "en-US",
            "stt_provider": "test_adapter",
            "segments": segments,
        },
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Request validation failed."}
    persisted_session = repository_backend.session_for(tenant_id, UUID(str(session["id"])))
    assert persisted_session is not None
    assert persisted_session.status == SessionStatus.UPLOADED
    assert repository_backend.transcript_for(tenant_id, persisted_session.id) is None


def test_unhandled_route_exception_is_opaque_and_consumed(
    strict_client: TestClient,
) -> None:
    sensitive_value = "Patient Jane Doe DOB 1970-01-01"

    class ExplodingConsentPolicy:
        def validate_new_record(self, _: bool) -> None:
            raise RuntimeError(sensitive_value)

    app.dependency_overrides[get_consent_policy] = ExplodingConsentPolicy
    response = strict_client.post(
        "/v1/consents",
        headers=headers(uuid4(), "opaque-error-key-0001"),
        json={
            "appointment_id": "appointment-opaque-error",
            "practitioner_id": "practitioner-opaque-error",
            "patient_id": "patient-opaque-error",
            "modality": "virtual",
            "participant_regions": ["FL"],
            "method": "pre_visit_form",
            "all_parties_consented": True,
            "granted_at": "2026-08-15T12:00:00Z",
        },
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error."}
    assert sensitive_value not in response.text


def test_complete_with_a_new_key_cannot_regress_a_ready_transcript(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session = create_ready_transcript(client, tenant_id)

    response = client.post(
        f"/v1/sessions/{session['id']}/complete",
        headers=headers(tenant_id, "complete-regression-key-0001"),
    )

    assert response.status_code == 409
    persisted = repository_backend.session_for(tenant_id, UUID(str(session["id"])))
    assert persisted is not None
    assert persisted.status == SessionStatus.TRANSCRIPT_READY


def test_legacy_handoff_rejects_an_uploaded_session_even_if_a_transcript_exists(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session_data = create_uploaded_session(client, tenant_id)
    session_id = UUID(str(session_data["id"]))
    transcript = Transcript(
        id=uuid4(),
        session_id=session_id,
        language_code="en-US",
        stt_provider="test_adapter",
        segments=[
            TranscriptSegment(
                speaker_id="channel-mic",
                speaker_role=SpeakerRole.CLINICIAN,
                content="Synthetic state guard fixture.",
                start_ms=0,
                end_ms=1_000,
            )
        ],
        created_at=datetime.now(UTC),
    )

    async def seed_transcript_without_advancing_session() -> None:
        async with repository_backend.provider.transaction(tenant_id) as repository:
            await repository.add_transcript(tenant_id, transcript)

    repository_backend.run(seed_transcript_without_advancing_session)
    response = client.post(
        f"/v1/sessions/{session_id}/handoff",
        headers=headers(tenant_id, "handoff-state-guard-0001"),
    )

    assert response.status_code == 409
    persisted = repository_backend.session_for(tenant_id, session_id)
    assert persisted is not None
    assert persisted.status == SessionStatus.UPLOADED


def test_failed_session_can_be_requeued_with_a_fresh_completion_key(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session_data = create_uploaded_session(client, tenant_id)
    session_id = UUID(str(session_data["id"]))
    transcriber = RecoveryTranscriber()
    worker = TranscriptionWorker(
        repositories=repository_backend.provider,
        assembler=SyntheticAssembler(),
        transcriber=transcriber,
    )

    async def fail_quality_gate() -> None:
        with pytest.raises(TranscriptionWorkerError) as exception:
            await worker.process(tenant_id=tenant_id, session_id=session_id)
        assert exception.value.code == "quality_gate_failed"

    repository_backend.run(fail_quality_gate)
    failed_session = repository_backend.session_for(tenant_id, session_id)
    failed_job = repository_backend.transcription_job_for(tenant_id, session_id)
    assert failed_session is not None
    assert failed_session.status == SessionStatus.FAILED
    assert failed_job is not None
    assert failed_job.status == TranscriptionJobStatus.TERMINAL

    requeue = client.post(
        f"/v1/sessions/{session_id}/complete",
        headers=headers(tenant_id, "complete-failed-requeue-0001"),
    )
    assert requeue.status_code == 200
    assert requeue.json()["status"] == "uploaded"

    transcript = repository_backend.run(
        worker.process,
        tenant_id=tenant_id,
        session_id=session_id,
    )
    assert transcript.session_id == session_id
    completed_session = repository_backend.session_for(tenant_id, session_id)
    completed_job = repository_backend.transcription_job_for(tenant_id, session_id)
    assert completed_session is not None
    assert completed_session.status == SessionStatus.TRANSCRIPT_READY
    assert completed_job is not None
    assert completed_job.status == TranscriptionJobStatus.COMPLETED
    assert completed_job.attempt_count == 1
    assert transcriber.call_count == 2


def test_readiness_reports_repository_health(client: TestClient) -> None:
    response = client.get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_idempotency_key_rejects_a_different_request(client: TestClient) -> None:
    tenant_id = uuid4()
    first = {
        "appointment_id": "appointment-idempotency",
        "practitioner_id": "practitioner-idempotency",
        "patient_id": "patient-idempotency",
        "modality": "virtual",
        "participant_regions": ["FL"],
        "method": "pre_visit_form",
        "all_parties_consented": True,
        "granted_at": datetime.now(UTC).isoformat(),
    }
    request_headers = headers(tenant_id, "consent-conflict-1000")

    assert client.post("/v1/consents", headers=request_headers, json=first).status_code == 201
    conflict = client.post(
        "/v1/consents",
        headers=request_headers,
        json={**first, "appointment_id": "appointment-changed"},
    )

    assert conflict.status_code == 409
    assert conflict.json()["detail"] == (
        "Idempotency-Key was already used with a different request."
    )


def test_master_platform_delivery_is_source_agnostic_and_idempotent(
    handoff_client: tuple[TestClient, RecordingHandoff],
    repository_backend: RepositoryBackend,
) -> None:
    client, handoff = handoff_client
    tenant_id = uuid4()
    identity, session = create_ready_transcript(client, tenant_id)
    url = f"/v1/sessions/{session['id']}/deliver"
    request_headers = headers(tenant_id, "master-delivery-key-1000")

    first = client.post(url, headers=request_headers)
    replay = client.post(url, headers=request_headers)

    assert first.status_code == 200
    assert first.json()["status"] == "delivered"
    assert first.json()["attempt_count"] == 1
    assert replay.json() == first.json()
    assert len(handoff.requests) == 1
    outbound = handoff.requests[0].model_dump(mode="json")
    assert outbound["encounter_id"] == identity["appointment_id"]
    assert outbound["scribe_session_id"] == session["id"]
    assert outbound["segments"][0]["speaker"] == "Doctor"
    assert "practitioner_id" not in outbound
    assert "patient_id" not in outbound
    assert "scheduling_provider" not in outbound
    assert handoff.idempotency_keys == [f"scribe-{session['id']}-v1"]
    actions = repository_backend.audit_actions(tenant_id)
    assert actions.count("transcript.delivery_attempted") == 1
    assert actions.count("transcript.delivered") == 1


def test_retryable_delivery_records_failure_and_reuses_outbound_key(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    handoff = RecordingHandoff(failures=1)
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    tenant_id = uuid4()
    _, session = create_ready_transcript(client, tenant_id)
    url = f"/v1/sessions/{session['id']}/deliver"
    request_headers = headers(tenant_id, "master-delivery-retry-1000")

    first = client.post(url, headers=request_headers)
    retry = client.post(url, headers=request_headers)

    assert first.status_code == 503
    assert first.json()["status"] == "retryable"
    assert first.json()["last_error_code"] == "platform_http_503"
    assert retry.status_code == 200
    assert retry.json()["status"] == "delivered"
    assert retry.json()["attempt_count"] == 2
    assert len(set(handoff.idempotency_keys)) == 1
    persisted = repository_backend.delivery_for(tenant_id, UUID(str(session["id"])))
    assert persisted is not None
    assert persisted.status == "delivered"
    assert persisted.attempt_count == 2
    assert repository_backend.audit_actions(tenant_id).count("transcript.delivery_retryable") == 1
