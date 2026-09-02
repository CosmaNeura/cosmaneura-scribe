from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from .canonical_json import canonical_sha256
from .external_transcript_v1 import (
    NormalizedSourceTranscriptReceiptV1,
    NormalizedSourceTranscriptRequestV1,
    SourceLocale,
    TranscriptLanguageMode,
)
from .schemas import CaptureModality, ConsentRecord, SpeakerRole

VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT = "1.0"
VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID = "core_normalized_source_v1"
VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID = "external_transcript_micro_beta_v1"
VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID = "en_es_us_locale_normalization_v1"
_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class ConfiguredExternalSessionStatus(StrEnum):
    CREATED = "created"
    SOURCE_RECEIVED = "source_received"
    TRANSLATION_PENDING = "translation_pending"
    REVIEW_REQUIRED = "review_required"
    QUALITY_BLOCKED = "quality_blocked"
    TRANSCRIPT_READY = "transcript_ready"
    HANDED_OFF = "handed_off"
    FAILED = "failed"


class NormalizedSourceAcceptanceDisposition(StrEnum):
    ACCEPTED = "accepted"
    CORRECTED = "corrected"
    REPLAYED = "replayed"
    CONVERGED = "converged"


class NormalizedSourcePersistenceCode(StrEnum):
    CONSENT_INVALID = "source_consent_invalid"
    IDEMPOTENCY_CONFLICT = "source_idempotency_conflict"
    LANGUAGE_MODE_CONFLICT = "source_language_mode_conflict"
    RETENTION_EXPIRED = "source_retention_expired"
    STATE_CONFLICT = "source_state_conflict"


class NormalizedSourcePersistenceError(RuntimeError):
    """Bounded failure that never includes protected request or entity values."""

    def __init__(self, code: NormalizedSourcePersistenceCode) -> None:
        self.code = code
        super().__init__(code.value)

    def __repr__(self) -> str:
        return f"NormalizedSourcePersistenceError({self.code.value!r})"


def _validate_external_id(name: str, value: str) -> None:
    if not 1 <= len(value) <= 128:
        raise ValueError(f"{name} must contain between 1 and 128 characters")


def _validate_safe_identifier(name: str, value: str) -> None:
    if _SAFE_IDENTIFIER.fullmatch(value) is None:
        raise ValueError(f"{name} is not a safe versioned identifier")


@dataclass(frozen=True, repr=False)
class VersionedExternalSessionCreate:
    """Internal Core-authorized fields; every value is protected metadata."""

    id: UUID
    appointment_id: str
    practitioner_id: str
    patient_id: str
    consent_record_id: UUID
    modality: CaptureModality
    creator_actor_id: str
    language_mode: TranscriptLanguageMode

    def __post_init__(self) -> None:
        for name in ("appointment_id", "practitioner_id", "patient_id"):
            _validate_external_id(name, getattr(self, name))
        _validate_safe_identifier("creator_actor_id", self.creator_actor_id)

    def __repr__(self) -> str:
        return "VersionedExternalSessionCreate(<protected>)"


@dataclass(frozen=True, repr=False)
class VersionedExternalSessionRecord:
    """Internal configured-session record that is never a public response model."""

    id: UUID
    appointment_id: str
    practitioner_id: str
    patient_id: str
    consent_record_id: UUID
    modality: CaptureModality
    creator_actor_id: str
    language_mode: TranscriptLanguageMode
    transcript_contract_version: str
    transcription_adapter_id: str
    transcription_model_profile_id: str
    normalization_profile_id: str
    status: ConfiguredExternalSessionStatus
    created_at: datetime
    source_received_at: datetime | None = None
    transcript_content_expires_at: datetime | None = None
    content_purged_at: datetime | None = None
    current_source_transcript_version: int | None = None

    def __post_init__(self) -> None:
        for name in ("appointment_id", "practitioner_id", "patient_id"):
            _validate_external_id(name, getattr(self, name))
        for name in (
            "creator_actor_id",
            "transcription_adapter_id",
            "transcription_model_profile_id",
            "normalization_profile_id",
        ):
            _validate_safe_identifier(name, getattr(self, name))
        if self.transcript_contract_version != VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT:
            raise ValueError("unsupported versioned external transcript contract")
        if self.created_at.tzinfo is None or self.created_at.utcoffset() is None:
            raise ValueError("created_at must include a UTC offset")
        for name in (
            "source_received_at",
            "transcript_content_expires_at",
            "content_purged_at",
        ):
            value = getattr(self, name)
            if value is not None and (value.tzinfo is None or value.utcoffset() is None):
                raise ValueError(f"{name} must include a UTC offset")

    def __repr__(self) -> str:
        return "VersionedExternalSessionRecord(<protected>)"


