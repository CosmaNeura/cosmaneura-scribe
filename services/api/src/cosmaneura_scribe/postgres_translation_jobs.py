from __future__ import annotations

import hmac
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime
from functools import wraps
from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from .external_transcript_v1 import TranslationOutcome, TranslationRecordV1
from .normalized_source_persistence import (
    NormalizedSourcePersistenceError,
    NormalizedSourceTranscriptRecord,
)
from .postgres_repository import PostgresRepository
from .session_state_v1 import SessionIngestMode
from .translation_adapter import ReservedSpanishTranslation
from .translation_attempt_persistence import translation_matches_command
from .translation_execution_v1 import DurableTranslationJobRecordV1, DurableTranslationJobStatus
from .translation_job_encryption import (
    EncryptedTranslationJob,
    TranslationJobCipher,
    TranslationJobStoreError,
    job_metadata,
    job_scope,
)
from .translation_job_v1 import CompletedTranslationJobV1

_SCOPE = "tenant_id = :tenant_id AND session_id = :session_id AND translation_id = :translation_id"
_METADATA = (
    "tenant_id",
    "session_id",
    "translation_id",
    "source_transcript_version",
    "source_segment_id",
    "source_segment_version",
    "previous_translation_version",
    "status",
    "reserved_at",
    "provider_call_started_at",
    "provider_result_stored_at",
    "attempt_committed_at",
    "expires_at",
)
_SEALED = ("key_version", "wrapped_dek", "nonce", "ciphertext")


def _safe_job_operation[**P, T](operation: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[T]]:
    @wraps(operation)
    async def bounded(*args: P.args, **kwargs: P.kwargs) -> T:
        try:
            return await operation(*args, **kwargs)
        except NormalizedSourcePersistenceError:
            failure = "translation_job_authority_invalid"
        except DBAPIError:
            failure = "translation_job_transaction_failed"
        except TranslationJobStoreError as error:
            failure = str(error)
        # Must be outside both the exception handler and the async context manager:
        # contextlib otherwise reattaches the original error passed to __aexit__.
        raise TranslationJobStoreError(failure) from None

    return bounded


