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
from .capture_protocol_v1 import (
    AUDIO_CHANNELS,
    AUDIO_ENCODING,
    CAPTURE_LEASE_TTL_SECONDS,
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_ENVELOPE_BYTES,
    MAX_RESERVATIONS_PER_BATCH,
    MEDIA_TYPE,
    PROTOCOL_VERSION,
    RESERVATION_PLAINTEXT_BUDGET_BYTES,
    RESERVATION_WINDOW_SECONDS,
    SAMPLE_RATE_HZ,
    TARGET_CHUNK_DURATION_MS,
    UPLOAD_CONCURRENCY,
    base64url_encode,
    capture_channel_additional_data,
)
from .capture_responses import (
    capture_lease_response,
    chunk_receipt_response,
    reservation_batch_response,
)
from .captured_admission_routes import router as captured_admission_router
from .consent import ConsentError, ConsentPolicy
from .consent_routes import build_consent_router
from .creator_continuation_routes import router as creator_continuation_router
from .creator_recording_routes import router as creator_recording_router
from .creator_review_routes import router as creator_review_router
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
from .operations_routes import build_operations_router
from .repository import (
    CaptureChannelFinalizationDraft,
    CaptureContext,
    CaptureFinalizationError,
    CaptureLeaseCloseReason,
    CaptureLeaseConflictError,
    CaptureReservationLimitError,
    ChunkReservationDraft,
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
from .safe_logging import configure_service_logging, log_event
from .schemas import (
    AudioChunk,
    AudioChunkRegister,
    AudioEncryptionPublicKey,
    AudioUploadGrant,
    AudioUploadGrantRequest,
    CaptureCapabilities,
    CaptureCompleteRequest,
    CaptureLeaseIssueRequest,
    CaptureLeaseReceipt,
    CaptureLeaseRenewRequest,
    CaptureLeaseState,
    CaptureMediaCapabilities,
    CaptureSession,
    ChunkReceipt,
    ChunkReservationBatchReceipt,
    ChunkReservationBatchRequest,
    ChunkUploadAuthorization,
    ChunkUploadAuthorizationRequest,
    DeliveryAttempt,
    DeliveryStatus,
    ExternalTranscriptSessionCreate,
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
from .session_state_v1 import SessionIngestMode, can_transition_session
from .settings import Settings, get_settings
from .source_extension_routes import router as source_extension_router
from .source_start_routes import router as source_start_router
from .storage import AudioStorage, build_audio_storage


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncGenerator[None]:
    configure_service_logging()
    configured = get_settings().configured_capture_enabled
    if configured:
        from .configured_capture_service import bind_configured_capture_service
        from .postgres_repository import PostgresRepositoryProvider

        provider = get_repository_provider()
        if not isinstance(provider, PostgresRepositoryProvider):
            raise RuntimeError("Configured capture requires the PostgreSQL service provider.")
        bind_configured_capture_service(application, get_settings(), provider)
    try:
        yield
    finally:
        if configured:
            from .configured_capture_service import unbind_configured_capture_service

            unbind_configured_capture_service(application)
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
_EXTERNAL_TRANSCRIPT_SESSION_CREATE_OPERATION = "session.external_transcript.create"
_EXTERNAL_TRANSCRIPT_SESSION_UNAVAILABLE = "External transcript session creation is unavailable."


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
RuntimeSettings = Annotated[Settings, Depends(get_settings)]
WorkflowPrincipal = Annotated[
    EntraServicePrincipal,
    Depends(authenticate_workflow_request),
]


def get_verified_external_ingest_tenant_id(
    tenant_id: TenantId,
    settings: RuntimeSettings,
) -> UUID:
    if (
        not settings.external_ingest_admission_enabled
        or tenant_id not in settings.external_ingest_beta_tenant_ids
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=_EXTERNAL_TRANSCRIPT_SESSION_UNAVAILABLE,
        )
    return tenant_id


ExternalIngestTenantId = Annotated[
    UUID,
    Depends(get_verified_external_ingest_tenant_id),
]


async def get_external_ingest_repository(
    tenant_id: ExternalIngestTenantId,
    provider: Provider,
) -> AsyncIterator[RepositoryContract]:
    async with provider.transaction(tenant_id) as transaction:
        yield transaction


ExternalIngestRepository = Annotated[
    RepositoryContract,
    Depends(get_external_ingest_repository),
]


async def get_repository(
    tenant_id: TenantId,
    provider: Provider,
) -> AsyncIterator[RepositoryContract]:
    async with provider.transaction(tenant_id) as transaction:
        yield transaction


Repository = Annotated[RepositoryContract, Depends(get_repository)]


async def get_capture_protocol_provider(
    session_id: UUID,
    tenant_id: TenantId,
    provider: Provider,
    settings: RuntimeSettings,
) -> RepositoryProvider:
    from .configured_capture_service import select_capture_protocol_provider

    return await select_capture_protocol_provider(provider, settings, tenant_id, session_id)


CaptureProvider = Annotated[RepositoryProvider, Depends(get_capture_protocol_provider)]


async def get_capture_protocol_repository(
    tenant_id: TenantId,
    provider: CaptureProvider,
) -> AsyncIterator[RepositoryContract]:
    async with provider.transaction(tenant_id) as transaction:
        yield transaction


CaptureRepository = Annotated[RepositoryContract, Depends(get_capture_protocol_repository)]

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


def _require_capture_protocol(settings: Settings) -> None:
    if not settings.capture_protocol_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Capture protocol is disabled.",
        )


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
    consent = await store.lock_consent(tenant_id, session.consent_record_id)
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


def _assert_capture_context(
    context: CaptureContext,
    policy: ConsentPolicy,
    *,
    require_audio_key: bool = True,
) -> None:
    try:
        policy.validate_session(
            context.consent,
            SessionCreate(
                appointment_id=context.session.appointment_id,
                practitioner_id=context.session.practitioner_id,
                patient_id=context.session.patient_id,
                consent_record_id=context.session.consent_record_id,
                modality=context.session.modality,
            ),
        )
    except ConsentError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    _require_chunk_upload_session(context.session)
    if require_audio_key and context.audio_key is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Register the session audio key before capture.",
        )