def build_versioned_external_session_record(
    draft: VersionedExternalSessionCreate,
    *,
    created_at: datetime,
) -> VersionedExternalSessionRecord:
    return VersionedExternalSessionRecord(
        id=draft.id,
        appointment_id=draft.appointment_id,
        practitioner_id=draft.practitioner_id,
        patient_id=draft.patient_id,
        consent_record_id=draft.consent_record_id,
        modality=draft.modality,
        creator_actor_id=draft.creator_actor_id,
        language_mode=draft.language_mode,
        transcript_contract_version=VERSIONED_EXTERNAL_TRANSCRIPT_CONTRACT,
        transcription_adapter_id=VERSIONED_EXTERNAL_TRANSCRIPTION_ADAPTER_ID,
        transcription_model_profile_id=VERSIONED_EXTERNAL_TRANSCRIPTION_MODEL_PROFILE_ID,
        normalization_profile_id=VERSIONED_EXTERNAL_NORMALIZATION_PROFILE_ID,
        status=ConfiguredExternalSessionStatus.CREATED,
        created_at=created_at,
    )


def consent_authorizes_versioned_session(
    consent: ConsentRecord | None,
    draft: VersionedExternalSessionCreate | VersionedExternalSessionRecord,
) -> bool:
    return bool(
        consent is not None
        and consent.all_parties_consented
        and consent.revoked_at is None
        and consent.appointment_id == draft.appointment_id
        and consent.practitioner_id == draft.practitioner_id
        and consent.patient_id == draft.patient_id
        and consent.modality == draft.modality
    )


@dataclass(frozen=True, repr=False)
class NormalizedSourceSegmentRecord:
    source_segment_id: UUID
    source_segment_version: int
    ordinal: int
    source_locale: SourceLocale
    speaker_id: UUID
    speaker_role: SpeakerRole
    content: str = field(repr=False)
    start_ms: int
    end_ms: int
    locale_confidence: float | None

    def __repr__(self) -> str:
        return "NormalizedSourceSegmentRecord(<protected>)"


@dataclass(frozen=True, repr=False)
class NormalizedSourceTranscriptRecord:
    session_id: UUID
    source_transcript_version: int
    source_receipt_id: UUID
    schema_version: str
    language_mode: TranscriptLanguageMode
    transcription_adapter_id: str
    transcription_model_profile_id: str
    normalization_profile_id: str
    duration_ms: int
    request_fingerprint: str = field(repr=False)
    received_at: datetime
    transcript_content_expires_at: datetime
    segments: tuple[NormalizedSourceSegmentRecord, ...] = field(repr=False)

    @property
    def receipt(self) -> NormalizedSourceTranscriptReceiptV1:
        return NormalizedSourceTranscriptReceiptV1(
            schema_version="1.0",
            session_id=self.session_id,
            source_receipt_id=self.source_receipt_id,
            source_transcript_version=self.source_transcript_version,
            receipt_state="source_received",
            received_at=self.received_at,
            transcript_content_expires_at=self.transcript_content_expires_at,
        )

    def __repr__(self) -> str:
        return "NormalizedSourceTranscriptRecord(<protected>)"


@dataclass(frozen=True, repr=False)
class NormalizedSourceReceiptKeyRecord:
    idempotency_key: str = field(repr=False)
    source_transcript_version: int
    request_fingerprint: str = field(repr=False)

    def __repr__(self) -> str:
        return "NormalizedSourceReceiptKeyRecord(<protected>)"


@dataclass(frozen=True, repr=False)
class NormalizedSourceAcceptance:
    receipt: NormalizedSourceTranscriptReceiptV1 = field(repr=False)
    disposition: NormalizedSourceAcceptanceDisposition

    @property
    def receipt_body(self) -> bytes:
        return self.receipt.canonical_body()

    def __repr__(self) -> str:
        return f"NormalizedSourceAcceptance(disposition={self.disposition.value!r})"


def normalized_source_request_fingerprint(
    session: VersionedExternalSessionRecord,
    request: NormalizedSourceTranscriptRequestV1,
) -> str:
    return canonical_sha256(
        {
            "contract": "normalized-source-transcript-request-v1",
            "schema_version": request.schema_version,
            "language_mode": session.language_mode,
            "transcription_adapter_id": session.transcription_adapter_id,
            "transcription_model_profile_id": session.transcription_model_profile_id,
            "normalization_profile_id": session.normalization_profile_id,
            "duration_ms": request.duration_ms,
            "segments": request.segments,
        }
    )


def validate_normalized_source_request_for_session(
    session: VersionedExternalSessionRecord,
    request: NormalizedSourceTranscriptRequestV1,
) -> None:
    if session.language_mode == TranscriptLanguageMode.ENGLISH and any(
        segment.source_locale == SourceLocale.SPANISH_US for segment in request.segments
    ):
        raise NormalizedSourcePersistenceError(
            NormalizedSourcePersistenceCode.LANGUAGE_MODE_CONFLICT
        )