class PostgresTranslationJobStore:
    """Dormant tenant-scoped durable store; not registered by the API or a worker.

    Tenant IDs are trusted worker context, never request-body authority. The
    supplied engine/cipher are caller-owned. Every operation owns its transaction;
    consent -> session -> job is the lock order shared with existing writers.
    """

    def __init__(
        self,
        engine: AsyncEngine,
        cipher: TranslationJobCipher,
        *,
        normalized_ingest_mode: SessionIngestMode = SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT,
    ) -> None:
        if not isinstance(cast(object, normalized_ingest_mode), SessionIngestMode):
            raise ValueError("translation store ingest mode is invalid")
        self._sessions = async_sessionmaker(engine, expire_on_commit=False)
        self._cipher = cipher
        self._normalized_ingest_mode = normalized_ingest_mode

    @asynccontextmanager
    async def _transaction(
        self, tenant_id: UUID
    ) -> AsyncGenerator[tuple[AsyncSession, PostgresRepository]]:
        async with self._sessions() as database, database.begin():
            await database.execute(text("SET LOCAL lock_timeout = '5s'"))
            await database.execute(text("SET LOCAL statement_timeout = '60s'"))
            await database.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            yield database, PostgresRepository(
                database, normalized_ingest_mode=self._normalized_ingest_mode
            )

    @staticmethod
    async def _now(database: AsyncSession) -> datetime:
        now = await database.scalar(text("SELECT clock_timestamp()"))
        if not isinstance(now, datetime):
            raise TranslationJobStoreError("translation_job_clock_unavailable")
        return now

    @staticmethod
    def _check_source(
        source: NormalizedSourceTranscriptRecord, reservation: ReservedSpanishTranslation
    ) -> None:
        segment = next(
            (
                item
                for item in source.segments
                if item.source_segment_id == reservation.source_segment_id
            ),
            None,
        )
        if (
            source.source_transcript_version != reservation.expected_source_transcript_version
            or segment is None
            or segment.source_segment_version != reservation.expected_source_segment_version
            or segment.source_locale != reservation.source_locale
            or segment.content != reservation.source_content
        ):
            raise TranslationJobStoreError("translation_job_source_conflict")

    @staticmethod
    async def _eligible(
        database: AsyncSession, scope: dict[str, UUID], reservation: ReservedSpanishTranslation
    ) -> None:
        row = (
            (
                await database.execute(
                    text("""
            SELECT session.status,
                (SELECT COALESCE(max(attempt.translation_version), 0)
                 FROM normalized_translation_attempts AS attempt
                 WHERE attempt.tenant_id = session.tenant_id AND attempt.session_id = session.id
                   AND attempt.source_transcript_version = :source_version
                   AND attempt.source_segment_id = :segment_id
                   AND attempt.source_segment_version = :segment_version) AS previous_version,
                EXISTS (
                    SELECT 1 FROM normalized_translation_reviews AS review
                    WHERE review.tenant_id = session.tenant_id AND review.session_id = session.id
                      AND review.source_transcript_version = :source_version
                      AND review.source_segment_id = :segment_id
                      AND review.source_segment_version = :segment_version
                      AND review.decision = 'accepted'
                ) AS accepted,
                EXISTS (
                    SELECT 1 FROM normalized_translation_attempts AS attempt
                    WHERE attempt.tenant_id = session.tenant_id AND attempt.session_id = session.id
                      AND attempt.source_transcript_version = :source_version
                      AND attempt.source_segment_id = :segment_id
                      AND attempt.source_segment_version = :segment_version
                      AND attempt.translation_version = :previous_version
                      AND attempt.outcome = 'succeeded'
                      AND NOT EXISTS (
                          SELECT 1 FROM normalized_translation_reviews AS review
                          WHERE review.tenant_id = attempt.tenant_id
                            AND review.session_id = attempt.session_id
                            AND review.translation_id = attempt.translation_id
                            AND review.translation_version = attempt.translation_version
                            AND review.decision = 'rejected'
                      )
                ) AS awaiting_review
            FROM scribe_sessions AS session
            WHERE session.tenant_id = :tenant_id AND session.id = :session_id
        """),
                    {
                        **scope,
                        "source_version": reservation.expected_source_transcript_version,
                        "segment_id": reservation.source_segment_id,
                        "segment_version": reservation.expected_source_segment_version,
                        "previous_version": reservation.expected_previous_translation_version,
                    },
                )
            )
            .mappings()
            .one_or_none()
        )
        if (
            row is None
            or row["status"] != "translation_pending"
            or row["previous_version"] != reservation.expected_previous_translation_version
            or row["accepted"]
            or row["awaiting_review"]
        ):
            raise TranslationJobStoreError("translation_job_not_eligible")

    async def _load(
        self,
        database: AsyncSession,
        scope: dict[str, UUID],
        source: NormalizedSourceTranscriptRecord,
    ) -> DurableTranslationJobRecordV1 | None:
        row = (
            (
                await database.execute(
                    text(f"SELECT * FROM encrypted_translation_jobs WHERE {_SCOPE} FOR UPDATE"),
                    scope,
                )
            )
            .mappings()
            .one_or_none()
        )
        if row is None:
            return None
        metadata = {name: row[name] for name in _METADATA}
        record = await self._cipher.open(
            EncryptedTranslationJob(
                key_version=row["key_version"],
                wrapped_dek=row["wrapped_dek"],
                nonce=bytes(row["nonce"]),
                ciphertext=bytes(row["ciphertext"]),
            ),
            metadata=metadata,
        )
        self._check_source(source, record.reservation)
        if metadata["expires_at"] != source.transcript_content_expires_at:
            raise TranslationJobStoreError("translation_job_retention_conflict")
        await self._unexpired(database, source)
        return record

    async def _save(
        self,
        database: AsyncSession,
        repository: PostgresRepository,
        source: NormalizedSourceTranscriptRecord,
        record: DurableTranslationJobRecordV1,
        *,
        insert: bool = False,
    ) -> None:
        metadata = job_metadata(record, source.transcript_content_expires_at)
        envelope = await self._cipher.seal(record, expires_at=source.transcript_content_expires_at)
        values = {**metadata, **{name: getattr(envelope, name) for name in _SEALED}}
        await self._unexpired(database, source)
        if insert:
            columns = (*_METADATA, *_SEALED)
            sql = (
                f"INSERT INTO encrypted_translation_jobs ({', '.join(columns)}) "
                f"VALUES ({', '.join(':' + name for name in columns)})"
            )
        else:
            mutable = (
                "status",
                "provider_call_started_at",
                "provider_result_stored_at",
                "attempt_committed_at",
                *_SEALED,
            )
            sql = (
                "UPDATE encrypted_translation_jobs SET "
                + ", ".join(f"{name} = :{name}" for name in mutable)
                + f" WHERE {_SCOPE}"
            )
        await database.execute(text(sql), values)
        await repository.audit(
            tenant_id=record.tenant_id,
            action=f"translation_job.{record.status.value}",
            entity_type="translation_job",
            entity_id=record.reservation.translation_id,
        )

    @classmethod
    async def _unexpired(
        cls, database: AsyncSession, source: NormalizedSourceTranscriptRecord
    ) -> None:
        if await cls._now(database) >= source.transcript_content_expires_at:
            raise TranslationJobStoreError("translation_job_retention_expired")

    @_safe_job_operation
    async def reserve_translation_job(
        self, tenant_id: UUID, session_id: UUID, reservation: ReservedSpanishTranslation
    ) -> DurableTranslationJobRecordV1:
        scope = job_scope(tenant_id, session_id, reservation.translation_id)
        async with self._transaction(tenant_id) as (database, repository):
            source = await repository.get_current_normalized_source_transcript(
                tenant_id, session_id
            )
            if source is None:
                raise TranslationJobStoreError("translation_job_target_not_found")
            self._check_source(source, reservation)
            existing = await self._load(database, scope, source)
            if existing is not None:
                if existing.reservation != reservation:
                    raise TranslationJobStoreError("translation_job_reservation_conflict")
                return existing
            await self._eligible(database, scope, reservation)
            record = DurableTranslationJobRecordV1(
                tenant_id=tenant_id,
                session_id=session_id,
                reservation=reservation,
                status=DurableTranslationJobStatus.RESERVED,
                reserved_at=await self._now(database),
            )
            await self._save(database, repository, source, record, insert=True)
            return record

    @_safe_job_operation
    async def get_translation_job(
        self, tenant_id: UUID, session_id: UUID, translation_id: UUID
    ) -> DurableTranslationJobRecordV1 | None:
        scope = job_scope(tenant_id, session_id, translation_id)
        async with self._transaction(tenant_id) as (database, repository):
            source = await repository.get_current_normalized_source_transcript(
                tenant_id, session_id
            )
            if source is None:
                return None
            return await self._load(database, scope, source)

    @_safe_job_operation
    async def claim_provider_call(
        self, tenant_id: UUID, session_id: UUID, translation_id: UUID, *, provider_call_token: UUID
    ) -> DurableTranslationJobRecordV1 | None:
        scope = job_scope(tenant_id, session_id, translation_id)
        if not isinstance(cast(object, provider_call_token), UUID):
            raise TranslationJobStoreError("translation_job_call_token_invalid")
        async with self._transaction(tenant_id) as (database, repository):
            source = await repository.get_current_normalized_source_transcript(
                tenant_id, session_id
            )
            if source is None:
                return None
            record = await self._load(database, scope, source)
            if record is None or record.status != DurableTranslationJobStatus.RESERVED:
                return None
            await self._eligible(database, scope, record.reservation)
            claimed = replace(
                record,
                status=DurableTranslationJobStatus.PROVIDER_CALL_STARTED,
                provider_call_token=provider_call_token,
                provider_call_started_at=await self._now(database),
            )
            await self._save(database, repository, source, claimed)
            return claimed

    @_safe_job_operation
    async def store_provider_result(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
        *,
        provider_call_token: UUID,
        completed_job: CompletedTranslationJobV1,
    ) -> DurableTranslationJobRecordV1:
        scope = job_scope(tenant_id, session_id, translation_id)
        async with self._transaction(tenant_id) as (database, repository):
            source = await repository.get_current_normalized_source_transcript(
                tenant_id, session_id
            )
            if source is None:
                raise TranslationJobStoreError("translation_job_target_not_found")
            record = await self._load(database, scope, source)
            if (
                record is None
                or record.status == DurableTranslationJobStatus.RESERVED
                or record.provider_call_token != provider_call_token
            ):
                raise TranslationJobStoreError("translation_job_result_conflict")
            if record.completed_job is not None:
                if record.completed_job != completed_job:
                    raise TranslationJobStoreError("translation_job_result_conflict")
                return record
            stored: DurableTranslationJobRecordV1 | None = None
            try:
                stored = replace(
                    record,
                    status=DurableTranslationJobStatus.PROVIDER_RESULT_STORED,
                    completed_job=completed_job,
                    provider_result_stored_at=await self._now(database),
                )
            except (TypeError, ValueError):
                pass
            if stored is None:
                raise TranslationJobStoreError("translation_job_result_conflict") from None
            await self._save(database, repository, source, stored)
            return stored

    @_safe_job_operation
    async def mark_attempt_committed(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
        *,
        completed_job_fingerprint: str,
    ) -> DurableTranslationJobRecordV1:
        scope = job_scope(tenant_id, session_id, translation_id)
        async with self._transaction(tenant_id) as (database, repository):
            source = await repository.get_current_normalized_source_transcript(
                tenant_id, session_id
            )
            if source is None:
                raise TranslationJobStoreError("translation_job_target_not_found")
            record = await self._load(database, scope, source)
            if (
                record is None
                or record.completed_job is None
                or not isinstance(cast(object, completed_job_fingerprint), str)
                or not completed_job_fingerprint.isascii()
                or not hmac.compare_digest(
                    record.completed_job.fingerprint(), completed_job_fingerprint
                )
            ):
                raise TranslationJobStoreError("translation_job_commit_conflict")
            row = (
                (
                    await database.execute(
                        text(f"""
                SELECT translation_id, translation_version, source_segment_id,
                       source_segment_version, source_locale, target_locale, outcome,
                       content, failure_code, translation_adapter_id,
                       translation_model_profile_id, created_at, source_transcript_version
                FROM normalized_translation_attempts WHERE {_SCOPE}
            """),
                        scope,
                    )
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                raise TranslationJobStoreError("translation_job_attempt_not_committed")
            values = dict(row)
            source_version = values.pop("source_transcript_version")
            matches = False
            try:
                values["outcome"] = TranslationOutcome(values["outcome"])
                matches = translation_matches_command(
                    TranslationRecordV1.model_validate(values),
                    record.completed_job.to_command(),
                    source_transcript_version=source_version,
                )
            except (TypeError, ValueError):
                pass
            if not matches:
                raise TranslationJobStoreError("translation_job_commit_conflict")
            if record.status == DurableTranslationJobStatus.ATTEMPT_COMMITTED:
                return record
            committed = replace(
                record,
                status=DurableTranslationJobStatus.ATTEMPT_COMMITTED,
                attempt_committed_at=await self._now(database),
            )
            await self._save(database, repository, source, committed)
            return committed

    def __repr__(self) -> str:
        return "PostgresTranslationJobStore(<protected>)"
