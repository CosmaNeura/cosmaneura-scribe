"""Default-off application boundary for persisted, creator-only bilingual review.

Callers supply freshly verified tenant/actor context, not user request-body
authority. This does not authenticate a user or register a public API route.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from .creator_review_contract_v1 import (
    CreatorTranslationDecisionRequestV1,
    CreatorTranslationReviewQueueV1,
    build_creator_translation_review_queue,
)
from .derived_writer_transactions import commit_creator_translation_review_and_publish
from .repository import RepositoryProvider
from .translation_review_persistence import TranslationReviewPublication
from .working_transcript_persistence import WorkingTranscriptDerivation


class TranscriptReviewUnavailable(RuntimeError):
    """A fixed-code failure without protected database, transcript or actor values."""

    def __init__(self) -> None:
        super().__init__("transcript_review_unavailable")


class CreatorTranscriptReviewService:
    def __init__(self, repositories: RepositoryProvider, *, enabled: bool = False) -> None:
        self._repositories = repositories
        self._enabled = enabled is True

    def _require_enabled(self) -> None:
        if not self._enabled:
            raise TranscriptReviewUnavailable()

    async def read(
        self, *, tenant_id: UUID, session_id: UUID, creator_actor_id: str
    ) -> WorkingTranscriptDerivation:
        self._require_enabled()
        try:
            async with self._repositories.transaction(tenant_id) as repository:
                result = await repository.get_creator_working_transcript(
                    tenant_id,
                    session_id,
                    creator_actor_id=creator_actor_id,
                )
            if result is not None:
                return result
        except Exception:
            pass
        # Outside the handler: even __context__ must not retain driver values.
        raise TranscriptReviewUnavailable()

    async def review_queue(
        self, *, tenant_id: UUID, session_id: UUID, creator_actor_id: str
    ) -> CreatorTranslationReviewQueueV1:
        current = await self.read(
            tenant_id=tenant_id,
            session_id=session_id,
            creator_actor_id=creator_actor_id,
        )
        try:
            return build_creator_translation_review_queue(
                session_id=session_id, bundle=current.bundle
            )
        except Exception:
            pass
        raise TranscriptReviewUnavailable()

    async def decide(
        self,
        *,
        tenant_id: UUID,
        session_id: UUID,
        creator_actor_id: str,
        request: CreatorTranslationDecisionRequestV1,
        review_id: UUID,
        reviewed_at: datetime,
    ) -> TranslationReviewPublication:
        """Commit an explicit decision with trusted, retry-stable ID and timestamp.

        The eventual HTTP receiver must bind these to its durable idempotency
        receipt. Never mint replacement values after an uncertain response.
        Existing writer checks creator, consent, retention and exact lineage.
        """
        self._require_enabled()
        try:
            result = await commit_creator_translation_review_and_publish(
                self._repositories,
                tenant_id,
                session_id,
                request.to_authorized_command(
                    review_id=review_id,
                    reviewer_actor_id=creator_actor_id,
                    reviewed_at=reviewed_at,
                ),
            )
            if result is not None:
                return result
        except Exception:
            pass
        raise TranscriptReviewUnavailable()
