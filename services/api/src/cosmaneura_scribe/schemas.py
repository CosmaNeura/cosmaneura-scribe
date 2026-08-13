from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

ExternalEntityId = Annotated[str, Field(min_length=1, max_length=128)]


class CaptureModality(StrEnum):
    IN_PERSON = "in_person"
    VIRTUAL = "virtual"
    PHONE = "phone"


class ConsentMethod(StrEnum):
    PRE_VISIT_FORM = "pre_visit_form"
    VERBAL_ATTESTATION = "verbal_attestation"
    PHONE_IVR = "phone_ivr"


class ConsentCreate(BaseModel):
    appointment_id: ExternalEntityId
    practitioner_id: ExternalEntityId
    patient_id: ExternalEntityId
    modality: CaptureModality
    participant_regions: set[str] = Field(min_length=1)
    method: ConsentMethod
    all_parties_consented: bool
    granted_at: datetime
    evidence_object_id: UUID | None = None

    @model_validator(mode="after")
    def validate_granted_at(self) -> ConsentCreate:
        if self.granted_at.tzinfo is None or self.granted_at.utcoffset() is None:
            raise ValueError("granted_at must include a UTC offset")
        return self


class ConsentRecord(ConsentCreate):
    model_config = ConfigDict(frozen=True)

    id: UUID
    policy_version: str
    revoked_at: datetime | None = None


class SessionStatus(StrEnum):
    CREATED = "created"
    CAPTURING = "capturing"
    UPLOADED = "uploaded"
    PROCESSING = "processing"
    TRANSCRIPT_READY = "transcript_ready"
    HANDED_OFF = "handed_off"
    FAILED = "failed"


class SessionCreate(BaseModel):
    appointment_id: ExternalEntityId
    practitioner_id: ExternalEntityId
    patient_id: ExternalEntityId
    consent_record_id: UUID
    modality: CaptureModality


class CaptureSession(SessionCreate):
    model_config = ConfigDict(frozen=True)

    id: UUID
    status: SessionStatus
    created_at: datetime


class CaptureChannel(StrEnum):
    MICROPHONE = "microphone"
    SYSTEM_AUDIO = "system_audio"
    MIXED = "mixed"


class AudioChunkRegister(BaseModel):
    sequence_number: int = Field(ge=0)
    channel: CaptureChannel
    object_id: UUID
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    ciphertext_size_bytes: int = Field(gt=0, le=100_000_000)


class AudioChunk(AudioChunkRegister):
    model_config = ConfigDict(frozen=True)

    id: UUID
    session_id: UUID
    registered_at: datetime


class AudioUploadGrantRequest(BaseModel):
    sequence_number: int = Field(ge=0)
    channel: CaptureChannel


class AudioUploadGrant(BaseModel):
    model_config = ConfigDict(frozen=True)

    object_id: UUID
    session_id: UUID
    sequence_number: int
    channel: CaptureChannel
    upload_url: str = Field(repr=False)
    expires_at: datetime


class SpeakerRole(StrEnum):
    CLINICIAN = "clinician"
    PATIENT = "patient"
    OTHER = "other"
    UNKNOWN = "unknown"


class TranscriptSegment(BaseModel):
    speaker_id: str = Field(min_length=1, max_length=80)
    speaker_role: SpeakerRole
    content: str = Field(min_length=1)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def timestamps_are_ordered(self) -> TranscriptSegment:
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        return self


class TranscriptCreate(BaseModel):
    language_code: str = Field(default="en-US", min_length=2, max_length=16)
    stt_provider: str = Field(min_length=1, max_length=40)
    segments: list[TranscriptSegment] = Field(min_length=1)


class Transcript(TranscriptCreate):
    model_config = ConfigDict(frozen=True)

    id: UUID
    session_id: UUID
    created_at: datetime


class LegacyTranscriptEntry(BaseModel):
    speaker: str
    content: str
    startTime: int
    endTime: int


class LegacyTranscriptPayload(BaseModel):
    doctor_id: ExternalEntityId
    appointment_id: ExternalEntityId
    patient_id: ExternalEntityId
    duration: int
    transcript_data: list[LegacyTranscriptEntry]


class AuditEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    tenant_id: UUID
    action: str
    entity_type: str
    entity_id: UUID
    occurred_at: datetime
