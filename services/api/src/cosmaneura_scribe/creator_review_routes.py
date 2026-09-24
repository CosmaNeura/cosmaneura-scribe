"""Creator review receiver behind the existing trusted-platform service boundary.

Core/BFF must reauthorize the end user on every request and supply the creator
header itself. This is not a browser login endpoint or a new identity provider.
An explicitly bound runtime and cohort are required; normal startup stays dark.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SerializerFunctionWrapHandler, model_serializer

from .canonical_json import canonical_sha256
from .capture_continuity import CaptureContinuity
from .captured_source_runtime import CapturedSourceRepository, CapturedSourceRepositoryProvider
from .creator_review_contract_v1 import (
    CreatorTranslationDecisionRequestV1,
    CreatorTranslationProgressV1,
    CreatorTranslationReviewQueueV1,
    build_creator_translation_review_queue,
)
from .external_transcript_v1 import EnglishWorkingTranscriptV1, SourceTranscriptV1
from .repository import IdempotencyClaimUnavailableError, IdempotencyConflictError
from .service_auth import get_verified_tenant_id
from .transcript_constraints import MAX_TRANSCRIPT_SEGMENTS
from .translation_review_persistence import TranslationReviewPersistenceError

_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}
_OPERATION = "captured.translation.review"


class CreatorReviewViewV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    schema_version: Literal["1.0"] = "1.0"
    session_id: UUID = Field(repr=False)
    status: str
    source: SourceTranscriptV1 | None = Field(default=None, repr=False)
    working: EnglishWorkingTranscriptV1 | None = Field(default=None, repr=False)
    review_queue: CreatorTranslationReviewQueueV1 | None = Field(default=None, repr=False)
    translation_progress: tuple[CreatorTranslationProgressV1, ...] = Field(
        default=(), max_length=MAX_TRANSCRIPT_SEGMENTS, repr=False
    )
    capture_continuity: CaptureContinuity | None = None

    @model_serializer(mode="wrap")
    def compatible_continuity(self, handler: SerializerFunctionWrapHandler):
        result = handler(self)
        if self.capture_continuity is None:
            result.pop("capture_continuity", None)
        return result


class CreatorDecisionReceiptV1(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    schema_version: Literal["1.0"] = "1.0"
    session_id: UUID = Field(repr=False)
    review_id: UUID = Field(repr=False)
    saved: Literal[True] = True


class CreatorTranslationDecisionBodyV1(CreatorTranslationDecisionRequestV1):
    """JSON UUID/enum decoding at the transport edge; version numbers stay strict."""

    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True, strict=False)
    expected_source_transcript_version: int = Field(ge=1, strict=True, repr=False)
    expected_source_segment_version: int = Field(ge=1, strict=True, repr=False)
    expected_translation_version: int = Field(ge=1, strict=True, repr=False)


def _unavailable() -> HTTPException:
    return HTTPException(404, "Creator transcript is unavailable.", headers=_HEADERS)


def _conflict() -> HTTPException:
    return HTTPException(409, "Review changed. Reload before another decision.", headers=_HEADERS)


class CreatorReviewRuntime:
    """Explicit server binding; resources remain caller-owned, with no provider calls."""

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

    def authorize_cohort(self, tenant_id: UUID) -> None:
        if not self.enabled or tenant_id not in self.tenant_ids:
            raise _unavailable()

    async def _view(
        self, store: CapturedSourceRepository, tenant_id: UUID, session_id: UUID, actor: str
    ) -> CreatorReviewViewV1:
        session = await store.lock_live_capture(tenant_id, session_id)
        if session.creator_actor_id != actor:
            raise _unavailable()
        if session.current_source_transcript_version is None or session.status == "handed_off":
            state = session.status.value
            job = await store.transcription_job_for(tenant_id, session_id)
            if job is not None and session.current_source_transcript_version is None:
                state = {"terminal": "speech_failed", "retryable": "speech_retryable"}.get(
                    job.status.value, state
                )
            await store.audit(
                tenant_id=tenant_id,
                action="captured_review.status_read",
                entity_type="scribe_session",
                entity_id=session_id,
            )
            return CreatorReviewViewV1(session_id=session_id, status=state)
        current = await store.get_creator_working_transcript(
            tenant_id, session_id, creator_actor_id=actor
        )
        if current is None:
            raise _unavailable()
        return CreatorReviewViewV1(
            session_id=session_id,
            status=current.status.value,
            source=current.bundle.source_transcript,
            working=current.working_transcript,
            review_queue=build_creator_translation_review_queue(
                session_id=session_id, bundle=current.bundle
            ),
            translation_progress=await store.creator_translation_progress(
                tenant_id,
                session_id,
                creator_actor_id=actor,
                source_version=current.bundle.source_transcript.source_transcript_version,
            ),
            capture_continuity=await store.capture_continuity(tenant_id, session_id),
        )

    async def read(self, tenant_id: UUID, session_id: UUID, actor: str) -> CreatorReviewViewV1:
        self.authorize_cohort(tenant_id)
        try:
            async with self.repositories.transaction(tenant_id) as store:
                result = await self._view(store, tenant_id, session_id, actor)
            return result
        except Exception:
            pass
        raise _unavailable()

    async def decide(
        self,
        tenant_id: UUID,
        session_id: UUID,
        actor: str,
        key: str,
        request: CreatorTranslationDecisionRequestV1,
    ) -> CreatorDecisionReceiptV1:
        self.authorize_cohort(tenant_id)
        conflict = False
        try:
            async with self.repositories.transaction(tenant_id) as store:
                # Fresh consent/creator/retention checks also precede receipt recovery.
                current = await store.get_creator_working_transcript(
                    tenant_id, session_id, creator_actor_id=actor
                )
                if current is None:
                    raise _unavailable()
                review_id, reviewed_at = uuid4(), datetime.now(UTC)
                previous = await store.claim_idempotency(
                    tenant_id=tenant_id,
                    operation=_OPERATION,
                    key=key,
                    request_fingerprint=canonical_sha256(
                        {"session": session_id, "creator": actor, "request": request}
                    ),
                    entity_id=review_id,
                )
                if previous is not None:
                    existing = next(
                        (r for r in current.bundle.translation_reviews if r.review_id == previous),
                        None,
                    )
                    if existing is None:
                        raise IdempotencyConflictError()
                    review_id, reviewed_at = existing.review_id, existing.reviewed_at
                publication = await store.record_creator_translation_review_and_publish(
                    tenant_id,
                    session_id,
                    request.to_authorized_command(
                        review_id=review_id, reviewer_actor_id=actor, reviewed_at=reviewed_at
                    ),
                )
                if publication is None:
                    raise _unavailable()
                result = CreatorDecisionReceiptV1(session_id=session_id, review_id=review_id)
            return result
        except (
            IdempotencyConflictError,
            IdempotencyClaimUnavailableError,
            TranslationReviewPersistenceError,
        ):
            conflict = True
        except Exception:
            pass
        # Keep raw database errors and protected values out of exception chains.
        if conflict:
            raise _conflict()
        raise _unavailable()


def get_creator_review_runtime(request: Request) -> CreatorReviewRuntime:
    runtime = getattr(request.app.state, "creator_review_runtime", None)
    if not isinstance(runtime, CreatorReviewRuntime):
        raise _unavailable()
    return runtime


Tenant = Annotated[UUID, Depends(get_verified_tenant_id)]
Runtime = Annotated[CreatorReviewRuntime, Depends(get_creator_review_runtime)]
Creator = Annotated[
    str,
    Header(
        alias="X-Scribe-Creator-Actor-ID",
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        description="Creator reauthorized and asserted by the trusted platform, never the browser.",
    ),
]
Key = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=255)]
router = APIRouter(prefix="/v1/captured-sessions", tags=["creator-review"])


@router.get("/{session_id}/review", response_model=CreatorReviewViewV1)
async def read_creator_review(
    session_id: UUID, tenant_id: Tenant, actor: Creator, runtime: Runtime, response: Response
) -> CreatorReviewViewV1:
    response.headers.update(_HEADERS)
    return await runtime.read(tenant_id, session_id, actor)


@router.post("/{session_id}/review", response_model=CreatorDecisionReceiptV1)
async def decide_creator_review(
    session_id: UUID,
    payload: CreatorTranslationDecisionBodyV1,
    tenant_id: Tenant,
    actor: Creator,
    key: Key,
    runtime: Runtime,
    response: Response,
) -> CreatorDecisionReceiptV1:
    response.headers.update(_HEADERS)
    return await runtime.decide(
        tenant_id,
        session_id,
        actor,
        key,
        CreatorTranslationDecisionRequestV1.model_validate(payload.model_dump()),
    )
