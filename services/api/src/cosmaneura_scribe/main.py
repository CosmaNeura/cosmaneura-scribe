from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from functools import lru_cache
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, status

from .consent import ConsentError, ConsentPolicy
from .handoff import to_legacy_payload
from .repository import IdempotencyRecord, InMemoryRepository
from .schemas import (
    AudioChunk,
    AudioChunkRegister,
    AudioUploadGrant,
    AudioUploadGrantRequest,
    CaptureSession,
    ConsentCreate,
    ConsentRecord,
    LegacyTranscriptPayload,
    SessionCreate,
    SessionStatus,
    Transcript,
    TranscriptCreate,
)
from .settings import get_settings
from .storage import AudioStorage, build_audio_storage

app = FastAPI(
    title="Cosmaneura Scribe API",
    version="0.1.0",
    description="Consent-gated clinical audio custody and transcript handoff.",
)
repository = InMemoryRepository()
consent_policy = ConsentPolicy()


def get_repository() -> InMemoryRepository:
    return repository


def get_consent_policy() -> ConsentPolicy:
    return consent_policy


@lru_cache
def get_audio_storage() -> AudioStorage:
    return build_audio_storage(get_settings())


TenantId = Annotated[UUID, Header(alias="X-Tenant-ID")]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=255)]
Repository = Annotated[InMemoryRepository, Depends(get_repository)]
Policy = Annotated[ConsentPolicy, Depends(get_consent_policy)]
Storage = Annotated[AudioStorage, Depends(get_audio_storage)]


def _fingerprint(payload: object) -> str:
    if hasattr(payload, "model_dump"):
        body = payload.model_dump(mode="json")  # type: ignore[union-attr]
    else:
        body = payload
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def _idempotent_entity(
    store: InMemoryRepository,
    tenant_id: UUID,
    operation: str,
    key: str,
    fingerprint: str,
) -> UUID | None:
    record = store.idempotency.get((tenant_id, operation, key))
    if record is None:
        return None
    if record.request_fingerprint != fingerprint:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Idempotency-Key was already used with a different request.",
        )
    return record.entity_id


def _session_or_404(store: InMemoryRepository, tenant_id: UUID, session_id: UUID) -> CaptureSession:
    session = store.sessions.get((tenant_id, session_id))
    if session is None:
        raise HTTPException(status_code=404, detail="Capture session not found.")
    return session


def _assert_session_consent(
    store: InMemoryRepository,
    tenant_id: UUID,
    session: CaptureSession,
    policy: ConsentPolicy,
) -> None:
    consent = store.consents.get((tenant_id, session.consent_record_id))
    if consent is None:
        raise HTTPException(status_code=409, detail="A valid consent record is required.")
    try:
        policy.validate_session(
            consent,
            SessionCreate(
                appointment_id=session.appointment_id,
                practitioner_id=session.practitioner_id,
                patient_id=session.patient_id,
                consent_record_id=session.consent_record_id,
                modality=session.modality,
            ),
        )
    except ConsentError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/healthz", tags=["operations"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/consents", response_model=ConsentRecord, status_code=201)
async def create_consent(
    payload: ConsentCreate,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
) -> ConsentRecord:
    try:
        policy.validate_new_record(payload.all_parties_consented)
    except ConsentError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    fingerprint = _fingerprint(payload)
    previous_id = _idempotent_entity(
        store, tenant_id, "consent.create", idempotency_key, fingerprint
    )
    if previous_id is not None:
        return store.consents[(tenant_id, previous_id)]

    record = ConsentRecord(id=uuid4(), policy_version=policy.version, **payload.model_dump())
    store.consents[(tenant_id, record.id)] = record
    store.idempotency[(tenant_id, "consent.create", idempotency_key)] = IdempotencyRecord(
        fingerprint, record.id
    )
    store.audit(
        tenant_id=tenant_id,
        action="consent.recorded",
        entity_type="consent_record",
        entity_id=record.id,
    )
    return record


