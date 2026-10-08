"""Current creator/consent metadata in one bounded, read-only workflow request."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict

from .audio_keys import (
    AudioEncryptionKeyProvider,
    AudioEncryptionKeyUnavailable,
    build_audio_encryption_key_provider,
)
from .creator_review_routes import Creator, CreatorReviewViewV1, Runtime, Tenant
from .schemas import AudioEncryptionPublicKey, CaptureCapabilities
from .settings import Settings, get_settings

router = APIRouter(prefix="/v1/captured-sessions", tags=["configured-capture"])
Configuration = Annotated[Settings, Depends(get_settings)]


def preparation_keys() -> AudioEncryptionKeyProvider:
    # This route closes its provider before final publication. It must never
    # borrow the application's cached provider used by later key binding.
    return build_audio_encryption_key_provider(get_settings())


Keys = Annotated[AudioEncryptionKeyProvider, Depends(preparation_keys)]


def unavailable() -> HTTPException:
    return HTTPException(
        404,
        "Creator preparation is unavailable.",
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


class CreatorPreparationMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)
    schema_version: Literal["1.0"] = "1.0"
    review: CreatorReviewViewV1
    encryption_key: AudioEncryptionPublicKey
    capabilities: CaptureCapabilities


@router.get("/{session_id}/preparation-metadata", response_model=CreatorPreparationMetadata)
async def read_creator_preparation_metadata(
    session_id: UUID,
    tenant_id: Tenant,
    actor: Creator,
    runtime: Runtime,
    settings: Configuration,
    provider: Keys,
    response: Response,
) -> CreatorPreparationMetadata:
    from .main import (
        capture_capabilities_from_usage,
        capture_context_for_creator,
        get_consent_policy,
        require_capture_protocol,
    )

    # Authorize before key-provider I/O. Its public key grants no capture access.
    # Close the transaction before that await; then recheck current creator,
    # consent and capability usage in the final publication transaction.
    try:
        require_capture_protocol(settings)
        runtime.authorize_cohort(tenant_id)
        try:
            async with runtime.repositories.transaction(tenant_id) as store:
                session = await store.lock_live_capture(tenant_id, session_id)
                if session.creator_actor_id != actor:
                    raise unavailable()
        except Exception:
            raise unavailable() from None
        key = await provider.get_public_key()
    except AudioEncryptionKeyUnavailable:
        raise HTTPException(503, "Audio encryption key is unavailable.") from None
    finally:
        await provider.close()
    runtime.authorize_cohort(tenant_id)
    try:
        async with runtime.repositories.transaction(tenant_id) as store:
            review = await runtime.read_in_transaction(store, tenant_id, session_id, actor)
            await capture_context_for_creator(
                store, tenant_id, session_id, get_consent_policy(), require_audio_key=False
            )
            usage = await store.capture_reservation_usage(tenant_id, session_id)
            result = CreatorPreparationMetadata(
                review=review,
                encryption_key=key,
                capabilities=capture_capabilities_from_usage(
                    usage.plaintext_budget_bytes, settings
                ),
            )
            runtime.authorize_cohort(tenant_id)
    except Exception:
        raise unavailable() from None
    response.headers.update({"Cache-Control": "no-store", "Pragma": "no-cache"})
    return result
