from __future__ import annotations

from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from time import perf_counter
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .audio_keys import (
    AudioEncryptionKeyProvider,
    AudioEncryptionKeyUnavailable,
    build_audio_encryption_key_provider,
)
from .canonical_json import canonical_sha256
from .consent import ConsentError, ConsentPolicy
from .delivery_reconciler import (
    complete_delivery_failure,
    complete_delivery_success,
    synchronize_delivery_session,
)
from .handoff import (
    HandoffConflictError,
    HandoffDisabledError,
    HandoffRejectedError,
    HandoffRetryableError,
    MasterPlatformHandoff,
    build_master_platform_handoff,
    to_legacy_payload,
    to_master_platform_payload,
)
from .repository import (
    DeliveryClaimPolicy,
    DeliverySuccessConflictError,
    IdempotencyClaimUnavailableError,
    IdempotencyConflictError,
    InMemoryRepository,
    RepositoryProvider,
    UploadGrantRecord,
)
from .repository import (
    Repository as RepositoryContract,
)
from .safe_logging import log_event
from .schemas import (
    AudioChunk,
    AudioChunkRegister,
    AudioEncryptionPublicKey,
    AudioUploadGrant,
    AudioUploadGrantRequest,
    CaptureSession,
    ConsentCreate,
    ConsentRecord,
    DeliveryAttempt,
    DeliveryStatus,
    LegacyTranscriptPayload,
    MasterTranscriptDeliveryRequest,
    SessionAudioKey,
    SessionAudioKeyCreate,
    SessionAudioKeyReceipt,
    SessionCreate,
    SessionStatus,
    TokenDiagnostics,
    Transcript,
    TranscriptCreate,
    TranscriptDelivery,
)
from .service_auth import (
    EntraServicePrincipal,
    authenticate_workflow_request,
    get_verified_tenant_id,
)
from .session_state_v1 import can_transition_session
from .settings import get_settings
from .storage import AudioStorage, build_audio_storage


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
    yield
    if get_repository_provider.cache_info().currsize:
        await get_repository_provider().close()
        get_repository_provider.cache_clear()
    if get_audio_storage.cache_info().currsize:
        await get_audio_storage().close()
        get_audio_storage.cache_clear()
    if get_master_platform_handoff.cache_info().currsize:
        await get_master_platform_handoff().close()
        get_master_platform_handoff.cache_clear()
    if get_audio_encryption_key_provider.cache_info().currsize:
        await get_audio_encryption_key_provider().close()
        get_audio_encryption_key_provider.cache_clear()


app = FastAPI(
    title="Cosmaneura Scribe API",
    version="0.1.0",
    description="Consent-gated clinical audio custody and transcript handoff.",
    lifespan=lifespan,
)
consent_policy = ConsentPolicy()


@app.middleware("http")
async def opaque_unhandled_error(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    started_at = perf_counter()
    try:
        return await call_next(request)
    except Exception as exc:
        log_event(
            action="http.unhandled_exception",
            error_class=type(exc).__name__,
            duration_ms=(perf_counter() - started_at) * 1000,
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Internal server error."},
        )


@app.exception_handler(RequestValidationError)
async def safe_request_validation_error(
    request: Request,
    exc: RequestValidationError,
) -> Response:
    if request.url.path.startswith("/v1/"):
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={"detail": "Request validation failed."},
        )
    return await request_validation_exception_handler(request, exc)


@lru_cache
def get_repository_provider() -> RepositoryProvider:
    settings = get_settings()
    if settings.repository_backend == "postgres":
        from .postgres_repository import build_postgres_provider

        return build_postgres_provider(settings)
    return InMemoryRepository()


def get_consent_policy() -> ConsentPolicy:
    return consent_policy


@lru_cache
def get_audio_storage() -> AudioStorage:
    return build_audio_storage(get_settings())


@lru_cache
def get_master_platform_handoff() -> MasterPlatformHandoff:
    return build_master_platform_handoff(get_settings())


@lru_cache
def get_audio_encryption_key_provider() -> AudioEncryptionKeyProvider:
    return build_audio_encryption_key_provider(get_settings())


