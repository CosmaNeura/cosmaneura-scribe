from __future__ import annotations

import base64
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend
from cosmaneura_scribe.consent import ConsentError
from cosmaneura_scribe.delivery_reconciler import DeliveryReconciler
from cosmaneura_scribe.handoff import HandoffRetryableError
from cosmaneura_scribe.main import (
    app,
    get_audio_encryption_key_provider,
    get_consent_policy,
    get_delivery_claim_policy,
    get_master_platform_handoff,
)
from cosmaneura_scribe.repository import (
    DeliveryClaimPolicy,
    DeliverySuccessConflictError,
    RepositoryProvider,
)
from cosmaneura_scribe.schemas import (
    AudioEncryptionPublicKey,
    CaptureChannel,
    DeliveryStatus,
    MasterTranscriptDeliveryRequest,
    MasterTranscriptDeliveryResponse,
    RsaPublicJwk,
    SessionStatus,
    SpeakerRole,
    Transcript,
    TranscriptDelivery,
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


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


TEST_WRAPPED_DEK = _base64url(b"w" * 384)
TEST_RSA_3072_MODULUS = _base64url(b"\x80" + b"m" * 383)


class PipelineAudioKeyProvider:
    async def get_public_key(self) -> AudioEncryptionPublicKey:
        return AudioEncryptionPublicKey(
            key_version="pipeline-version-1",
            public_jwk=RsaPublicJwk(n=TEST_RSA_3072_MODULUS, e="AQAB"),
        )

    def versioned_key_id(self, key_version: str) -> str | None:
        if key_version != "pipeline-version-1":
            return None
        return f"https://scribe-test.vault.azure.net/keys/audio-encryption/{key_version}"

    async def close(self) -> None:
        return None


def create_session(
    client: TestClient,
    tenant_id: object,
    *,
    key_suffix: str = "1000",
) -> tuple[dict[str, object], dict[str, object]]:
    identity = {
        "appointment_id": "appointment_01kzy09rxaepjt63rb0pv1256p",
        "practitioner_id": "doctor_01kzy09rx9emh9n9q0p0e6neam",
        "patient_id": "patient_01kzy09rxben2txt3pfy34bn6h",
        "modality": "virtual",
    }
    consent = client.post(
        "/v1/consents",
        headers=headers(tenant_id, f"consent-key-{key_suffix}"),
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
        headers=headers(tenant_id, f"session-key-{key_suffix}"),
        json={**identity, "consent_record_id": consent["id"]},
    ).json()
    app.dependency_overrides[get_audio_encryption_key_provider] = PipelineAudioKeyProvider
    audio_key = client.post(
        f"/v1/sessions/{session['id']}/audio-key",
        headers=headers(tenant_id, f"audio-key-{key_suffix}"),
        json={"key_version": "pipeline-version-1", "wrapped_dek": TEST_WRAPPED_DEK},
    )
    assert audio_key.status_code == 201
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


class ConcurrentSessionFailureHandoff(RecordingHandoff):
    def __init__(
        self,
        *,
        repositories: RepositoryProvider,
        tenant_id: UUID,
        session_id: UUID,
    ) -> None:
        super().__init__()
        self._repositories = repositories
        self._tenant_id = tenant_id
        self._session_id = session_id

    async def deliver(
        self,
        payload: MasterTranscriptDeliveryRequest,
        *,
        idempotency_key: str,
    ) -> MasterTranscriptDeliveryResponse:
        result = await super().deliver(payload, idempotency_key=idempotency_key)
        async with self._repositories.transaction(self._tenant_id) as store:
            session = await store.lock_session(self._tenant_id, self._session_id)
            assert session is not None
            await store.update_session(
                self._tenant_id,
                session.model_copy(update={"status": SessionStatus.FAILED}),
            )
        return result


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
    client: TestClient,
    tenant_id: object,
    *,
    key_suffix: str = "1000",
) -> tuple[dict[str, object], dict[str, object]]:
    identity, session = create_uploaded_session(client, tenant_id, key_suffix=key_suffix)
    transcript = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, f"delivery-transcript-key-{key_suffix}"),
        json=_ready_transcript_payload(),
    )
    assert transcript.status_code == 201
    return identity, session


def _ready_transcript_payload() -> dict[str, object]:
    return {
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
    }


