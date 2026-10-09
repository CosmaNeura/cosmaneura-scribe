from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Protocol, cast
from uuid import UUID

from .canonical_json import canonical_sha256
from .derived_writer_transactions import commit_translation_attempt_and_publish
from .repository import RepositoryProvider
from .translation_adapter import (
    ReservedSpanishTranslation,
    SpanishToEnglishTranslationAdapter,
    prepare_spanish_to_english_attempt,
)
from .translation_job_v1 import CompletedTranslationJobV1


class DurableTranslationJobStatus(StrEnum):
    RESERVED = "reserved"
    PROVIDER_CALL_STARTED = "provider_call_started"
    PROVIDER_RESULT_STORED = "provider_result_stored"
    ATTEMPT_COMMITTED = "attempt_committed"


class TranslationExecutionDisposition(StrEnum):
    PROVIDER_RESULT_COMMITTED = "provider_result_committed"
    STORED_RESULT_COMMITTED = "stored_result_committed"
    ALREADY_COMMITTED = "already_committed"
    PROVIDER_CALL_NOT_REPLAYED = "provider_call_not_replayed"


@dataclass(frozen=True, repr=False)
class DurableTranslationJobRecordV1:
    """Protected state; a production store must encrypt it and enforce tenant scope."""

    tenant_id: UUID
    session_id: UUID
    reservation: ReservedSpanishTranslation = field(repr=False)
    status: DurableTranslationJobStatus
    reserved_at: datetime
    provider_call_token: UUID | None = field(default=None, repr=False)
    provider_call_started_at: datetime | None = None
    completed_job: CompletedTranslationJobV1 | None = field(default=None, repr=False)
    provider_result_stored_at: datetime | None = None
    attempt_committed_at: datetime | None = None

    def __post_init__(self) -> None:
        if (
            not isinstance(cast(object, self.tenant_id), UUID)
            or not isinstance(cast(object, self.session_id), UUID)
            or not isinstance(cast(object, self.reservation), ReservedSpanishTranslation)
            or not isinstance(cast(object, self.status), DurableTranslationJobStatus)
            or (
                self.provider_call_token is not None
                and not isinstance(cast(object, self.provider_call_token), UUID)
            )
            or (
                self.completed_job is not None
                and not isinstance(cast(object, self.completed_job), CompletedTranslationJobV1)
            )
        ):
            raise ValueError("durable translation job field type is invalid")
        timestamps = (
            self.reserved_at,
            self.provider_call_started_at,
            self.provider_result_stored_at,
            self.attempt_committed_at,
        )
        if any(
            value is not None and (value.tzinfo is None or value.utcoffset() is None)
            for value in timestamps
        ):
            raise ValueError("durable translation job timestamp requires an offset")
        if (
            self.provider_call_started_at is not None
            and self.provider_call_started_at < self.reserved_at
        ):
            raise ValueError("translation provider call precedes reservation")
        if self.provider_result_stored_at is not None and (
            self.provider_call_started_at is None
            or self.provider_result_stored_at < self.provider_call_started_at
        ):
            raise ValueError("translation result precedes provider call")
        if self.attempt_committed_at is not None and (
            self.provider_result_stored_at is None
            or self.attempt_committed_at < self.provider_result_stored_at
        ):
            raise ValueError("translation commit precedes stored result")

        expected_presence = {
            DurableTranslationJobStatus.RESERVED: (False, False, False, False),
            DurableTranslationJobStatus.PROVIDER_CALL_STARTED: (True, True, False, False),
            DurableTranslationJobStatus.PROVIDER_RESULT_STORED: (True, True, True, True),
            DurableTranslationJobStatus.ATTEMPT_COMMITTED: (True, True, True, True),
        }
        token_expected, started_expected, job_expected, stored_expected = expected_presence[
            self.status
        ]
        actual_presence = (
            self.provider_call_token is not None,
            self.provider_call_started_at is not None,
            self.completed_job is not None,
            self.provider_result_stored_at is not None,
        )
        if actual_presence != (
            token_expected,
            started_expected,
            job_expected,
            stored_expected,
        ):
            raise ValueError("durable translation job state is inconsistent")
        if (self.status == DurableTranslationJobStatus.ATTEMPT_COMMITTED) != (
            self.attempt_committed_at is not None
        ):
            raise ValueError("durable translation commit state is inconsistent")
        if self.completed_job is not None:
            completed = self.completed_job
            reservation = self.reservation
            if (
                completed.tenant_id != self.tenant_id
                or completed.session_id != self.session_id
                or completed.translation_id != reservation.translation_id
                or completed.expected_source_transcript_version
                != reservation.expected_source_transcript_version
                or completed.source_segment_id != reservation.source_segment_id
                or completed.expected_source_segment_version
                != reservation.expected_source_segment_version
                or completed.expected_previous_translation_version
                != reservation.expected_previous_translation_version
                or completed.source_locale != reservation.source_locale.value
                or completed.target_locale != "en-US"
            ):
                raise ValueError("completed translation job does not match reservation")

    def reservation_fingerprint(self) -> str:
        reservation = self.reservation
        return canonical_sha256(
            {
                "contract": "durable-translation-reservation-v1",
                "tenant_id": self.tenant_id,
                "session_id": self.session_id,
                "translation_id": reservation.translation_id,
                "expected_source_transcript_version": (
                    reservation.expected_source_transcript_version
                ),
                "source_segment_id": reservation.source_segment_id,
                "expected_source_segment_version": (reservation.expected_source_segment_version),
                "expected_previous_translation_version": (
                    reservation.expected_previous_translation_version
                ),
                "source_locale": reservation.source_locale,
                "source_content": reservation.source_content,
            }
        )

    def __repr__(self) -> str:
        return f"DurableTranslationJobRecordV1(status={self.status.value!r})"

    def __str__(self) -> str:
        return self.__repr__()