def get_delivery_claim_policy() -> DeliveryClaimPolicy:
    settings = get_settings()
    return DeliveryClaimPolicy(
        pending_timeout=timedelta(seconds=settings.delivery_pending_timeout_seconds),
        retry_delay=timedelta(seconds=settings.delivery_retry_delay_seconds),
    )


TenantId = Annotated[UUID, Depends(get_verified_tenant_id)]
IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=255)]
Provider = Annotated[RepositoryProvider, Depends(get_repository_provider)]
WorkflowPrincipal = Annotated[
    EntraServicePrincipal,
    Depends(authenticate_workflow_request),
]


async def get_repository(
    tenant_id: TenantId,
    provider: Provider,
) -> AsyncIterator[RepositoryContract]:
    async with provider.transaction(tenant_id) as transaction:
        yield transaction


Repository = Annotated[RepositoryContract, Depends(get_repository)]
Policy = Annotated[ConsentPolicy, Depends(get_consent_policy)]
Storage = Annotated[AudioStorage, Depends(get_audio_storage)]
Handoff = Annotated[MasterPlatformHandoff, Depends(get_master_platform_handoff)]
EncryptionKeys = Annotated[
    AudioEncryptionKeyProvider,
    Depends(get_audio_encryption_key_provider),
]
DeliveryPolicy = Annotated[DeliveryClaimPolicy, Depends(get_delivery_claim_policy)]


def _fingerprint(payload: object) -> str:
    return canonical_sha256(payload)


async def _idempotent_entity(
    store: RepositoryContract,
    tenant_id: UUID,
    operation: str,
    key: str,
    fingerprint: str,
    entity_id: UUID,
) -> UUID | None:
    try:
        return await store.claim_idempotency(
            tenant_id=tenant_id,
            operation=operation,
            key=key,
            request_fingerprint=fingerprint,
            entity_id=entity_id,
        )
    except IdempotencyConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Idempotency-Key was already used with a different request.",
        ) from exc
    except IdempotencyClaimUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Idempotency-Key is currently being processed.",
            headers={"Retry-After": "0"},
        ) from exc


