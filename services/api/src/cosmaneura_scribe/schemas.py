from __future__ import annotations

import base64
import binascii
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)

from .capture_protocol_v1 import (
    MAX_CHUNKS,
    MAX_ENVELOPE_BYTES,
    MAX_RESERVATIONS_PER_BATCH,
    PROTOCOL_VERSION,
    CaptureChannel,
    ProtocolVersion,
)
from .session_state_v1 import SessionIngestMode, SessionStatus
from .transcript_constraints import (
    MAX_TRANSCRIPT_CONTENT_CHARS,
    MAX_TRANSCRIPT_DURATION_MS,
    MAX_TRANSCRIPT_SEGMENTS,
    validate_transcript_segments,
)

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
    participant_regions: set[str] = Field(
        min_length=1,
        json_schema_extra={"minItems": 1, "uniqueItems": True},
    )
    method: ConsentMethod
    all_parties_consented: bool
    granted_at: datetime
    evidence_object_id: UUID | None = None

    @field_serializer("participant_regions")
    def serialize_participant_regions(self, regions: set[str]) -> list[str]:
        return sorted(regions)

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


class SessionCreate(BaseModel):
    appointment_id: ExternalEntityId
    practitioner_id: ExternalEntityId
    patient_id: ExternalEntityId
    consent_record_id: UUID
    modality: CaptureModality
    ingest_mode: SessionIngestMode = SessionIngestMode.CHUNK_UPLOAD


class CaptureSession(SessionCreate):
    model_config = ConfigDict(frozen=True)

    id: UUID
    status: SessionStatus
    created_at: datetime