class DurableTranslationJobStore(Protocol):
    """Atomic encrypted-store contract; implementations must not log record values."""

    async def reserve_translation_job(
        self,
        tenant_id: UUID,
        session_id: UUID,
        reservation: ReservedSpanishTranslation,
    ) -> DurableTranslationJobRecordV1:
        """Create once with store-owned time; exact replay returns the current record."""
        ...

    async def get_translation_job(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
    ) -> DurableTranslationJobRecordV1 | None: ...

    async def claim_provider_call(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
        *,
        provider_call_token: UUID,
    ) -> DurableTranslationJobRecordV1 | None:
        """Atomically move RESERVED to started using store-owned time; else return None."""
        ...

    async def store_provider_result(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
        *,
        provider_call_token: UUID,
        completed_job: CompletedTranslationJobV1,
    ) -> DurableTranslationJobRecordV1:
        """Atomically retain one result with store-owned time before database commit."""
        ...

    async def mark_attempt_committed(
        self,
        tenant_id: UUID,
        session_id: UUID,
        translation_id: UUID,
        *,
        completed_job_fingerprint: str,
    ) -> DurableTranslationJobRecordV1:
        """Mark the exact job committed using store-owned time after writer success."""
        ...


class CompletedTranslationJobCommitter(Protocol):
    async def commit_completed_translation_job(
        self,
        completed_job: CompletedTranslationJobV1,
    ) -> None: ...


@dataclass(frozen=True, repr=False)
class RepositoryCompletedTranslationJobCommitter:
    """Dormant bridge to the existing transaction-owning idempotent writer."""

    repositories: RepositoryProvider = field(repr=False)

    async def commit_completed_translation_job(
        self,
        completed_job: CompletedTranslationJobV1,
    ) -> None:
        publication = await commit_translation_attempt_and_publish(
            self.repositories,
            completed_job.tenant_id,
            completed_job.session_id,
            completed_job.to_command(),
        )
        if publication is None:
            raise ValueError("translation_attempt_target_not_found")

    def __repr__(self) -> str:
        return "RepositoryCompletedTranslationJobCommitter(<protected>)"


@dataclass(frozen=True, repr=False)
class TranslationExecutionReceiptV1:
    tenant_id: UUID
    session_id: UUID
    translation_id: UUID
    disposition: TranslationExecutionDisposition

    def __repr__(self) -> str:
        return f"TranslationExecutionReceiptV1(disposition={self.disposition.value!r})"

    def __str__(self) -> str:
        return self.__repr__()


def _receipt(
    record: DurableTranslationJobRecordV1,
    disposition: TranslationExecutionDisposition,
) -> TranslationExecutionReceiptV1:
    return TranslationExecutionReceiptV1(
        tenant_id=record.tenant_id,
        session_id=record.session_id,
        translation_id=record.reservation.translation_id,
        disposition=disposition,
    )


def _require_job_identity(
    record: DurableTranslationJobRecordV1,
    *,
    tenant_id: UUID,
    session_id: UUID,
    translation_id: UUID,
) -> None:
    if (
        record.tenant_id != tenant_id
        or record.session_id != session_id
        or record.reservation.translation_id != translation_id
    ):
        raise ValueError("durable_translation_job_scope_conflict")