def create_uploaded_session(
    client: TestClient,
    tenant_id: object,
    *,
    key_suffix: str = "1000",
) -> tuple[dict[str, object], dict[str, object]]:
    identity, session = create_session(client, tenant_id, key_suffix=key_suffix)
    grant = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=headers(tenant_id, f"delivery-grant-key-{key_suffix}"),
        json={"sequence_number": 0, "channel": "microphone"},
    ).json()
    client.post(
        f"/v1/sessions/{session['id']}/chunks",
        headers=headers(tenant_id, f"delivery-chunk-key-{key_suffix}"),
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
        headers=headers(tenant_id, f"delivery-complete-key-{key_suffix}"),
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


def test_upload_grant_replay_revalidates_current_consent(client: TestClient) -> None:
    tenant_id = uuid4()
    _, session = create_session(client, tenant_id)
    request = {"sequence_number": 0, "channel": "microphone"}
    request_headers = headers(tenant_id, "grant-consent-replay-1000")
    first = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=request_headers,
        json=request,
    )
    assert first.status_code == 201

    class RejectSessionConsentPolicy:
        def validate_session(self, *_: object) -> None:
            raise ConsentError("consent_invalid")

    app.dependency_overrides[get_consent_policy] = RejectSessionConsentPolicy
    replay = client.post(
        f"/v1/sessions/{session['id']}/chunks/upload-grant",
        headers=request_headers,
        json=request,
    )

    assert replay.status_code == 409
    assert replay.json() == {"detail": "consent_invalid"}


def test_transcript_replay_revalidates_current_consent(client: TestClient) -> None:
    tenant_id = uuid4()
    _, session = create_ready_transcript(client, tenant_id, key_suffix="consent-replay")

    class RejectSessionConsentPolicy:
        def validate_session(self, *_: object) -> None:
            raise ConsentError("consent_invalid")

    app.dependency_overrides[get_consent_policy] = RejectSessionConsentPolicy
    replay = client.post(
        f"/v1/sessions/{session['id']}/transcript",
        headers=headers(tenant_id, "delivery-transcript-key-consent-replay"),
        json=_ready_transcript_payload(),
    )

    assert replay.status_code == 409
    assert replay.json() == {"detail": "consent_invalid"}
    assert "Synthetic contract fixture" not in replay.text


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


def test_delivered_same_key_replay_precedes_mutable_consent_guards(
    handoff_client: tuple[TestClient, RecordingHandoff],
) -> None:
    client, handoff = handoff_client
    tenant_id = uuid4()
    _, session = create_ready_transcript(client, tenant_id, key_suffix="durable-replay")
    url = f"/v1/sessions/{session['id']}/deliver"
    original_headers = headers(tenant_id, "delivery-durable-replay-0001")
    accepted = client.post(url, headers=original_headers)
    assert accepted.status_code == 200

    class RejectSessionConsentPolicy:
        def validate_session(self, *_: object) -> None:
            raise ConsentError("consent_invalid")

    app.dependency_overrides[get_consent_policy] = RejectSessionConsentPolicy
    replay = client.post(url, headers=original_headers)
    new_request = client.post(
        url,
        headers=headers(tenant_id, "delivery-durable-replay-new-key-0001"),
    )

    assert replay.status_code == 200
    assert replay.json() == accepted.json()
    assert new_request.status_code == 409
    assert new_request.json() == {"detail": "consent_invalid"}
    assert len(handoff.requests) == 1


