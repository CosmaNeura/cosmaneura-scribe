"""Creator-checked preparation using the existing capture transactions and receipts."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from .creator_review_routes import Creator, Key, Runtime, Tenant
from .schemas import (
    CaptureLeaseIssueRequest,
    CaptureLeaseReceipt,
    CaptureLeaseRenewRequest,
    ChunkReservationBatchReceipt,
    ChunkReservationBatchRequest,
)
from .settings import Settings, get_settings

router = APIRouter(prefix="/v1/captured-sessions", tags=["configured-capture"])
Configuration = Annotated[Settings, Depends(get_settings)]
_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


@router.post("/{session_id}/capture-lease", response_model=CaptureLeaseReceipt, status_code=201)
async def issue_creator_capture_lease(
    session_id: UUID,
    payload: CaptureLeaseIssueRequest,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
    settings: Configuration,
    response: Response,
) -> CaptureLeaseReceipt:
    from .main import execute_capture_lease_issue, get_consent_policy

    runtime.authorize_cohort(tenant_id)
    response.headers.update(_HEADERS)
    return await execute_capture_lease_issue(
        session_id,
        payload,
        tenant_id,
        key,
        runtime.repositories,
        get_consent_policy(),
        settings,
        creator_actor_id=actor,
    )


@router.post("/{session_id}/capture-leases/{lease_id}/renew", response_model=CaptureLeaseReceipt)
async def renew_creator_capture_lease(
    session_id: UUID,
    lease_id: UUID,
    payload: CaptureLeaseRenewRequest,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
    settings: Configuration,
    response: Response,
) -> CaptureLeaseReceipt:
    from .main import execute_capture_lease_renewal, get_consent_policy

    runtime.authorize_cohort(tenant_id)
    response.headers.update(_HEADERS)
    return await execute_capture_lease_renewal(
        session_id,
        lease_id,
        payload,
        tenant_id,
        key,
        runtime.repositories,
        get_consent_policy(),
        settings,
        creator_actor_id=actor,
    )


@router.post(
    "/{session_id}/chunk-reservations", response_model=ChunkReservationBatchReceipt, status_code=201
)
async def reserve_creator_audio_chunks(
    session_id: UUID,
    payload: ChunkReservationBatchRequest,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
    settings: Configuration,
    response: Response,
) -> ChunkReservationBatchReceipt:
    from .main import execute_chunk_reservation, get_consent_policy

    runtime.authorize_cohort(tenant_id)
    response.headers.update(_HEADERS)
    return await execute_chunk_reservation(
        session_id,
        payload,
        tenant_id,
        key,
        runtime.repositories,
        get_consent_policy(),
        settings,
        creator_actor_id=actor,
    )