@app.post("/v1/sessions", response_model=CaptureSession, status_code=201)
async def create_session(
    payload: SessionCreate,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
) -> CaptureSession:
    consent = store.consents.get((tenant_id, payload.consent_record_id))
    if consent is None:
        raise HTTPException(status_code=409, detail="A valid consent record is required.")
    try:
        policy.validate_session(consent, payload)
    except ConsentError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    fingerprint = _fingerprint(payload)
    previous_id = _idempotent_entity(
        store, tenant_id, "session.create", idempotency_key, fingerprint
    )
    if previous_id is not None:
        return store.sessions[(tenant_id, previous_id)]

    session = CaptureSession(
        id=uuid4(),
        status=SessionStatus.CREATED,
        created_at=datetime.now(UTC),
        **payload.model_dump(),
    )
    store.sessions[(tenant_id, session.id)] = session
    store.idempotency[(tenant_id, "session.create", idempotency_key)] = IdempotencyRecord(
        fingerprint, session.id
    )
    store.audit(
        tenant_id=tenant_id,
        action="scribe_session.created",
        entity_type="scribe_session",
        entity_id=session.id,
    )
    return session


@app.post(
    "/v1/sessions/{session_id}/chunks/upload-grant",
    response_model=AudioUploadGrant,
    status_code=201,
)
async def issue_chunk_upload_grant(
    session_id: UUID,
    payload: AudioUploadGrantRequest,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
    audio_storage: Storage,
) -> AudioUploadGrant:
    session = _session_or_404(store, tenant_id, session_id)
    _assert_session_consent(store, tenant_id, session, policy)
    if session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
        raise HTTPException(status_code=409, detail="Session is not accepting audio chunks.")

    fingerprint = _fingerprint(payload)
    operation = f"chunk.upload-grant:{session_id}"
    previous_id = _idempotent_entity(store, tenant_id, operation, idempotency_key, fingerprint)
    if previous_id is not None:
        return store.upload_grants[(tenant_id, previous_id)]

    object_id = uuid4()
    grant = await audio_storage.issue_upload_grant(
        tenant_id=tenant_id,
        session_id=session_id,
        object_id=object_id,
        request=payload,
    )
    store.upload_grants[(tenant_id, object_id)] = grant
    store.idempotency[(tenant_id, operation, idempotency_key)] = IdempotencyRecord(
        fingerprint, object_id
    )
    store.audit(
        tenant_id=tenant_id,
        action="audio_upload_grant.issued",
        entity_type="audio_object",
        entity_id=object_id,
    )
    return grant


@app.post("/v1/sessions/{session_id}/chunks", response_model=AudioChunk, status_code=201)
async def register_chunk(
    session_id: UUID,
    payload: AudioChunkRegister,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
) -> AudioChunk:
    session = _session_or_404(store, tenant_id, session_id)
    _assert_session_consent(store, tenant_id, session, policy)
    if session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
        raise HTTPException(status_code=409, detail="Session is not accepting audio chunks.")

    grant = store.upload_grants.get((tenant_id, payload.object_id))
    if grant is None:
        raise HTTPException(status_code=409, detail="Audio object does not have an upload grant.")
    if (
        grant.session_id != session_id
        or grant.sequence_number != payload.sequence_number
        or grant.channel != payload.channel
    ):
        raise HTTPException(
            status_code=409,
            detail="Audio registration does not match its upload grant.",
        )

    fingerprint = _fingerprint(payload)
    operation = f"chunk.register:{session_id}"
    previous_id = _idempotent_entity(store, tenant_id, operation, idempotency_key, fingerprint)
    if previous_id is not None:
        return store.chunks[(tenant_id, previous_id)]

    chunk = AudioChunk(
        id=uuid4(), session_id=session_id, registered_at=datetime.now(UTC), **payload.model_dump()
    )
    store.chunks[(tenant_id, chunk.id)] = chunk
    store.sessions[(tenant_id, session_id)] = session.model_copy(
        update={"status": SessionStatus.CAPTURING}
    )
    store.idempotency[(tenant_id, operation, idempotency_key)] = IdempotencyRecord(
        fingerprint, chunk.id
    )
    store.audit(
        tenant_id=tenant_id,
        action="audio_chunk.registered",
        entity_type="audio_chunk",
        entity_id=chunk.id,
    )
    return chunk