def test_retryable_delivery_records_failure_and_reuses_outbound_key(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    handoff = RecordingHandoff(failures=1)
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    app.dependency_overrides[get_delivery_claim_policy] = lambda: DeliveryClaimPolicy(
        retry_delay=timedelta(microseconds=1)
    )
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


def test_platform_success_receipt_survives_session_sync_failure_and_replay_repairs_it(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session_data = create_ready_transcript(client, tenant_id)
    session_id = UUID(str(session_data["id"]))
    handoff = ConcurrentSessionFailureHandoff(
        repositories=repository_backend.provider,
        tenant_id=tenant_id,
        session_id=session_id,
    )
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    url = f"/v1/sessions/{session_id}/deliver"
    request_headers = headers(tenant_id, "delivery-session-sync-failure-0001")

    accepted = client.post(url, headers=request_headers)

    assert accepted.status_code == 200
    assert accepted.json()["status"] == "delivered"
    persisted = repository_backend.delivery_for(tenant_id, session_id)
    failed_session = repository_backend.session_for(tenant_id, session_id)
    assert persisted is not None
    assert persisted.status == DeliveryStatus.DELIVERED
    assert failed_session is not None
    assert failed_session.status == SessionStatus.FAILED
    assert repository_backend.audit_actions(tenant_id).count("transcript.delivered") == 1

    async def restore_deliverable_state() -> None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            session = await store.lock_session(tenant_id, session_id)
            assert session is not None
            uploaded = session.model_copy(update={"status": SessionStatus.UPLOADED})
            await store.update_session(tenant_id, uploaded)
            await store.update_session(
                tenant_id,
                uploaded.model_copy(update={"status": SessionStatus.TRANSCRIPT_READY}),
            )

    repository_backend.run(restore_deliverable_state)
    replay = client.post(url, headers=request_headers)

    repaired_session = repository_backend.session_for(tenant_id, session_id)
    assert replay.status_code == 200
    assert replay.json() == accepted.json()
    assert repaired_session is not None
    assert repaired_session.status == SessionStatus.HANDED_OFF
    assert len(handoff.requests) == 1


def test_delivery_reconciler_retries_stale_receipt_with_the_stable_outbound_key(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    handoff = RecordingHandoff(failures=1)
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    tenant_id = uuid4()
    _, session_data = create_ready_transcript(client, tenant_id)
    session_id = UUID(str(session_data["id"]))
    first = client.post(
        f"/v1/sessions/{session_id}/deliver",
        headers=headers(tenant_id, "delivery-reconciler-0001"),
    )
    assert first.status_code == 503

    reconciler = DeliveryReconciler(
        repositories=repository_backend.provider,
        handoff=handoff,
        claim_policy=DeliveryClaimPolicy(retry_delay=timedelta(microseconds=1)),
        maximum_deliveries=1,
    )
    result = repository_backend.run(
        reconciler.reconcile,
        tenant_id=tenant_id,
    )

    persisted = repository_backend.delivery_for(tenant_id, session_id)
    assert result.claimed == 1
    assert result.delivered == 1
    assert persisted is not None
    assert persisted.status == DeliveryStatus.DELIVERED
    assert persisted.attempt_count == 2
    assert len(handoff.requests) == 2
    assert len(set(handoff.idempotency_keys)) == 1


def test_delivery_reconciler_never_reclaims_one_receipt_twice_in_a_run(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    handoff = RecordingHandoff(failures=10)
    app.dependency_overrides[get_master_platform_handoff] = lambda: handoff
    tenant_id = uuid4()
    _, session_data = create_ready_transcript(client, tenant_id, key_suffix="one-run")
    session_id = UUID(str(session_data["id"]))
    first = client.post(
        f"/v1/sessions/{session_id}/deliver",
        headers=headers(tenant_id, "delivery-reconciler-one-run-0001"),
    )
    assert first.status_code == 503

    reconciler = DeliveryReconciler(
        repositories=repository_backend.provider,
        handoff=handoff,
        claim_policy=DeliveryClaimPolicy(retry_delay=timedelta(microseconds=1)),
        maximum_deliveries=3,
    )
    result = repository_backend.run(reconciler.reconcile, tenant_id=tenant_id)

    persisted = repository_backend.delivery_for(tenant_id, session_id)
    assert result.claimed == 1
    assert result.retryable == 1
    assert len(handoff.requests) == 2
    assert persisted is not None
    assert persisted.status == DeliveryStatus.RETRYABLE
    assert persisted.attempt_count == 2


def test_delivery_reconciler_rejects_payload_hash_drift_without_network_call(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session_data = create_ready_transcript(client, tenant_id)
    session_id = UUID(str(session_data["id"]))
    now = datetime.now(UTC)
    delivery = TranscriptDelivery(
        id=uuid4(),
        session_id=session_id,
        idempotency_key=f"scribe-{session_id}-v1",
        payload_sha256="f" * 64,
        status=DeliveryStatus.RETRYABLE,
        attempt_count=1,
        last_error_code="transport_unavailable",
        created_at=now - timedelta(hours=1),
        updated_at=now - timedelta(hours=1),
    )

    async def seed_delivery() -> None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.add_delivery(tenant_id, delivery)

    repository_backend.run(seed_delivery)
    handoff = RecordingHandoff()
    reconciler = DeliveryReconciler(
        repositories=repository_backend.provider,
        handoff=handoff,
        claim_policy=DeliveryClaimPolicy(retry_delay=timedelta(microseconds=1)),
        maximum_deliveries=1,
    )
    result = repository_backend.run(
        reconciler.reconcile,
        tenant_id=tenant_id,
    )

    persisted = repository_backend.delivery_for(tenant_id, session_id)
    assert result.terminal == 1
    assert persisted is not None
    assert persisted.status == DeliveryStatus.TERMINAL
    assert persisted.last_error_code == "payload_mismatch"
    assert handoff.requests == []


def test_delivery_claims_are_tenant_scoped_oldest_first_and_one_at_a_time(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    sessions = [
        UUID(str(create_ready_transcript(client, tenant_id, key_suffix=str(index))[1]["id"]))
        for index in range(4)
    ]
    other_session = UUID(
        str(create_ready_transcript(client, other_tenant_id, key_suffix="other")[1]["id"])
    )
    now = datetime.now(UTC)
    updated_times = [
        now - timedelta(minutes=40),
        now - timedelta(minutes=30),
        now - timedelta(minutes=20),
        now - timedelta(minutes=1),
    ]
    deliveries = [
        TranscriptDelivery(
            id=uuid4(),
            session_id=session_id,
            idempotency_key=f"scribe-{session_id}-v1",
            payload_sha256="a" * 64,
            status=DeliveryStatus.RETRYABLE,
            attempt_count=1,
            last_error_code="transport_unavailable",
            created_at=updated_at,
            updated_at=updated_at,
        )
        for session_id, updated_at in zip(sessions, updated_times, strict=True)
    ]
    other_delivery = TranscriptDelivery(
        id=uuid4(),
        session_id=other_session,
        idempotency_key=f"scribe-{other_session}-v1",
        payload_sha256="b" * 64,
        status=DeliveryStatus.RETRYABLE,
        attempt_count=1,
        last_error_code="transport_unavailable",
        created_at=now - timedelta(hours=1),
        updated_at=now - timedelta(hours=1),
    )

    async def seed_and_claim() -> tuple[TranscriptDelivery | None, TranscriptDelivery | None]:
        async with repository_backend.provider.transaction(tenant_id) as store:
            for delivery in deliveries:
                await store.add_delivery(tenant_id, delivery)
        async with repository_backend.provider.transaction(other_tenant_id) as store:
            await store.add_delivery(other_tenant_id, other_delivery)
        async with repository_backend.provider.transaction(tenant_id) as store:
            first = await store.claim_delivery_attempt(
                tenant_id,
                policy=DeliveryClaimPolicy(retry_delay=timedelta(minutes=5)),
            )
        async with repository_backend.provider.transaction(tenant_id) as store:
            second = await store.claim_delivery_attempt(
                tenant_id,
                policy=DeliveryClaimPolicy(retry_delay=timedelta(minutes=5)),
            )
        return first, second

    first, second = repository_backend.run(seed_and_claim)

    assert first is not None and first.id == deliveries[0].id
    assert second is not None and second.id == deliveries[1].id
    assert first.attempt_count == second.attempt_count == 2
    third = repository_backend.delivery_for(tenant_id, sessions[2])
    fresh = repository_backend.delivery_for(tenant_id, sessions[3])
    other = repository_backend.delivery_for(other_tenant_id, other_session)
    assert third is not None and third.status == DeliveryStatus.RETRYABLE
    assert fresh is not None and fresh.status == DeliveryStatus.RETRYABLE
    assert other == other_delivery


def test_delivery_completion_fencing_prevents_late_failure_regression(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session_data = create_ready_transcript(client, tenant_id)
    session_id = UUID(str(session_data["id"]))
    now = datetime.now(UTC)
    delivery = TranscriptDelivery(
        id=uuid4(),
        session_id=session_id,
        idempotency_key=f"scribe-{session_id}-v1",
        payload_sha256="c" * 64,
        status=DeliveryStatus.PENDING,
        attempt_count=1,
        created_at=now - timedelta(minutes=2),
        updated_at=now - timedelta(minutes=2),
    )

    async def race() -> tuple[TranscriptDelivery | None, TranscriptDelivery | None]:
        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.add_delivery(tenant_id, delivery)
            newer = await store.claim_delivery_attempt(
                tenant_id,
                delivery_id=delivery.id,
                policy=DeliveryClaimPolicy(pending_timeout=timedelta(minutes=1)),
            )
            assert newer is not None and newer.attempt_count == 2
            failed = await store.complete_delivery_failure(
                tenant_id,
                delivery.id,
                expected_attempt_count=2,
                failure_status=DeliveryStatus.RETRYABLE,
                error_code="platform_http_503",
            )
            assert failed is not None
            succeeded = await store.complete_delivery_success(
                tenant_id,
                delivery.id,
                expected_payload_sha256=delivery.payload_sha256,
                platform_transcript_id="ai_visit_transcript_fenced",
            )
            late_failure = await store.complete_delivery_failure(
                tenant_id,
                delivery.id,
                expected_attempt_count=1,
                failure_status=DeliveryStatus.RETRYABLE,
                error_code="late_failure",
            )
            return succeeded.delivery if succeeded is not None else None, late_failure

    succeeded, late_failure = repository_backend.run(race)
    persisted = repository_backend.delivery_for(tenant_id, session_id)

    assert succeeded is not None
    assert succeeded.status == DeliveryStatus.DELIVERED
    assert succeeded.attempt_count == 2
    assert late_failure is None
    assert persisted is not None
    assert persisted.model_dump(exclude={"created_at"}) == succeeded.model_dump()


def test_fresh_pending_delivery_cannot_be_reclaimed(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session_data = create_ready_transcript(client, tenant_id)
    session_id = UUID(str(session_data["id"]))
    now = datetime.now(UTC)
    delivery = TranscriptDelivery(
        id=uuid4(),
        session_id=session_id,
        idempotency_key=f"scribe-{session_id}-v1",
        payload_sha256="d" * 64,
        status=DeliveryStatus.PENDING,
        attempt_count=1,
        created_at=now,
        updated_at=now,
    )

    async def claim() -> TranscriptDelivery | None:
        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.add_delivery(tenant_id, delivery)
            return await store.claim_delivery_attempt(
                tenant_id,
                delivery_id=delivery.id,
                policy=DeliveryClaimPolicy(pending_timeout=timedelta(minutes=5)),
            )

    assert repository_backend.run(claim) is None
    assert repository_backend.delivery_for(tenant_id, session_id) == delivery


def test_repeated_success_is_monotonic_and_conflicting_remote_id_is_rejected(
    client: TestClient,
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    _, session_data = create_ready_transcript(client, tenant_id)
    session_id = UUID(str(session_data["id"]))
    now = datetime.now(UTC)
    delivery = TranscriptDelivery(
        id=uuid4(),
        session_id=session_id,
        idempotency_key=f"scribe-{session_id}-v1",
        payload_sha256="e" * 64,
        status=DeliveryStatus.PENDING,
        attempt_count=1,
        created_at=now,
        updated_at=now,
    )

    async def complete() -> tuple[TranscriptDelivery, bool]:
        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.add_delivery(tenant_id, delivery)
            first = await store.complete_delivery_success(
                tenant_id,
                delivery.id,
                expected_payload_sha256=delivery.payload_sha256,
                platform_transcript_id="ai_visit_transcript_stable",
            )
            assert first is not None and first.changed
            replay = await store.complete_delivery_success(
                tenant_id,
                delivery.id,
                expected_payload_sha256=delivery.payload_sha256,
                platform_transcript_id="ai_visit_transcript_stable",
            )
            assert replay is not None
            with pytest.raises(DeliverySuccessConflictError, match="delivery_success_conflict"):
                await store.complete_delivery_success(
                    tenant_id,
                    delivery.id,
                    expected_payload_sha256=delivery.payload_sha256,
                    platform_transcript_id="ai_visit_transcript_conflict",
                )
            return replay.delivery, replay.changed

    replayed, changed = repository_backend.run(complete)
    persisted = repository_backend.delivery_for(tenant_id, session_id)
    assert changed is False
    assert replayed.platform_transcript_id == "ai_visit_transcript_stable"
    assert persisted is not None
    assert persisted.model_dump(exclude={"created_at"}) == replayed.model_dump()