async def _capture_context_or_404(
    store: RepositoryContract,
    tenant_id: UUID,
    session_id: UUID,
    policy: ConsentPolicy,
    *,
    require_audio_key: bool = True,
    creator_actor_id: str | None = None,
) -> CaptureContext:
    context = await store.lock_capture_context(tenant_id, session_id)
    if context is None:
        raise HTTPException(status_code=404, detail="Capture session not found.")
    _assert_capture_context(context, policy, require_audio_key=require_audio_key)
    if creator_actor_id is not None:
        from .captured_source_runtime import CapturedSourceRepository, CapturedSourceUnavailable
        from .normalized_source_persistence import NormalizedSourcePersistenceError

        # Preserve idempotency -> consent -> session lock order. The original
        # creator/consent check now shares the mutation's transaction and runs
        # before both a new write and an exact receipt replay.
        try:
            if not isinstance(store, CapturedSourceRepository):
                raise CapturedSourceUnavailable()
            selected = await store.lock_live_capture(tenant_id, session_id)
            if selected.creator_actor_id != creator_actor_id:
                raise CapturedSourceUnavailable()
        except (CapturedSourceUnavailable, NormalizedSourcePersistenceError):
            raise HTTPException(
                404, "Configured capture is unavailable.", headers={"Cache-Control": "no-store"}
            ) from None
    return context


# Shared transaction-level gates for creator-authorized composite operations.
# Keep legacy private spellings for existing route helpers and digest fixtures.
capture_request_fingerprint = _fingerprint
require_capture_protocol = _require_capture_protocol
claim_capture_operation = _idempotent_entity
capture_context_for_creator = _capture_context_or_404


def _require_chunk_upload_session(session: CaptureSession) -> None:
    if session.ingest_mode != SessionIngestMode.CHUNK_UPLOAD:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Session does not accept audio chunk capture.",
        )


app.include_router(
    build_operations_router(
        repository_provider_dependency=get_repository_provider,
    )
)
app.include_router(creator_review_router)
app.include_router(creator_recording_router)
app.include_router(captured_admission_router)
app.include_router(source_start_router)
app.include_router(source_extension_router)
app.include_router(creator_continuation_router)


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


