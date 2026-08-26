from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException

from .canonical_json import canonical_sha256
from .consent import ConsentError, ConsentPolicy
from .repository import Repository as RepositoryContract
from .schemas import ConsentCreate, ConsentRecord
from .service_auth import get_verified_tenant_id

RepositoryDependency = Callable[..., AsyncIterator[RepositoryContract]]
IdempotentEntity = Callable[[RepositoryContract, UUID, str, str, str, UUID], Awaitable[UUID | None]]


def build_consent_router(
    *,
    repository_dependency: RepositoryDependency,
    policy_dependency: Callable[[], ConsentPolicy],
    idempotent_entity: IdempotentEntity,
) -> APIRouter:
    router = APIRouter()

    async def create_consent(
        payload: ConsentCreate,
        tenant_id: Annotated[UUID, Depends(get_verified_tenant_id)],
        idempotency_key: Annotated[
            str, Header(alias="Idempotency-Key", min_length=8, max_length=255)
        ],
        store: Annotated[RepositoryContract, Depends(repository_dependency)],
        policy: Annotated[ConsentPolicy, Depends(policy_dependency)],
    ) -> ConsentRecord:
        try:
            policy.validate_new_record(payload.all_parties_consented)
        except ConsentError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

        fingerprint = canonical_sha256(payload)
        record = ConsentRecord(id=uuid4(), policy_version=policy.version, **payload.model_dump())
        previous_id = await idempotent_entity(
            store, tenant_id, "consent.create", idempotency_key, fingerprint, record.id
        )
        if previous_id is not None:
            previous = await store.get_consent(tenant_id, previous_id)
            if previous is None:
                raise HTTPException(status_code=500, detail="Idempotent consent is unavailable.")
            return previous

        await store.add_consent(tenant_id, record)
        await store.audit(
            tenant_id=tenant_id,
            action="consent.recorded",
            entity_type="consent_record",
            entity_id=record.id,
        )
        return record

    async def revoke_consent(
        consent_id: UUID,
        tenant_id: Annotated[UUID, Depends(get_verified_tenant_id)],
        idempotency_key: Annotated[
            str, Header(alias="Idempotency-Key", min_length=8, max_length=255)
        ],
        store: Annotated[RepositoryContract, Depends(repository_dependency)],
    ) -> ConsentRecord:
        fingerprint = canonical_sha256({"consent_id": str(consent_id)})
        previous_id = await idempotent_entity(
            store,
            tenant_id,
            "consent.revoke",
            idempotency_key,
            fingerprint,
            consent_id,
        )
        if previous_id is not None:
            previous = await store.lock_consent(tenant_id, previous_id)
            if previous is None:
                raise HTTPException(status_code=404, detail="Consent record not found.")
            return previous

        result = await store.revoke_consent(tenant_id, consent_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Consent record not found.")
        if result.changed:
            await store.audit(
                tenant_id=tenant_id,
                action="consent.revoked",
                entity_type="consent_record",
                entity_id=consent_id,
            )
        return result.consent

    router.add_api_route(
        "/v1/consents",
        create_consent,
        methods=["POST"],
        response_model=ConsentRecord,
        status_code=201,
    )
    router.add_api_route(
        "/v1/consents/{consent_id}/revocations",
        revoke_consent,
        methods=["POST"],
        response_model=ConsentRecord,
    )
    return router