async def _session_or_404(
    store: RepositoryContract, tenant_id: UUID, session_id: UUID
) -> CaptureSession:
    session = await store.get_session(tenant_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Capture session not found.")
    return session


async def _locked_session_or_404(
    store: RepositoryContract,
    tenant_id: UUID,
    session_id: UUID,
) -> CaptureSession:
    session = await store.lock_session(tenant_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Capture session not found.")
    return session


async def _assert_session_consent(
    store: RepositoryContract,
    tenant_id: UUID,
    session: CaptureSession,
    policy: ConsentPolicy,
) -> None:
    consent = await store.get_consent(tenant_id, session.consent_record_id)
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


@app.get("/readyz", tags=["operations"])
async def readiness(provider: Provider) -> dict[str, str]:
    try:
        await provider.health()
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Persistence is not ready.") from exc
    return {"status": "ready"}


@app.get(
    "/v1/diagnostics/token",
    response_model=TokenDiagnostics,
    tags=["operations"],
)
async def token_diagnostics(principal: WorkflowPrincipal) -> TokenDiagnostics:
    return principal.diagnostics


@app.get("/v1/audio-encryption-key", response_model=AudioEncryptionPublicKey)
async def get_audio_encryption_public_key(
    tenant_id: TenantId,
    provider: EncryptionKeys,
) -> AudioEncryptionPublicKey:
    del tenant_id
    try:
        return await provider.get_public_key()
    except AudioEncryptionKeyUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Audio encryption key is unavailable.",
        ) from None


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
    record = ConsentRecord(id=uuid4(), policy_version=policy.version, **payload.model_dump())
    previous_id = await _idempotent_entity(
        store, tenant_id, "consent.create", idempotency_key, fingerprint, record.id
    )
    if previous_id is not None:
        previous = await store.get_consent(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent consent is unavailable.")
        return previous

    await store.add_consent(tenant_id, record)
    await store.audit(
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
    consent = await store.get_consent(tenant_id, payload.consent_record_id)
    if consent is None:
        raise HTTPException(status_code=409, detail="A valid consent record is required.")
    try:
        policy.validate_session(consent, payload)
    except ConsentError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    fingerprint = _fingerprint(payload)
    session = CaptureSession(
        id=uuid4(),
        status=SessionStatus.CREATED,
        created_at=datetime.now(UTC),
        **payload.model_dump(),
    )
    previous_id = await _idempotent_entity(
        store, tenant_id, "session.create", idempotency_key, fingerprint, session.id
    )
    if previous_id is not None:
        previous = await store.get_session(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent session is unavailable.")
        return previous

    await store.add_session(tenant_id, session)
    await store.audit(
        tenant_id=tenant_id,
        action="scribe_session.created",
        entity_type="scribe_session",
        entity_id=session.id,
    )
    return session


def _audio_key_receipt(audio_key: SessionAudioKey) -> SessionAudioKeyReceipt:
    return SessionAudioKeyReceipt(
        session_id=audio_key.session_id,
        key_version=audio_key.key_version,
        created_at=audio_key.created_at,
    )


@app.post(
    "/v1/sessions/{session_id}/audio-key",
    response_model=SessionAudioKeyReceipt,
    status_code=201,
)
async def bind_session_audio_key(
    session_id: UUID,
    payload: SessionAudioKeyCreate,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
    key_provider: EncryptionKeys,
) -> SessionAudioKeyReceipt:
    fingerprint = _fingerprint(payload)
    previous_id = await _idempotent_entity(
        store,
        tenant_id,
        f"session.audio-key:{session_id}",
        idempotency_key,
        fingerprint,
        session_id,
    )
    if previous_id is not None:
        previous = await store.get_session_audio_key(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent audio key is unavailable.")
        replay_session = await _locked_session_or_404(store, tenant_id, previous.session_id)
        await _assert_session_consent(store, tenant_id, replay_session, policy)
        return _audio_key_receipt(previous)

    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    existing = await store.get_session_audio_key(tenant_id, session_id)
    if existing is not None:
        if (
            existing.key_version != payload.key_version
            or existing.wrapped_dek != payload.wrapped_dek
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The session audio key is immutable.",
            )
        return _audio_key_receipt(existing)
    if session.status != SessionStatus.CREATED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The session is not accepting an audio key.",
        )
    try:
        current_key = await key_provider.get_public_key()
    except AudioEncryptionKeyUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Audio encryption key is unavailable.",
        ) from None
    if (
        payload.key_version != current_key.key_version
        or key_provider.versioned_key_id(payload.key_version) is None
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The audio encryption key version is no longer current.",
        )
    audio_key = SessionAudioKey(
        session_id=session_id,
        created_at=datetime.now(UTC),
        **payload.model_dump(),
    )
    if not await store.add_session_audio_key(tenant_id, audio_key):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The session audio key is immutable.",
        )
    await store.audit(
        tenant_id=tenant_id,
        action="session_audio_key.bound",
        entity_type="session_audio_key",
        entity_id=session_id,
    )
    return _audio_key_receipt(audio_key)


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
    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    if await store.get_session_audio_key(tenant_id, session_id) is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Register the session audio key before requesting upload grants.",
        )

    fingerprint = _fingerprint(payload)
    operation = f"chunk.upload-grant:{session_id}"
    object_id = uuid4()
    previous_id = await _idempotent_entity(
        store, tenant_id, operation, idempotency_key, fingerprint, object_id
    )
    if previous_id is not None:
        previous = await store.get_upload_grant(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent upload grant is unavailable.")
        if previous.expires_at <= datetime.now(UTC):
            raise HTTPException(
                status_code=409,
                detail="The idempotent upload grant has expired; use a new Idempotency-Key.",
            )
        return await audio_storage.issue_upload_grant(
            tenant_id=tenant_id,
            session_id=previous.session_id,
            object_id=previous.object_id,
            request=AudioUploadGrantRequest(
                sequence_number=previous.sequence_number,
                channel=previous.channel,
            ),
            expires_at=previous.expires_at,
        )

    if session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
        raise HTTPException(status_code=409, detail="Session is not accepting audio chunks.")

    grant = await audio_storage.issue_upload_grant(
        tenant_id=tenant_id,
        session_id=session_id,
        object_id=object_id,
        request=payload,
    )
    await store.add_upload_grant(
        tenant_id,
        UploadGrantRecord(
            object_id=grant.object_id,
            session_id=grant.session_id,
            sequence_number=grant.sequence_number,
            channel=grant.channel,
            expires_at=grant.expires_at,
        ),
    )
    await store.audit(
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
    fingerprint = _fingerprint(payload)
    operation = f"chunk.register:{session_id}"
    chunk = AudioChunk(
        id=uuid4(), session_id=session_id, registered_at=datetime.now(UTC), **payload.model_dump()
    )
    previous_id = await _idempotent_entity(
        store, tenant_id, operation, idempotency_key, fingerprint, chunk.id
    )
    if previous_id is not None:
        previous = await store.get_chunk(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent audio chunk is unavailable.")
        replay_session = await _locked_session_or_404(store, tenant_id, previous.session_id)
        await _assert_session_consent(store, tenant_id, replay_session, policy)
        return previous

    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    if await store.get_session_audio_key(tenant_id, session_id) is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Register the session audio key before registering audio chunks.",
        )
    grant = await store.get_upload_grant(tenant_id, payload.object_id)
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

    if not can_transition_session(session.status, SessionStatus.CAPTURING):
        raise HTTPException(status_code=409, detail="Session is not accepting audio chunks.")

    await store.add_chunk(tenant_id, chunk)
    await store.update_session(
        tenant_id, session.model_copy(update={"status": SessionStatus.CAPTURING})
    )
    await store.audit(
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
    fingerprint = _fingerprint({"session_id": str(session_id)})
    previous_id = await _idempotent_entity(
        store,
        tenant_id,
        "session.complete",
        idempotency_key,
        fingerprint,
        session_id,
    )
    if previous_id is not None:
        previous = await store.get_session(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent session is unavailable.")
        await _assert_session_consent(store, tenant_id, previous, policy)
        return previous

    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    if await store.get_session_audio_key(tenant_id, session_id) is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Register the session audio key before completing capture.",
        )
    if not await store.chunks_for(tenant_id, session_id):
        raise HTTPException(status_code=409, detail="At least one audio chunk is required.")

    if session.status == SessionStatus.UPLOADED or not can_transition_session(
        session.status, SessionStatus.UPLOADED
    ):
        raise HTTPException(
            status_code=409,
            detail="Session cannot be completed from its current status.",
        )

    completed = session.model_copy(update={"status": SessionStatus.UPLOADED})
    await store.update_session(tenant_id, completed)
    await store.audit(
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
    fingerprint = _fingerprint(payload)
    operation = f"transcript.create:{session_id}"
    transcript = Transcript(
        id=uuid4(), session_id=session_id, created_at=datetime.now(UTC), **payload.model_dump()
    )
    previous_id = await _idempotent_entity(
        store, tenant_id, operation, idempotency_key, fingerprint, transcript.id
    )
    if previous_id is not None:
        previous = await store.get_transcript(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent transcript is unavailable.")
        replay_session = await _locked_session_or_404(store, tenant_id, previous.session_id)
        await _assert_session_consent(store, tenant_id, replay_session, policy)
        return previous

    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    if session.status == SessionStatus.TRANSCRIPT_READY or not can_transition_session(
        session.status, SessionStatus.TRANSCRIPT_READY
    ):
        raise HTTPException(status_code=409, detail="Session audio is not ready for transcription.")

    await store.add_transcript(tenant_id, transcript)
    await store.update_session(
        tenant_id, session.model_copy(update={"status": SessionStatus.TRANSCRIPT_READY})
    )
    await store.audit(
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
    await _session_or_404(store, tenant_id, session_id)
    transcript = await store.transcript_for(tenant_id, session_id)
    if transcript is None:
        raise HTTPException(status_code=404, detail="Transcript is not ready.")
    await store.audit(
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
    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    transcript = await store.transcript_for(tenant_id, session_id)
    if transcript is None:
        raise HTTPException(status_code=409, detail="Transcript is not ready for handoff.")

    fingerprint = _fingerprint({"session_id": str(session_id), "transcript_id": str(transcript.id)})
    previous_id = await _idempotent_entity(
        store,
        tenant_id,
        "session.handoff",
        idempotency_key,
        fingerprint,
        session_id,
    )
    if previous_id is None:
        if not can_transition_session(session.status, SessionStatus.HANDED_OFF):
            raise HTTPException(
                status_code=409,
                detail="Session is not ready for handoff.",
            )
        await store.update_session(
            tenant_id, session.model_copy(update={"status": SessionStatus.HANDED_OFF})
        )
        await store.audit(
            tenant_id=tenant_id,
            action="transcript.handoff_prepared",
            entity_type="scribe_session",
            entity_id=session_id,
        )
    return to_legacy_payload(session, transcript)


@app.post("/v1/sessions/{session_id}/deliver", response_model=TranscriptDelivery)
async def deliver_transcript_to_master_platform(
    session_id: UUID,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    response: Response,
    provider: Provider,
    policy: Policy,
    handoff: Handoff,
    claim_policy: DeliveryPolicy,
) -> TranscriptDelivery:
    # Commit the attempt before making the network call. A crash after this
    # point leaves a pending receipt that is safe to retry with the same key.
    attempted: DeliveryAttempt | None = None
    delivered_replay: TranscriptDelivery | None = None
    payload: MasterTranscriptDeliveryRequest | None = None
    async with provider.transaction(tenant_id) as store:
        previous_idempotency = await store.get_idempotency(
            tenant_id=tenant_id,
            operation="transcript.deliver",
            key=idempotency_key,
        )
        if previous_idempotency is not None:
            previous_delivery = await store.get_delivery(
                tenant_id,
                previous_idempotency.entity_id,
            )
            if previous_delivery is None:
                raise HTTPException(status_code=500, detail="Delivery receipt is unavailable.")
            if previous_delivery.status == DeliveryStatus.DELIVERED:
                if (
                    previous_delivery.session_id != session_id
                    or previous_idempotency.request_fingerprint
                    != previous_delivery.payload_sha256
                ):
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Idempotency-Key was already used with a different request.",
                    )
                delivered_replay = previous_delivery

        if delivered_replay is None:
            session = await store.lock_session(tenant_id, session_id)
            if session is None:
                raise HTTPException(status_code=404, detail="Capture session not found.")
            await _assert_session_consent(store, tenant_id, session, policy)
            transcript = await store.transcript_for(tenant_id, session_id)
            if transcript is None or session.status not in {
                SessionStatus.TRANSCRIPT_READY,
                SessionStatus.HANDED_OFF,
            }:
                raise HTTPException(status_code=409, detail="Transcript is not ready for delivery.")

            payload = to_master_platform_payload(session, transcript)
            payload_fingerprint = _fingerprint(payload)
            delivery = await store.delivery_for(tenant_id, session_id)
            is_new_delivery = delivery is None
            now = datetime.now(UTC)
            if delivery is None:
                delivery = TranscriptDelivery(
                    id=uuid4(),
                    session_id=session_id,
                    idempotency_key=f"scribe-{session_id}-v1",
                    payload_sha256=payload_fingerprint,
                    status=DeliveryStatus.PENDING,
                    attempt_count=0,
                    created_at=now,
                    updated_at=now,
                )

            previous_id = await _idempotent_entity(
                store,
                tenant_id,
                "transcript.deliver",
                idempotency_key,
                payload_fingerprint,
                delivery.id,
            )
            if previous_id is not None:
                previous = await store.get_delivery(tenant_id, previous_id)
                if previous is None:
                    raise HTTPException(
                        status_code=500,
                        detail="Delivery receipt is unavailable.",
                    )
                delivery = previous
                is_new_delivery = False

            if delivery.payload_sha256 != payload_fingerprint:
                raise HTTPException(
                    status_code=409,
                    detail="The session delivery is bound to a different transcript.",
                )
            if delivery.status == DeliveryStatus.DELIVERED:
                delivered_replay = delivery
            elif delivery.status == DeliveryStatus.TERMINAL:
                response.status_code = status.HTTP_409_CONFLICT
                return delivery
            else:
                if is_new_delivery:
                    await store.add_delivery(tenant_id, delivery)
                attempted = await store.claim_delivery_attempt(
                    tenant_id,
                    policy=claim_policy,
                    delivery_id=delivery.id,
                )
                if attempted is None:
                    current = await store.get_delivery(tenant_id, delivery.id)
                    if current is None:
                        raise HTTPException(
                            status_code=500,
                            detail="Delivery receipt is unavailable.",
                        )
                    if current.status == DeliveryStatus.DELIVERED:
                        delivered_replay = current
                    elif current.status == DeliveryStatus.TERMINAL:
                        response.status_code = status.HTTP_409_CONFLICT
                        return current
                    else:
                        raise HTTPException(
                            status_code=status.HTTP_409_CONFLICT,
                            detail="Delivery attempt is already being processed.",
                            headers={"Retry-After": "1"},
                        )
    if delivered_replay is not None:
        await synchronize_delivery_session(
            provider,
            tenant_id=tenant_id,
            delivery=delivered_replay,
        )
        return delivered_replay

    if attempted is None:
        raise RuntimeError("delivery attempt is unavailable")
    if payload is None:
        raise RuntimeError("delivery payload is unavailable")

    try:
        platform_result = await handoff.deliver(payload, idempotency_key=attempted.idempotency_key)
    except (HandoffDisabledError, HandoffRetryableError) as exc:
        failed = await complete_delivery_failure(
            provider,
            tenant_id=tenant_id,
            attempted=attempted,
            failure_status=DeliveryStatus.RETRYABLE,
            error_code=exc.code,
            audit_action="transcript.delivery_retryable",
        )
        if failed.status == DeliveryStatus.DELIVERED:
            await synchronize_delivery_session(
                provider,
                tenant_id=tenant_id,
                delivery=failed,
            )
        elif failed.status == DeliveryStatus.TERMINAL:
            response.status_code = status.HTTP_409_CONFLICT
        else:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return await _require_delivery_receipt(provider, tenant_id, failed.id)
    except (HandoffConflictError, HandoffRejectedError) as exc:
        failed = await complete_delivery_failure(
            provider,
            tenant_id=tenant_id,
            attempted=attempted,
            failure_status=DeliveryStatus.TERMINAL,
            error_code=exc.code,
            audit_action="transcript.delivery_rejected",
        )
        if failed.status == DeliveryStatus.DELIVERED:
            await synchronize_delivery_session(
                provider,
                tenant_id=tenant_id,
                delivery=failed,
            )
        elif failed.status == DeliveryStatus.RETRYABLE:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        else:
            response.status_code = status.HTTP_409_CONFLICT
        return await _require_delivery_receipt(provider, tenant_id, failed.id)

    try:
        delivered = await complete_delivery_success(
            provider,
            tenant_id=tenant_id,
            attempted=attempted,
            platform_transcript_id=platform_result.transcript_id,
        )
        return await _require_delivery_receipt(provider, tenant_id, delivered.id)
    except DeliverySuccessConflictError:
        async with provider.transaction(tenant_id) as store:
            await store.audit(
                tenant_id=tenant_id,
                action="transcript.delivery_success_conflict",
                entity_type="transcript_delivery",
                entity_id=attempted.id,
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Delivery success conflicts with the durable receipt.",
        ) from None


async def _require_delivery_receipt(
    provider: RepositoryProvider,
    tenant_id: UUID,
    delivery_id: UUID,
) -> TranscriptDelivery:
    async with provider.transaction(tenant_id) as store:
        delivery = await store.get_delivery(tenant_id, delivery_id)
    if delivery is None:
        raise HTTPException(status_code=500, detail="Delivery receipt is unavailable.")
    return delivery