app.include_router(
    build_consent_router(
        repository_dependency=get_repository,
        policy_dependency=get_consent_policy,
        idempotent_entity=_idempotent_entity,
    )
)


@app.post("/v1/sessions", response_model=CaptureSession, status_code=201)
async def create_session(
    payload: SessionCreate,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
) -> CaptureSession:
    consent = await store.lock_consent(tenant_id, payload.consent_record_id)
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


@app.post(
    "/v1/external-transcript-sessions",
    response_model=CaptureSession,
    status_code=201,
    tags=["external-ingest"],
)
async def create_external_transcript_session(
    payload: ExternalTranscriptSessionCreate,
    tenant_id: ExternalIngestTenantId,
    idempotency_key: IdempotencyKey,
    store: ExternalIngestRepository,
    policy: Policy,
) -> CaptureSession:
    consent = await store.lock_consent(tenant_id, payload.consent_record_id)
    if consent is None:
        raise HTTPException(status_code=409, detail="A valid consent record is required.")
    try:
        policy.validate_session(consent, payload)
    except ConsentError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    fingerprint = _fingerprint(
        {
            "contract": "external-transcript-session-create-v1",
            "ingest_mode": SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT,
            "payload": payload,
        }
    )
    session = CaptureSession(
        id=uuid4(),
        ingest_mode=SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT,
        status=SessionStatus.CREATED,
        created_at=datetime.now(UTC),
        **payload.model_dump(),
    )
    previous_id = await _idempotent_entity(
        store,
        tenant_id,
        _EXTERNAL_TRANSCRIPT_SESSION_CREATE_OPERATION,
        idempotency_key,
        fingerprint,
        session.id,
    )
    if previous_id is not None:
        previous = await store.get_session(tenant_id, previous_id)
        if previous is None or previous.ingest_mode != SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT:
            raise HTTPException(
                status_code=500,
                detail="Idempotent external transcript session is unavailable.",
            )
        return previous

    await store.add_session(tenant_id, session)
    await store.audit(
        tenant_id=tenant_id,
        action="scribe_session.external_transcript_created",
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
    store: CaptureRepository,
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
        _require_chunk_upload_session(replay_session)
        return _audio_key_receipt(previous)

    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    _require_chunk_upload_session(session)
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


@app.get(
    "/v1/sessions/{session_id}/capture-capabilities",
    response_model=CaptureCapabilities,
)
async def get_capture_capabilities(
    session_id: UUID,
    response: Response,
    tenant_id: TenantId,
    provider: CaptureProvider,
    policy: Policy,
    settings: RuntimeSettings,
) -> CaptureCapabilities:
    _require_capture_protocol(settings)
    async with provider.transaction(tenant_id) as store:
        await _capture_context_or_404(
            store,
            tenant_id,
            session_id,
            policy,
            require_audio_key=False,
        )
        usage = await store.capture_reservation_usage(tenant_id, session_id)
    response.headers["Cache-Control"] = "no-store"
    return CaptureCapabilities(
        protocol_version=PROTOCOL_VERSION,
        media=CaptureMediaCapabilities(
            media_type=MEDIA_TYPE,
            encoding=AUDIO_ENCODING,
            channels=AUDIO_CHANNELS,
            sample_rate_hz=SAMPLE_RATE_HZ,
        ),
        target_chunk_duration_ms=TARGET_CHUNK_DURATION_MS,
        max_envelope_bytes=MAX_ENVELOPE_BYTES,
        max_chunks=MAX_CHUNKS,
        remaining_aggregate_plaintext_bytes=max(
            0,
            min(MAX_AGGREGATE_PLAINTEXT_BYTES, settings.audio_assembly_max_plaintext_bytes)
            - usage.plaintext_budget_bytes,
        ),
        capture_lease_ttl_seconds=CAPTURE_LEASE_TTL_SECONDS,
        reservation_window_seconds=RESERVATION_WINDOW_SECONDS,
        max_reservations_per_batch=MAX_RESERVATIONS_PER_BATCH,
        upload_concurrency=UPLOAD_CONCURRENCY,
    )


@app.post(
    "/v1/sessions/{session_id}/capture-lease",
    response_model=CaptureLeaseReceipt,
    status_code=201,
)
async def issue_capture_lease(
    session_id: UUID,
    payload: CaptureLeaseIssueRequest,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    provider: CaptureProvider,
    policy: Policy,
    settings: RuntimeSettings,
) -> CaptureLeaseReceipt:
    return await execute_capture_lease_issue(
        session_id, payload, tenant_id, idempotency_key, provider, policy, settings
    )


async def execute_capture_lease_issue(
    session_id: UUID,
    payload: CaptureLeaseIssueRequest,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    provider: CaptureProvider,
    policy: Policy,
    settings: Settings,
    *,
    creator_actor_id: str | None = None,
) -> CaptureLeaseReceipt:
    _require_capture_protocol(settings)
    receipt_id = uuid4()
    lease_id = uuid4()
    async with provider.transaction(tenant_id) as store:
        previous_id = await _idempotent_entity(
            store,
            tenant_id,
            f"capture.lease.issue:{session_id}",
            idempotency_key,
            _fingerprint(payload),
            receipt_id,
        )
        context = await _capture_context_or_404(
            store, tenant_id, session_id, policy, creator_actor_id=creator_actor_id
        )
        if previous_id is not None:
            previous = await store.get_capture_lease_receipt(tenant_id, previous_id)
            if previous is None or previous.session_id != session_id:
                raise HTTPException(status_code=500, detail="Capture lease receipt is unavailable.")
            return capture_lease_response(previous)
        if context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
            raise HTTPException(status_code=409, detail="Session is not accepting capture.")
        if context.lease is not None:
            raise HTTPException(status_code=409, detail="A capture lease already exists.")
        receipt = await store.issue_capture_lease(
            tenant_id,
            session_id,
            lease_id=lease_id,
            receipt_id=receipt_id,
            duration=timedelta(seconds=CAPTURE_LEASE_TTL_SECONDS),
        )
        if receipt is None:
            raise HTTPException(status_code=409, detail="A capture lease already exists.")
        await store.audit(
            tenant_id=tenant_id,
            action="capture_lease.issued",
            entity_type="capture_lease",
            entity_id=lease_id,
        )
        return capture_lease_response(receipt)


@app.post(
    "/v1/sessions/{session_id}/capture-leases/{lease_id}/renew",
    response_model=CaptureLeaseReceipt,
)
async def renew_capture_lease(
    session_id: UUID,
    lease_id: UUID,
    payload: CaptureLeaseRenewRequest,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    provider: CaptureProvider,
    policy: Policy,
    settings: RuntimeSettings,
) -> CaptureLeaseReceipt:
    return await execute_capture_lease_renewal(
        session_id, lease_id, payload, tenant_id, idempotency_key, provider, policy, settings
    )


async def execute_capture_lease_renewal(
    session_id: UUID,
    lease_id: UUID,
    payload: CaptureLeaseRenewRequest,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    provider: CaptureProvider,
    policy: Policy,
    settings: Settings,
    *,
    creator_actor_id: str | None = None,
) -> CaptureLeaseReceipt:
    _require_capture_protocol(settings)
    receipt_id = uuid4()
    async with provider.transaction(tenant_id) as store:
        previous_id = await _idempotent_entity(
            store,
            tenant_id,
            f"capture.lease.renew:{session_id}:{lease_id}",
            idempotency_key,
            _fingerprint(payload),
            receipt_id,
        )
        context = await _capture_context_or_404(
            store, tenant_id, session_id, policy, creator_actor_id=creator_actor_id
        )
        if previous_id is not None:
            previous = await store.get_capture_lease_receipt(tenant_id, previous_id)
            if (
                previous is None
                or previous.session_id != session_id
                or previous.lease_id != lease_id
            ):
                raise HTTPException(status_code=500, detail="Capture lease receipt is unavailable.")
            return capture_lease_response(previous)
        if context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
            raise HTTPException(status_code=409, detail="Session is not accepting capture.")
        receipt = await store.renew_capture_lease(
            tenant_id,
            session_id,
            expected_lease_id=lease_id,
            expected_generation=payload.expected_generation,
            receipt_id=receipt_id,
            duration=timedelta(seconds=CAPTURE_LEASE_TTL_SECONDS),
        )
        if receipt is None:
            raise HTTPException(status_code=409, detail="Capture lease renewal was rejected.")
        await store.audit(
            tenant_id=tenant_id,
            action="capture_lease.renewed",
            entity_type="capture_lease",
            entity_id=lease_id,
        )
        return capture_lease_response(receipt)


@app.get("/v1/sessions/{session_id}/capture-lease-state", response_model=CaptureLeaseState)
async def get_capture_lease_state(
    session_id: UUID,
    tenant_id: TenantId,
    provider: CaptureProvider,
    policy: Policy,
    settings: RuntimeSettings,
) -> CaptureLeaseState:
    """Observe capture authority, including untouched setup; never issue or renew it."""
    _require_capture_protocol(settings)
    async with provider.transaction(tenant_id) as store:
        context = await _capture_context_or_404(
            store, tenant_id, session_id, policy, require_audio_key=False
        )
        receipt = None
        if context.lease is not None:
            receipt = await store.capture_lease_receipt_for_generation(
                tenant_id,
                session_id,
                context.lease.generation,
            )
            if (
                receipt is None
                or receipt.lease_id != context.lease.lease_id
                or receipt.expires_at != context.lease.expires_at
            ):
                raise HTTPException(status_code=503, detail="Capture lease state is unavailable.")
        await store.audit(
            tenant_id=tenant_id,
            action="capture_lease.read",
            entity_type="capture_session",
            entity_id=session_id,
        )
        return CaptureLeaseState(
            session_id=session_id,
            current_lease=capture_lease_response(receipt) if receipt else None,
            lease_closed=context.lease is not None and context.lease.closed_at is not None,
            session_status=context.session.status,
        )


@app.post(
    "/v1/sessions/{session_id}/chunk-reservations",
    response_model=ChunkReservationBatchReceipt,
    status_code=201,
)
async def reserve_audio_chunks(
    session_id: UUID,
    payload: ChunkReservationBatchRequest,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    provider: CaptureProvider,
    policy: Policy,
    settings: RuntimeSettings,
) -> ChunkReservationBatchReceipt:
    return await execute_chunk_reservation(
        session_id, payload, tenant_id, idempotency_key, provider, policy, settings
    )


async def execute_chunk_reservation(
    session_id: UUID,
    payload: ChunkReservationBatchRequest,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    provider: CaptureProvider,
    policy: Policy,
    settings: Settings,
    *,
    creator_actor_id: str | None = None,
) -> ChunkReservationBatchReceipt:
    _require_capture_protocol(settings)
    if payload.count > MAX_RESERVATIONS_PER_BATCH:
        raise HTTPException(status_code=422, detail="Reservation batch is too large.")
    if payload.first_sequence_number + payload.count > MAX_CHUNKS:
        raise HTTPException(status_code=409, detail="Capture chunk limit would be exceeded.")
    batch_id = uuid4()
    object_ids = tuple(uuid4() for _ in range(payload.count))
    drafts = tuple(
        ChunkReservationDraft(
            object_id=object_id,
            sequence_number=payload.first_sequence_number + offset,
            channel=payload.channel,
            protocol_version=payload.protocol_version,
            additional_data=capture_channel_additional_data(
                tenant_id=tenant_id,
                session_id=session_id,
                object_id=object_id,
                sequence_number=payload.first_sequence_number + offset,
                channel=payload.channel.value,
            ),
            plaintext_budget_bytes=RESERVATION_PLAINTEXT_BUDGET_BYTES,
        )
        for offset, object_id in enumerate(object_ids)
    )
    async with provider.transaction(tenant_id) as store:
        previous_id = await _idempotent_entity(
            store,
            tenant_id,
            f"capture.reservations:{session_id}",
            idempotency_key,
            _fingerprint(payload),
            batch_id,
        )
        context = await _capture_context_or_404(
            store, tenant_id, session_id, policy, creator_actor_id=creator_actor_id
        )
        if previous_id is not None:
            previous = await store.get_chunk_reservation_batch(tenant_id, previous_id)
            if previous is None or previous.session_id != session_id:
                raise HTTPException(
                    status_code=500,
                    detail="Chunk reservation receipt is unavailable.",
                )
            return reservation_batch_response(previous)
        if context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
            raise HTTPException(status_code=409, detail="Session is not accepting reservations.")
        try:
            batch = await store.create_chunk_reservation_batch(
                tenant_id,
                session_id,
                batch_id=batch_id,
                lease_id=payload.capture_lease_id,
                lease_generation=payload.capture_lease_generation,
                requested_protocol_version=payload.protocol_version,
                drafts=drafts,
                maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
                maximum_chunks=MAX_CHUNKS,
                maximum_plaintext_bytes=min(
                    MAX_AGGREGATE_PLAINTEXT_BYTES, settings.audio_assembly_max_plaintext_bytes
                ),
            )
        except CaptureLeaseConflictError:
            raise HTTPException(status_code=409, detail="Capture lease is not active.") from None
        except CaptureReservationLimitError:
            raise HTTPException(
                status_code=409,
                detail="Capture reservation limit exceeded.",
            ) from None
        await store.audit(
            tenant_id=tenant_id,
            action="audio_chunk_reservations.created",
            entity_type="audio_chunk_reservation_batch",
            entity_id=batch.id,
        )
        return reservation_batch_response(batch)


@app.post(
    "/v1/sessions/{session_id}/chunks/{object_id}/upload-authorization",
    response_model=ChunkUploadAuthorization,
    status_code=201,
)
async def authorize_reserved_chunk_upload(
    session_id: UUID,
    object_id: UUID,
    payload: ChunkUploadAuthorizationRequest,
    response: Response,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    provider: CaptureProvider,
    policy: Policy,
    audio_storage: Storage,
    settings: RuntimeSettings,
) -> ChunkUploadAuthorization:
    _require_capture_protocol(settings)
    receipt_id = uuid4()
    async with provider.transaction(tenant_id) as store:
        previous_id = await _idempotent_entity(
            store,
            tenant_id,
            f"capture.upload-authorization:{session_id}:{object_id}",
            idempotency_key,
            _fingerprint(payload),
            receipt_id,
        )
        context = await _capture_context_or_404(store, tenant_id, session_id, policy)
        if context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
            raise HTTPException(status_code=409, detail="Session is closed for upload.")
        receipt = await store.get_chunk_receipt(tenant_id, session_id, object_id)
        if receipt is None:
            raise HTTPException(status_code=404, detail="Chunk reservation not found.")
        if receipt.registration is not None:
            raise HTTPException(status_code=409, detail="Chunk is already registered.")
        if previous_id is not None:
            authorization = await store.get_upload_authorization_receipt(
                tenant_id,
                previous_id,
            )
            if (
                authorization is None
                or authorization.session_id != session_id
                or authorization.reservation_object_id != object_id
            ):
                raise HTTPException(
                    status_code=500,
                    detail="Upload authorization receipt is unavailable.",
                )
            if not await store.is_upload_authorization_active(
                tenant_id,
                authorization.id,
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Upload authorization expired; use a new Idempotency-Key.",
                )
        else:
            authorization = await store.add_upload_authorization_receipt(
                tenant_id,
                session_id,
                object_id,
                receipt_id=receipt_id,
                duration=timedelta(seconds=RESERVATION_WINDOW_SECONDS),
            )
            if authorization is None:
                raise HTTPException(status_code=409, detail="Upload authorization was rejected.")
            await store.audit(
                tenant_id=tenant_id,
                action="audio_upload_authorization.issued",
                entity_type="audio_object",
                entity_id=object_id,
            )
        grant = await audio_storage.issue_upload_grant(
            tenant_id=tenant_id,
            session_id=session_id,
            object_id=object_id,
            request=AudioUploadGrantRequest(
                sequence_number=receipt.reservation.sequence_number,
                channel=receipt.reservation.channel,
            ),
            expires_at=authorization.expires_at,
        )
    response.headers["Cache-Control"] = "no-store"
    return ChunkUploadAuthorization(
        protocol_version=PROTOCOL_VERSION,
        authorization_receipt_id=authorization.id,
        object_id=object_id,
        additional_authenticated_data=base64url_encode(receipt.reservation.additional_data),
        upload_url=grant.upload_url,
        expires_at=authorization.expires_at,
    )


@app.get(
    "/v1/sessions/{session_id}/chunks/{object_id}",
    response_model=ChunkReceipt,
)
async def get_reserved_chunk_receipt(
    session_id: UUID,
    object_id: UUID,
    response: Response,
    tenant_id: TenantId,
    provider: CaptureProvider,
    settings: RuntimeSettings,
) -> ChunkReceipt:
    _require_capture_protocol(settings)
    async with provider.transaction(tenant_id) as store:
        if await store.get_session(tenant_id, session_id) is None:
            raise HTTPException(status_code=404, detail="Chunk reservation not found.")
        receipt = await store.get_chunk_receipt(tenant_id, session_id, object_id)
        if receipt is None:
            raise HTTPException(status_code=404, detail="Chunk reservation not found.")
    response.headers["Cache-Control"] = "no-store"
    return chunk_receipt_response(receipt)


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
    settings: RuntimeSettings,
) -> AudioUploadGrant:
    if settings.capture_protocol_enabled:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Legacy upload grants are retired for the capture protocol.",
        )
    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    _require_chunk_upload_session(session)
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