class CaptureMediaCapabilities(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    media_type: Literal["audio/wav"]
    encoding: Literal["pcm_s16le"]
    channels: Literal[1]
    sample_rate_hz: Literal[16000]


class CaptureCapabilities(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    protocol_version: ProtocolVersion
    media: CaptureMediaCapabilities
    target_chunk_duration_ms: int = Field(gt=0)
    max_envelope_bytes: int = Field(gt=0)
    max_chunks: int = Field(gt=0)
    remaining_aggregate_plaintext_bytes: int = Field(ge=0)
    capture_lease_ttl_seconds: int = Field(gt=0)
    reservation_window_seconds: int = Field(gt=0)
    max_reservations_per_batch: int = Field(gt=0)
    upload_concurrency: int = Field(gt=0)


class CaptureLeaseIssueRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol_version: ProtocolVersion = PROTOCOL_VERSION


class CaptureLeaseRenewRequest(CaptureLeaseIssueRequest):
    expected_generation: int = Field(ge=1)


class CaptureLeaseReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    protocol_version: ProtocolVersion
    receipt_id: UUID
    lease_id: UUID
    session_id: UUID
    generation: int = Field(ge=1)
    issued_at: datetime
    expires_at: datetime


class ChunkReservationBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol_version: ProtocolVersion = PROTOCOL_VERSION
    capture_lease_id: UUID
    capture_lease_generation: int = Field(ge=1)
    channel: CaptureChannel
    first_sequence_number: int = Field(ge=0, lt=MAX_CHUNKS)
    count: int = Field(ge=1, le=MAX_RESERVATIONS_PER_BATCH)


class ChunkReservation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    protocol_version: ProtocolVersion
    object_id: UUID
    session_id: UUID
    channel: CaptureChannel
    sequence_number: int = Field(ge=0)
    additional_authenticated_data: str = Field(
        pattern=r"^[A-Za-z0-9_-]+$",
        repr=False,
    )
    created_at: datetime


class ChunkReservationBatchReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    protocol_version: ProtocolVersion
    batch_id: UUID
    session_id: UUID
    capture_authorized_until: datetime
    reservations: tuple[ChunkReservation, ...] = Field(min_length=1)


class ChunkUploadAuthorizationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol_version: ProtocolVersion = PROTOCOL_VERSION


class ChunkUploadAuthorization(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    protocol_version: ProtocolVersion
    authorization_receipt_id: UUID
    object_id: UUID
    additional_authenticated_data: str = Field(
        pattern=r"^[A-Za-z0-9_-]+$",
        repr=False,
    )
    upload_url: str = Field(repr=False)
    expires_at: datetime


class ChunkRegistrationMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    chunk_id: UUID
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$", repr=False)
    ciphertext_size_bytes: int = Field(gt=0, le=MAX_ENVELOPE_BYTES)
    registered_at: datetime


class ChunkReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    reservation: ChunkReservation
    state: Literal["reserved", "registered"]
    registration: ChunkRegistrationMetadata | None = None


class CaptureChannelCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    channel: CaptureChannel
    final_sequence_number: int = Field(ge=0, lt=MAX_CHUNKS)


class CaptureCompleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol_version: ProtocolVersion = PROTOCOL_VERSION
    capture_lease_id: UUID
    capture_lease_generation: int = Field(ge=1)
    channels: tuple[CaptureChannelCompletion, ...] = Field(min_length=1, max_length=3)

    @field_validator("channels")
    @classmethod
    def channels_are_unique(
        cls,
        value: tuple[CaptureChannelCompletion, ...],
    ) -> tuple[CaptureChannelCompletion, ...]:
        if len({item.channel for item in value}) != len(value):
            raise ValueError("capture completion channels must be unique")
        return value


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


class RsaPublicJwk(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    kty: Literal["RSA"] = "RSA"
    n: str = Field(pattern=r"^[A-Za-z0-9_-]+$", min_length=512, max_length=512)
    e: str = Field(pattern=r"^[A-Za-z0-9_-]+$", min_length=1, max_length=16)
    alg: Literal["RSA-OAEP-256"] = "RSA-OAEP-256"
    ext: Literal[True] = True
    key_ops: tuple[Literal["wrapKey"], ...] = ("wrapKey",)

    @field_validator("n")
    @classmethod
    def modulus_is_rsa_3072(cls, value: str) -> str:
        try:
            decoded = base64.b64decode(
                value + "=" * (-len(value) % 4),
                altchars=b"-_",
                validate=True,
            )
        except binascii.Error:
            raise ValueError("n must be unpadded base64url") from None
        if len(decoded) != 384:
            raise ValueError("n must contain one RSA-3072 modulus")
        return value


class AudioEncryptionPublicKey(BaseModel):
    model_config = ConfigDict(frozen=True)

    key_version: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    algorithm: Literal["RSA-OAEP-256"] = "RSA-OAEP-256"
    public_jwk: RsaPublicJwk


class SessionAudioKeyCreate(BaseModel):
    key_version: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    wrapped_dek: str = Field(
        pattern=r"^[A-Za-z0-9_-]+$",
        min_length=512,
        max_length=512,
        repr=False,
    )

    @field_validator("wrapped_dek")
    @classmethod
    def wrapped_dek_is_valid_base64url(cls, value: str) -> str:
        try:
            decoded = base64.b64decode(
                value + "=" * (-len(value) % 4),
                altchars=b"-_",
                validate=True,
            )
        except binascii.Error:
            raise ValueError("wrapped_dek must be unpadded base64url") from None
        if len(decoded) != 384:
            raise ValueError("wrapped_dek must contain one RSA-3072 wrapped key")
        return value


class SessionAudioKey(SessionAudioKeyCreate):
    model_config = ConfigDict(frozen=True)

    session_id: UUID
    created_at: datetime


class SessionAudioKeyReceipt(BaseModel):
    model_config = ConfigDict(frozen=True)

    session_id: UUID
    key_version: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    created_at: datetime


class SpeakerRole(StrEnum):
    CLINICIAN = "clinician"
    PATIENT = "patient"
    OTHER = "other"
    UNKNOWN = "unknown"


class TimedTranscriptSegment(BaseModel):
    content: str = Field(min_length=1, max_length=MAX_TRANSCRIPT_CONTENT_CHARS)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)

    @model_validator(mode="after")
    def timestamps_are_ordered(self) -> TimedTranscriptSegment:
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        return self


class TranscriptSegment(TimedTranscriptSegment):
    speaker_id: str = Field(min_length=1, max_length=80)
    speaker_role: SpeakerRole
    confidence: float | None = Field(default=None, ge=0, le=1)


class TranscriptCreate(BaseModel):
    language_code: str = Field(default="en-US", min_length=2, max_length=16)
    stt_provider: str = Field(min_length=1, max_length=40)
    segments: list[TranscriptSegment] = Field(
        min_length=1,
        max_length=MAX_TRANSCRIPT_SEGMENTS,
    )

    @model_validator(mode="after")
    def validate_segment_sequence(self) -> TranscriptCreate:
        validate_transcript_segments(self.segments)
        return self


class Transcript(TranscriptCreate):
    model_config = ConfigDict(frozen=True)

    id: UUID
    session_id: UUID
    created_at: datetime


class TranscriptionJobStatus(StrEnum):
    PROCESSING = "processing"
    RETRYABLE = "retryable"
    COMPLETED = "completed"
    TERMINAL = "terminal"


class TranscriptionJob(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    session_id: UUID
    status: TranscriptionJobStatus
    attempt_count: int = Field(ge=1)
    lease_token: UUID | None = Field(default=None, repr=False)
    lease_until: datetime | None = None
    last_error_code: str | None = Field(default=None, max_length=64)
    created_at: datetime
    updated_at: datetime


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


class MasterTranscriptSegment(TimedTranscriptSegment):
    speaker: Literal["Doctor", "Patient", "Other", "Unknown"]


class MasterTranscriptDeliveryRequest(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    encounter_id: ExternalEntityId
    scribe_session_id: UUID
    duration_seconds: int = Field(ge=0, le=MAX_TRANSCRIPT_DURATION_MS // 1000)
    segments: list[MasterTranscriptSegment] = Field(
        min_length=1,
        max_length=MAX_TRANSCRIPT_SEGMENTS,
    )

    @model_validator(mode="after")
    def segments_are_ordered(self) -> MasterTranscriptDeliveryRequest:
        validate_transcript_segments(
            self.segments,
            duration_ms=self.duration_seconds * 1000,
        )
        return self


class MasterTranscriptDeliveryResponse(BaseModel):
    schema_version: Literal["1.0"]
    transcript_id: ExternalEntityId
    disposition: Literal["created", "replayed"]


class DeliveryStatus(StrEnum):
    PENDING = "pending"
    RETRYABLE = "retryable"
    DELIVERED = "delivered"
    TERMINAL = "terminal"


class DeliverySessionSource(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    appointment_id: ExternalEntityId
    practitioner_id: ExternalEntityId
    patient_id: ExternalEntityId
    consent_record_id: UUID
    modality: CaptureModality
    status: SessionStatus


class DeliveryConsentSource(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    appointment_id: ExternalEntityId
    practitioner_id: ExternalEntityId
    patient_id: ExternalEntityId
    modality: CaptureModality
    all_parties_consented: bool
    revoked_at: datetime | None = None


class DeliveryTranscriptSource(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    session_id: UUID
    segments: list[TranscriptSegment] = Field(
        min_length=1,
        max_length=MAX_TRANSCRIPT_SEGMENTS,
        repr=False,
    )


class DeliveryPayloadSource(BaseModel):
    model_config = ConfigDict(frozen=True)

    session: DeliverySessionSource | None = None
    consent: DeliveryConsentSource | None = None
    transcript: DeliveryTranscriptSource | None = None


class DeliveryAttempt(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    session_id: UUID
    idempotency_key: str = Field(min_length=8, max_length=255)
    payload_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    status: DeliveryStatus
    attempt_count: int = Field(ge=0)
    platform_transcript_id: ExternalEntityId | None = None
    last_error_code: str | None = Field(default=None, max_length=64)
    updated_at: datetime


class TranscriptDelivery(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    session_id: UUID
    idempotency_key: str = Field(min_length=8, max_length=255)
    payload_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    status: DeliveryStatus
    attempt_count: int = Field(ge=0)
    platform_transcript_id: ExternalEntityId | None = None
    last_error_code: str | None = Field(default=None, max_length=64)
    created_at: datetime
    updated_at: datetime


class AuditEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    tenant_id: UUID
    action: str
    entity_type: str
    entity_id: UUID
    occurred_at: datetime


class TokenDiagnostics(BaseModel):
    model_config = ConfigDict(frozen=True)

    signature_valid: bool
    lifetime_valid: bool
    token_version_v2: bool
    issuer_valid: bool
    audience_valid: bool
    tenant_valid: bool
    idtyp_app: bool
    azp_valid: bool
    role_present: bool
