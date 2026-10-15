"""Dormant Core-authorized configured admission; existing consent and identity gates."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from .canonical_json import canonical_sha256
from .captured_source_runtime import CapturedSourceRepositoryProvider
from .creator_preparation_routes import (
    Configuration,
    CreatorPreparationMetadata,
    Keys,
    read_creator_preparation_metadata,
)
from .creator_review_routes import Creator, Key, Tenant
from .creator_review_routes import Runtime as ReviewRuntime
from .external_transcript_v1 import TranscriptLanguageMode
from .normalized_source_persistence import CapturedSessionCreate
from .repository import IdempotencyClaimUnavailableError, IdempotencyConflictError
from .schemas import CaptureModality

_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


class CapturedAdmissionRequestV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    schema_version: Literal["1.0"]
    id: UUID = Field(repr=False)
    appointment_id: str = Field(min_length=1, max_length=128, repr=False)
    practitioner_id: str = Field(min_length=1, max_length=128, repr=False)
    patient_id: str = Field(min_length=1, max_length=128, repr=False)
    consent_record_id: UUID = Field(repr=False)
    modality: CaptureModality
    language_mode: TranscriptLanguageMode

    def draft(self, creator: str) -> CapturedSessionCreate:
        return CapturedSessionCreate(
            id=self.id,
            appointment_id=self.appointment_id,
            practitioner_id=self.practitioner_id,
            patient_id=self.patient_id,
            consent_record_id=self.consent_record_id,
            modality=self.modality,
            language_mode=self.language_mode,
            creator_actor_id=creator,
        )


class CapturedAdmissionReceiptV1(CapturedAdmissionRequestV1):
    """Immutable admission metadata; never permission to start or resume capture."""

    creator_actor_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", repr=False)
    ingest_mode: Literal["chunk_upload"] = "chunk_upload"
    transcript_contract_version: Literal["1.0"] = "1.0"
    transcription_adapter_id: Literal["azure_ai_speech"] = "azure_ai_speech"
    transcription_model_profile_id: Literal["azure_fast_transcription_en_es_v1"] = (
        "azure_fast_transcription_en_es_v1"
    )
    normalization_profile_id: Literal["azure_phrase_en_es_evidence_v1"] = (
        "azure_phrase_en_es_evidence_v1"
    )
    status: Literal["admitted"] = "admitted"
    created_at: AwareDatetime


class PreparedCapturedAdmissionReceiptV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    schema_version: Literal["1.0"] = "1.0"
    admission: CapturedAdmissionReceiptV1
    preparation_metadata: CreatorPreparationMetadata


class CapturedAdmissionRuntime:
    def __init__(
        self,
        repositories: CapturedSourceRepositoryProvider,
        *,
        tenant_ids: frozenset[UUID],
        enabled: bool = False,
    ) -> None:
        self.repositories = repositories
        self.tenant_ids = frozenset(tenant_ids)
        self.enabled = enabled is True

    async def admit(
        self,
        tenant: UUID,
        actor: str,
        key: str,
        request: CapturedAdmissionRequestV1,
    ) -> CapturedAdmissionReceiptV1:
        if not self.enabled or tenant not in self.tenant_ids:
            raise HTTPException(404, "Configured capture is unavailable.", headers=_HEADERS)
        conflict = False
        try:
            async with self.repositories.transaction(tenant) as store:
                previous = await store.claim_idempotency(
                    tenant_id=tenant,
                    operation="captured.session.admit",
                    key=key,
                    request_fingerprint=canonical_sha256({"creator": actor, "request": request}),
                    entity_id=request.id,
                )
                if previous is not None and previous != request.id:
                    raise IdempotencyConflictError()
                # Same repository primitive as CapturedSourceRuntime.admit. It
                # locks/rechecks consent and rejects any identity/config change,
                # including on exact replay. The claim commits atomically with it.
                session = await store.admit_capture(tenant, request.draft(actor))
                receipt = CapturedAdmissionReceiptV1.model_validate(
                    {
                        **request.model_dump(),
                        "creator_actor_id": session.creator_actor_id,
                        "created_at": session.created_at,
                        "ingest_mode": session.ingest_mode.value,
                        "transcript_contract_version": session.transcript_contract_version,
                        "transcription_adapter_id": session.transcription_adapter_id,
                        "transcription_model_profile_id": session.transcription_model_profile_id,
                        "normalization_profile_id": session.normalization_profile_id,
                    }
                )
            return receipt
        except (IdempotencyConflictError, IdempotencyClaimUnavailableError):
            conflict = True
        except Exception:
            pass
        if conflict:
            raise HTTPException(409, "Configured admission request changed.", headers=_HEADERS)
        raise HTTPException(404, "Configured capture is unavailable.", headers=_HEADERS)


def get_captured_admission_runtime(request: Request) -> CapturedAdmissionRuntime:
    runtime = getattr(request.app.state, "captured_admission_runtime", None)
    if not isinstance(runtime, CapturedAdmissionRuntime):
        raise HTTPException(404, "Configured capture is unavailable.", headers=_HEADERS)
    return runtime


router = APIRouter(prefix="/v1/captured-sessions", tags=["configured-capture"])
Runtime = Annotated[CapturedAdmissionRuntime, Depends(get_captured_admission_runtime)]


@router.post("", response_model=CapturedAdmissionReceiptV1, status_code=201)
async def admit_captured_session(
    payload: CapturedAdmissionRequestV1,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
    response: Response,
) -> CapturedAdmissionReceiptV1:
    response.headers.update(_HEADERS)
    return await runtime.admit(tenant_id, actor, key, payload)


@router.post("/prepared", response_model=PreparedCapturedAdmissionReceiptV1, status_code=201)
async def admit_prepared_captured_session(
    payload: CapturedAdmissionRequestV1,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
    review_runtime: ReviewRuntime,
    settings: Configuration,
    provider: Keys,
    response: Response,
) -> PreparedCapturedAdmissionReceiptV1:
    # The original session key/fingerprint is unchanged across both endpoints.
    # Admission may commit before metadata fails. Never publish that partial
    # result or replace its family; exact replay rechecks consent and creator.
    response.headers.update(_HEADERS)
    try:
        receipt = await runtime.admit(tenant_id, actor, key, payload)
    except BaseException:
        await provider.close()
        raise
    metadata = await read_creator_preparation_metadata(
        receipt.id, tenant_id, actor, review_runtime, settings, provider, response
    )
    return PreparedCapturedAdmissionReceiptV1(admission=receipt, preparation_metadata=metadata)