@app.post("/v1/sessions/{session_id}/complete", response_model=CaptureSession)
async def complete_session(
    session_id: UUID,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
) -> CaptureSession:
    session = _session_or_404(store, tenant_id, session_id)
    _assert_session_consent(store, tenant_id, session, policy)
    if not store.chunks_for(tenant_id, session_id):
        raise HTTPException(status_code=409, detail="At least one audio chunk is required.")

    fingerprint = _fingerprint({"session_id": str(session_id)})
    previous_id = _idempotent_entity(
        store, tenant_id, "session.complete", idempotency_key, fingerprint
    )
    if previous_id is not None:
        return store.sessions[(tenant_id, previous_id)]

    completed = session.model_copy(update={"status": SessionStatus.UPLOADED})
    store.sessions[(tenant_id, session_id)] = completed
    store.idempotency[(tenant_id, "session.complete", idempotency_key)] = IdempotencyRecord(
        fingerprint, session_id
    )
    store.audit(
        tenant_id=tenant_id,
        action="scribe_session.uploaded",
        entity_type="scribe_session",
        entity_id=session_id,
    )
    return completed


@app.post("/v1/sessions/{session_id}/transcript", response_model=Transcript, status_code=201)
async def save_transcript(
    session_id: UUID,
    payload: TranscriptCreate,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
) -> Transcript:
    session = _session_or_404(store, tenant_id, session_id)
    _assert_session_consent(store, tenant_id, session, policy)
    if session.status not in {SessionStatus.UPLOADED, SessionStatus.PROCESSING}:
        raise HTTPException(status_code=409, detail="Session audio is not ready for transcription.")

    fingerprint = _fingerprint(payload)
    operation = f"transcript.create:{session_id}"
    previous_id = _idempotent_entity(store, tenant_id, operation, idempotency_key, fingerprint)
    if previous_id is not None:
        return store.transcripts[(tenant_id, previous_id)]

    transcript = Transcript(
        id=uuid4(), session_id=session_id, created_at=datetime.now(UTC), **payload.model_dump()
    )
    store.transcripts[(tenant_id, transcript.id)] = transcript
    store.transcript_by_session[(tenant_id, session_id)] = transcript.id
    store.sessions[(tenant_id, session_id)] = session.model_copy(
        update={"status": SessionStatus.TRANSCRIPT_READY}
    )
    store.idempotency[(tenant_id, operation, idempotency_key)] = IdempotencyRecord(
        fingerprint, transcript.id
    )
    store.audit(
        tenant_id=tenant_id,
        action="transcript.created",
        entity_type="transcript",
        entity_id=transcript.id,
    )
    return transcript


@app.get("/v1/sessions/{session_id}/transcript", response_model=Transcript)
async def get_transcript(
    session_id: UUID,
    tenant_id: TenantId,
    store: Repository,
) -> Transcript:
    _session_or_404(store, tenant_id, session_id)
    transcript = store.transcript_for(tenant_id, session_id)
    if transcript is None:
        raise HTTPException(status_code=404, detail="Transcript is not ready.")
    store.audit(
        tenant_id=tenant_id,
        action="transcript.read",
        entity_type="transcript",
        entity_id=transcript.id,
    )
    return transcript


@app.post("/v1/sessions/{session_id}/handoff", response_model=LegacyTranscriptPayload)
async def prepare_note_engine_handoff(
    session_id: UUID,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
) -> LegacyTranscriptPayload:
    session = _session_or_404(store, tenant_id, session_id)
    _assert_session_consent(store, tenant_id, session, policy)
    transcript = store.transcript_for(tenant_id, session_id)
    if transcript is None:
        raise HTTPException(status_code=409, detail="Transcript is not ready for handoff.")

    fingerprint = _fingerprint({"session_id": str(session_id), "transcript_id": str(transcript.id)})
    previous_id = _idempotent_entity(
        store, tenant_id, "session.handoff", idempotency_key, fingerprint
    )
    if previous_id is None:
        store.idempotency[(tenant_id, "session.handoff", idempotency_key)] = IdempotencyRecord(
            fingerprint, session_id
        )
        store.sessions[(tenant_id, session_id)] = session.model_copy(
            update={"status": SessionStatus.HANDED_OFF}
        )
        store.audit(
            tenant_id=tenant_id,
            action="transcript.handoff_prepared",
            entity_type="scribe_session",
            entity_id=session_id,
        )
    return to_legacy_payload(session, transcript)