async def _register_reserved_chunk(
    session_id: UUID,
    payload: AudioChunkRegister,
    tenant_id: TenantId,
    idempotency_key: str,
    store: RepositoryContract,
    policy: ConsentPolicy,
) -> AudioChunk:
    if payload.ciphertext_size_bytes > MAX_ENVELOPE_BYTES:
        raise HTTPException(status_code=409, detail="Encrypted envelope exceeds protocol limit.")
    context = await _capture_context_or_404(store, tenant_id, session_id, policy)
    receipt = await store.get_chunk_receipt(tenant_id, session_id, payload.object_id)
    if receipt is None:
        raise HTTPException(status_code=409, detail="Audio object is not reserved.")
    if (
        receipt.reservation.sequence_number != payload.sequence_number
        or receipt.reservation.channel != payload.channel
        or receipt.reservation.protocol_version != PROTOCOL_VERSION
    ):
        raise HTTPException(
            status_code=409,
            detail="Audio registration does not match reservation.",
        )

    fingerprint = _fingerprint(payload)
    operation = f"capture.chunk.register:{session_id}"
    chunk = AudioChunk(
        id=uuid4(), session_id=session_id, registered_at=datetime.now(UTC), **payload.model_dump()
    )
    entity_id = receipt.registration.id if receipt.registration is not None else chunk.id
    previous_id = await _idempotent_entity(
        store, tenant_id, operation, idempotency_key, fingerprint, entity_id
    )
    if previous_id is not None:
        previous = await store.get_chunk(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent audio chunk is unavailable.")
        return previous
    if receipt.registration is not None:
        if (
            receipt.registration.sequence_number != payload.sequence_number
            or receipt.registration.channel != payload.channel
            or receipt.registration.object_id != payload.object_id
            or receipt.registration.sha256.casefold() != payload.sha256.casefold()
            or receipt.registration.ciphertext_size_bytes != payload.ciphertext_size_bytes
        ):
            raise HTTPException(status_code=409, detail="Audio registration is immutable.")
        return receipt.registration
    if context.session.status not in {SessionStatus.CREATED, SessionStatus.CAPTURING}:
        raise HTTPException(status_code=409, detail="Session is not accepting audio chunks.")
    if not await store.add_reserved_chunk(
        tenant_id,
        chunk,
        protocol_version=PROTOCOL_VERSION,
    ):
        raise HTTPException(status_code=409, detail="Audio registration is immutable.")
    await store.update_session(
        tenant_id,
        context.session.model_copy(update={"status": SessionStatus.CAPTURING}),
    )
    await store.audit(
        tenant_id=tenant_id,
        action="audio_chunk.registered",
        entity_type="audio_chunk",
        entity_id=chunk.id,
    )
    return chunk


@app.post("/v1/sessions/{session_id}/chunks", response_model=AudioChunk, status_code=201)
async def register_chunk(
    session_id: UUID,
    payload: AudioChunkRegister,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: CaptureRepository,
    policy: Policy,
    settings: RuntimeSettings,
) -> AudioChunk:
    if settings.capture_protocol_enabled:
        return await _register_reserved_chunk(
            session_id,
            payload,
            tenant_id,
            idempotency_key,
            store,
            policy,
        )

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
        _require_chunk_upload_session(replay_session)
        return previous

    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    _require_chunk_upload_session(session)
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


async def _complete_capture_protocol_session(
    session_id: UUID,
    payload: CaptureCompleteRequest,
    tenant_id: TenantId,
    idempotency_key: str,
    store: RepositoryContract,
    policy: ConsentPolicy,
) -> CaptureSession:
    fingerprint = _fingerprint(payload)
    previous_id = await _idempotent_entity(
        store,
        tenant_id,
        f"capture.session.complete:{session_id}",
        idempotency_key,
        fingerprint,
        session_id,
    )
    if previous_id is not None:
        previous = await store.get_session(tenant_id, previous_id)
        if previous is None:
            raise HTTPException(status_code=500, detail="Idempotent session is unavailable.")
        await _assert_session_consent(store, tenant_id, previous, policy)
        _require_chunk_upload_session(previous)
        return previous

    context = await _capture_context_or_404(store, tenant_id, session_id, policy)
    declarations = tuple(
        CaptureChannelFinalizationDraft(
            channel=item.channel,
            last_sequence_number=item.final_sequence_number,
        )
        for item in payload.channels
    )
    if (
        context.lease is None
        or context.lease.lease_id != payload.capture_lease_id
        or context.lease.generation != payload.capture_lease_generation
    ):
        raise HTTPException(status_code=409, detail="Capture lease fence does not match.")
    if context.session.status == SessionStatus.UPLOADED:
        existing = await store.capture_finalizations_for(tenant_id, session_id)
        if {item.channel: item.last_sequence_number for item in existing} != {
            item.channel: item.last_sequence_number for item in declarations
        }:
            raise HTTPException(status_code=409, detail="Capture completion is immutable.")
        return context.session
    if context.session.status != SessionStatus.CAPTURING:
        raise HTTPException(status_code=409, detail="Session cannot be completed.")
    try:
        await store.finalize_capture_channels(tenant_id, session_id, declarations)
    except CaptureFinalizationError:
        raise HTTPException(
            status_code=409,
            detail="Registered audio channels are not contiguous.",
        ) from None
    if not await store.close_capture_lease(
        tenant_id,
        session_id,
        expected_lease_id=payload.capture_lease_id,
        expected_generation=payload.capture_lease_generation,
        reason=CaptureLeaseCloseReason.SESSION_COMPLETED,
    ):
        raise HTTPException(status_code=409, detail="Capture lease closure was rejected.")
    completed = context.session.model_copy(update={"status": SessionStatus.UPLOADED})
    await store.update_session(tenant_id, completed)
    await store.audit(
        tenant_id=tenant_id,
        action="scribe_session.uploaded",
        entity_type="scribe_session",
        entity_id=session_id,
    )
    return completed


@app.post(
    "/v1/sessions/{session_id}/capture-complete",
    response_model=CaptureSession,
)
async def complete_capture_protocol_session(
    session_id: UUID,
    payload: CaptureCompleteRequest,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    provider: CaptureProvider,
    policy: Policy,
    settings: RuntimeSettings,
) -> CaptureSession:
    _require_capture_protocol(settings)
    async with provider.transaction(tenant_id) as store:
        return await _complete_capture_protocol_session(
            session_id,
            payload,
            tenant_id,
            idempotency_key,
            store,
            policy,
        )


@app.post("/v1/sessions/{session_id}/complete", response_model=CaptureSession)
async def complete_session(
    session_id: UUID,
    tenant_id: TenantId,
    idempotency_key: IdempotencyKey,
    store: Repository,
    policy: Policy,
    settings: RuntimeSettings,
) -> CaptureSession:
    if settings.capture_protocol_enabled:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Legacy completion is retired for the capture protocol.",
        )

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
        _require_chunk_upload_session(previous)
        return previous

    session = await _locked_session_or_404(store, tenant_id, session_id)
    await _assert_session_consent(store, tenant_id, session, policy)
    _require_chunk_upload_session(session)
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
        session.status,
        SessionStatus.TRANSCRIPT_READY,
        ingest_mode=session.ingest_mode,
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
    # The committed attempt is the durable in-flight boundary. Revocation can
    # stop later claims, while a crash leaves this attempt safe to retry.
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
                    or previous_idempotency.request_fingerprint != previous_delivery.payload_sha256
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
