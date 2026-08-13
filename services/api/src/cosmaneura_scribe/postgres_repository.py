from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID, uuid4

from azure.core.credentials import AccessToken
from azure.identity.aio import DefaultAzureCredential
from sqlalchemy import text
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .repository import (
    IdempotencyConflictError,
    Repository,
    UploadGrantRecord,
)
from .schemas import (
    AudioChunk,
    CaptureSession,
    ConsentRecord,
    Transcript,
)
from .settings import Settings

AZURE_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default"


class PostgresRepositoryProvider:
    def __init__(
        self,
        engine: AsyncEngine,
        credential: DefaultAzureCredential | None = None,
    ) -> None:
        self._engine = engine
        self._sessions = async_sessionmaker(engine, expire_on_commit=False)
        self._credential = credential

    @property
    def engine(self) -> AsyncEngine:
        return self._engine

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[Repository]:
        async with self._sessions() as session, session.begin():
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            yield PostgresRepository(session)

    async def health(self) -> None:
        async with self._engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def close(self) -> None:
        await self._engine.dispose()
        if self._credential is not None:
            await self._credential.close()


class PostgresRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def claim_idempotency(
        self,
        *,
        tenant_id: UUID,
        operation: str,
        key: str,
        request_fingerprint: str,
        entity_id: UUID,
    ) -> UUID | None:
        inserted = await self._session.execute(
            text(
                """
                INSERT INTO idempotency_records (
                    tenant_id, operation, idempotency_key, request_fingerprint, entity_id
                ) VALUES (
                    :tenant_id, :operation, :idempotency_key, :request_fingerprint, :entity_id
                )
                ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING
                RETURNING entity_id
                """
            ),
            {
                "tenant_id": tenant_id,
                "operation": operation,
                "idempotency_key": key,
                "request_fingerprint": request_fingerprint,
                "entity_id": entity_id,
            },
        )
        if inserted.scalar_one_or_none() is not None:
            return None

        previous = (
            (
                await self._session.execute(
                    text(
                        """
                    SELECT request_fingerprint, entity_id
                    FROM idempotency_records
                    WHERE tenant_id = :tenant_id
                      AND operation = :operation
                      AND idempotency_key = :idempotency_key
                    """
                    ),
                    {
                        "tenant_id": tenant_id,
                        "operation": operation,
                        "idempotency_key": key,
                    },
                )
            )
            .mappings()
            .one()
        )
        if previous["request_fingerprint"] != request_fingerprint:
            raise IdempotencyConflictError
        return previous["entity_id"]

    async def get_consent(self, tenant_id: UUID, consent_id: UUID) -> ConsentRecord | None:
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, modality,
                   participant_regions, method, all_parties_consented, granted_at,
                   evidence_object_id, policy_version, revoked_at
            FROM consent_records
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=consent_id,
        )
        return ConsentRecord.model_validate(row) if row is not None else None

    async def add_consent(self, tenant_id: UUID, consent: ConsentRecord) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO consent_records (
                    id, tenant_id, appointment_id, practitioner_id, patient_id, modality,
                    participant_regions, method, all_parties_consented, granted_at,
                    evidence_object_id, policy_version, revoked_at
                ) VALUES (
                    :id, :tenant_id, :appointment_id, :practitioner_id, :patient_id, :modality,
                    :participant_regions, :method, :all_parties_consented, :granted_at,
                    :evidence_object_id, :policy_version, :revoked_at
                )
                """
            ),
            {
                **consent.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "modality": consent.modality.value,
                "method": consent.method.value,
                "participant_regions": sorted(consent.participant_regions),
            },
        )

    async def get_session(self, tenant_id: UUID, session_id: UUID) -> CaptureSession | None:
        row = await self._one_or_none(
            """
            SELECT id, appointment_id, practitioner_id, patient_id, consent_record_id,
                   modality, status, created_at
            FROM scribe_sessions
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=session_id,
        )
        return CaptureSession.model_validate(row) if row is not None else None

    async def add_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO scribe_sessions (
                    id, tenant_id, appointment_id, practitioner_id, patient_id,
                    consent_record_id, modality, status, created_at
                ) VALUES (
                    :id, :tenant_id, :appointment_id, :practitioner_id, :patient_id,
                    :consent_record_id, :modality, :status, :created_at
                )
                """
            ),
            {
                **session.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "modality": session.modality.value,
                "status": session.status.value,
            },
        )

    async def update_session(self, tenant_id: UUID, session: CaptureSession) -> None:
        await self._session.execute(
            text(
                """
                UPDATE scribe_sessions
                SET status = :status
                WHERE tenant_id = :tenant_id AND id = :id
                """
            ),
            {"tenant_id": tenant_id, "id": session.id, "status": session.status.value},
        )

    async def get_chunk(self, tenant_id: UUID, chunk_id: UUID) -> AudioChunk | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, sequence_number, channel, object_id, sha256,
                   ciphertext_size_bytes, registered_at
            FROM audio_chunks
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=chunk_id,
        )
        return AudioChunk.model_validate(row) if row is not None else None

    async def add_chunk(self, tenant_id: UUID, chunk: AudioChunk) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO audio_chunks (
                    id, tenant_id, session_id, sequence_number, channel, object_id,
                    sha256, ciphertext_size_bytes, registered_at
                ) VALUES (
                    :id, :tenant_id, :session_id, :sequence_number, :channel, :object_id,
                    :sha256, :ciphertext_size_bytes, :registered_at
                )
                """
            ),
            {
                **chunk.model_dump(mode="python"),
                "tenant_id": tenant_id,
                "channel": chunk.channel.value,
            },
        )

    async def chunks_for(self, tenant_id: UUID, session_id: UUID) -> list[AudioChunk]:
        rows = (
            (
                await self._session.execute(
                    text(
                        """
                    SELECT id, session_id, sequence_number, channel, object_id, sha256,
                           ciphertext_size_bytes, registered_at
                    FROM audio_chunks
                    WHERE tenant_id = :tenant_id AND session_id = :session_id
                    ORDER BY sequence_number, channel
                    """
                    ),
                    {"tenant_id": tenant_id, "session_id": session_id},
                )
            )
            .mappings()
            .all()
        )
        return [AudioChunk.model_validate(dict(row)) for row in rows]

    async def get_upload_grant(self, tenant_id: UUID, object_id: UUID) -> UploadGrantRecord | None:
        row = await self._one_or_none(
            """
            SELECT object_id, session_id, sequence_number, channel, expires_at
            FROM audio_upload_grants
            WHERE tenant_id = :tenant_id AND object_id = :id
            """,
            tenant_id=tenant_id,
            id=object_id,
        )
        return UploadGrantRecord(**row) if row is not None else None

    async def add_upload_grant(self, tenant_id: UUID, grant: UploadGrantRecord) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO audio_upload_grants (
                    object_id, tenant_id, session_id, sequence_number, channel, expires_at
                ) VALUES (
                    :object_id, :tenant_id, :session_id, :sequence_number, :channel, :expires_at
                )
                """
            ),
            {
                **grant.__dict__,
                "tenant_id": tenant_id,
                "channel": grant.channel.value,
            },
        )

    async def get_transcript(self, tenant_id: UUID, transcript_id: UUID) -> Transcript | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, language_code, stt_provider, segments, created_at
            FROM transcripts
            WHERE tenant_id = :tenant_id AND id = :id
            """,
            tenant_id=tenant_id,
            id=transcript_id,
        )
        return Transcript.model_validate(row) if row is not None else None

    async def add_transcript(self, tenant_id: UUID, transcript: Transcript) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO transcripts (
                    id, tenant_id, session_id, language_code, stt_provider, segments, created_at
                ) VALUES (
                    :id, :tenant_id, :session_id, :language_code, :stt_provider,
                    CAST(:segments AS jsonb), :created_at
                )
                """
            ),
            {
                "tenant_id": tenant_id,
                "id": transcript.id,
                "session_id": transcript.session_id,
                "language_code": transcript.language_code,
                "stt_provider": transcript.stt_provider,
                "created_at": transcript.created_at,
                "segments": json.dumps(
                    [segment.model_dump(mode="json") for segment in transcript.segments]
                ),
            },
        )

    async def transcript_for(self, tenant_id: UUID, session_id: UUID) -> Transcript | None:
        row = await self._one_or_none(
            """
            SELECT id, session_id, language_code, stt_provider, segments, created_at
            FROM transcripts
            WHERE tenant_id = :tenant_id AND session_id = :session_id
            """,
            tenant_id=tenant_id,
            session_id=session_id,
        )
        return Transcript.model_validate(row) if row is not None else None

    async def audit(
        self, *, tenant_id: UUID, action: str, entity_type: str, entity_id: UUID
    ) -> None:
        await self._session.execute(
            text(
                """
                INSERT INTO audit_events (id, tenant_id, action, entity_type, entity_id)
                VALUES (:id, :tenant_id, :action, :entity_type, :entity_id)
                """
            ),
            {
                "id": uuid4(),
                "tenant_id": tenant_id,
                "action": action,
                "entity_type": entity_type,
                "entity_id": entity_id,
            },
        )

    async def _one_or_none(self, statement: str, **params: object) -> dict[str, Any] | None:
        row = (await self._session.execute(text(statement), params)).mappings().one_or_none()
        return dict(row) if row is not None else None


def build_postgres_provider(settings: Settings) -> PostgresRepositoryProvider:
    credential: DefaultAzureCredential | None = None
    connect_args: dict[str, object] = {}

    if settings.database_url is not None:
        url: str | URL = settings.database_url.get_secret_value()
    else:
        if settings.database_host is None or settings.database_user is None:
            raise ValueError("PostgreSQL requires database_host and database_user")
        credential = DefaultAzureCredential(
            managed_identity_client_id=(
                str(settings.managed_identity_client_id)
                if settings.managed_identity_client_id is not None
                else None
            ),
            require_envvar=False,
        )

        async def azure_password() -> str:
            token: AccessToken = await credential.get_token(AZURE_POSTGRES_SCOPE)
            return token.token

        url = URL.create(
            drivername="postgresql+asyncpg",
            username=settings.database_user,
            host=settings.database_host,
            port=settings.database_port,
            database=settings.database_name,
        )
        connect_args["password"] = azure_password

    connect_args["ssl"] = settings.database_ssl
    engine = create_async_engine(
        url,
        connect_args=connect_args,
        pool_pre_ping=True,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_max_overflow,
    )
    return PostgresRepositoryProvider(engine, credential)