def _require_reservation_unchanged(
    record: DurableTranslationJobRecordV1,
    *,
    reservation_fingerprint: str,
    reserved_at: datetime,
) -> None:
    if (
        record.reservation_fingerprint() != reservation_fingerprint
        or record.reserved_at != reserved_at
    ):
        raise ValueError("durable_translation_job_reservation_conflict")


async def execute_reserved_translation_job(
    *,
    store: DurableTranslationJobStore,
    adapter: SpanishToEnglishTranslationAdapter,
    committer: CompletedTranslationJobCommitter,
    tenant_id: UUID,
    session_id: UUID,
    translation_id: UUID,
    provider_call_token: UUID,
) -> TranslationExecutionReceiptV1:
    """Execute or resume without ever replaying a provider call of uncertain outcome."""

    record = await store.get_translation_job(tenant_id, session_id, translation_id)
    if record is None:
        raise ValueError("durable_translation_job_not_found")
    _require_job_identity(
        record,
        tenant_id=tenant_id,
        session_id=session_id,
        translation_id=translation_id,
    )
    reservation_fingerprint = record.reservation_fingerprint()
    reserved_at = record.reserved_at

    provider_called = False
    if record.status == DurableTranslationJobStatus.RESERVED:
        claimed = await store.claim_provider_call(
            tenant_id,
            session_id,
            translation_id,
            provider_call_token=provider_call_token,
        )
        if claimed is None:
            record = await store.get_translation_job(tenant_id, session_id, translation_id)
            if record is None:
                raise ValueError("durable_translation_job_state_conflict")
        else:
            record = claimed
            _require_job_identity(
                record,
                tenant_id=tenant_id,
                session_id=session_id,
                translation_id=translation_id,
            )
            _require_reservation_unchanged(
                record,
                reservation_fingerprint=reservation_fingerprint,
                reserved_at=reserved_at,
            )
            if (
                record.status != DurableTranslationJobStatus.PROVIDER_CALL_STARTED
                or record.provider_call_token != provider_call_token
            ):
                raise ValueError("durable_translation_job_claim_conflict")
            command = await prepare_spanish_to_english_attempt(adapter, record.reservation)
            completed = CompletedTranslationJobV1.from_command(
                tenant_id=record.tenant_id,
                session_id=record.session_id,
                command=command,
            )
            record = await store.store_provider_result(
                tenant_id,
                session_id,
                translation_id,
                provider_call_token=provider_call_token,
                completed_job=completed,
            )
            if (
                record.status != DurableTranslationJobStatus.PROVIDER_RESULT_STORED
                or record.provider_call_token != provider_call_token
                or record.completed_job is None
                or record.completed_job.fingerprint() != completed.fingerprint()
            ):
                raise ValueError("durable_translation_job_result_conflict")
            provider_called = True

    _require_job_identity(
        record,
        tenant_id=tenant_id,
        session_id=session_id,
        translation_id=translation_id,
    )
    _require_reservation_unchanged(
        record,
        reservation_fingerprint=reservation_fingerprint,
        reserved_at=reserved_at,
    )

    if record.status == DurableTranslationJobStatus.PROVIDER_CALL_STARTED:
        return _receipt(
            record,
            TranslationExecutionDisposition.PROVIDER_CALL_NOT_REPLAYED,
        )
    if record.status == DurableTranslationJobStatus.ATTEMPT_COMMITTED:
        return _receipt(record, TranslationExecutionDisposition.ALREADY_COMMITTED)
    if (
        record.status != DurableTranslationJobStatus.PROVIDER_RESULT_STORED
        or record.completed_job is None
    ):
        raise ValueError("durable_translation_job_state_conflict")

    await committer.commit_completed_translation_job(record.completed_job)
    completed_fingerprint = record.completed_job.fingerprint()
    committed = await store.mark_attempt_committed(
        tenant_id,
        session_id,
        translation_id,
        completed_job_fingerprint=completed_fingerprint,
    )
    _require_job_identity(
        committed,
        tenant_id=tenant_id,
        session_id=session_id,
        translation_id=translation_id,
    )
    _require_reservation_unchanged(
        committed,
        reservation_fingerprint=reservation_fingerprint,
        reserved_at=reserved_at,
    )
    if (
        committed.status != DurableTranslationJobStatus.ATTEMPT_COMMITTED
        or committed.completed_job is None
        or committed.completed_job.fingerprint() != completed_fingerprint
    ):
        raise ValueError("durable_translation_job_state_conflict")
    disposition = (
        TranslationExecutionDisposition.PROVIDER_RESULT_COMMITTED
        if provider_called
        else TranslationExecutionDisposition.STORED_RESULT_COMMITTED
    )
    return _receipt(committed, disposition)
