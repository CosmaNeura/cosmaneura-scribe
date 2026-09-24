from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from .external_transcript_v1 import TranscriptLanguageMode
from .schemas import CaptureModality, ConsentRecord

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
    draft: VersionedExternalSessionCreate,
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
