from __future__ import annotations

from collections.abc import Awaitable, Callable
from enum import StrEnum
from uuid import UUID

from sqlalchemy.exc import DBAPIError

from .repository import Repository, RepositoryProvider
from .translation_attempt_persistence import (
    TranslationAttemptCommand,
    TranslationAttemptPersistenceCode,
    TranslationAttemptPersistenceError,
    TranslationAttemptPublication,
)
from .translation_review_persistence import (
    CreatorTranslationReviewCommand,
    TranslationReviewPersistenceCode,
    TranslationReviewPersistenceError,
    TranslationReviewPublication,
)


class DerivedWriterTransactionCode(StrEnum):
    COMMIT_OUTCOME_UNKNOWN = "derived_writer_commit_outcome_unknown"


class DerivedWriterTransactionError(RuntimeError):
    """Bounded transaction failure that never retains a raw database exception."""

    def __init__(self, code: DerivedWriterTransactionCode) -> None:
        self.code = code
        super().__init__(code.value)

    def __repr__(self) -> str:
        return f"DerivedWriterTransactionError({self.code.value!r})"


async def _commit_with_one_database_retry[
    PublicationT: (TranslationAttemptPublication, TranslationReviewPublication)
](
    repositories: RepositoryProvider,
    tenant_id: UUID,
    operation: Callable[[Repository], Awaitable[PublicationT | None]],
) -> PublicationT | None:
    database_failure_seen = False
    unknown_outcome = False
    attempt_failure: TranslationAttemptPersistenceCode | None = None
    review_failure: TranslationReviewPersistenceCode | None = None
    for _attempt in range(2):
        try:
            async with repositories.transaction(tenant_id) as store:
                publication = await operation(store)
        except TranslationAttemptPersistenceError as error:
            attempt_failure = error.code
            break
        except TranslationReviewPersistenceError as error:
            review_failure = error.code
            break
        except DBAPIError:
            if database_failure_seen:
                unknown_outcome = True
                break
            database_failure_seen = True
            continue

        # A publication is visible to the caller only after the provider's
        # transaction context has committed successfully. After an ambiguous
        # first database failure, an empty retry cannot resolve the outcome.
        if database_failure_seen and publication is None:
            unknown_outcome = True
            break
        return publication

    # Rebuild bounded writer failures after leaving their handler. PostgreSQL
    # mappings can originate inside a DBAPIError handler; retaining that object
    # would also retain its raw driver exception through __context__.
    if attempt_failure is not None:
        raise TranslationAttemptPersistenceError(attempt_failure) from None
    if review_failure is not None:
        raise TranslationReviewPersistenceError(review_failure) from None
    if not unknown_outcome:
        raise AssertionError("derived writer retry loop ended without an outcome")
    # Raise outside an active DBAPIError handler. This keeps both __cause__ and
    # __context__ empty instead of retaining raw driver text or bound values.
    raise DerivedWriterTransactionError(
        DerivedWriterTransactionCode.COMMIT_OUTCOME_UNKNOWN
    ) from None


async def commit_translation_attempt_and_publish(
    repositories: RepositoryProvider,
    tenant_id: UUID,
    session_id: UUID,
    command: TranslationAttemptCommand,
) -> TranslationAttemptPublication | None:
    """Commit one immutable attempt command, reconciling one ambiguous DB failure."""

    async def write(store: Repository) -> TranslationAttemptPublication | None:
        return await store.record_translation_attempt_and_publish(
            tenant_id,
            session_id,
            command,
        )

    return await _commit_with_one_database_retry(repositories, tenant_id, write)


async def commit_creator_translation_review_and_publish(
    repositories: RepositoryProvider,
    tenant_id: UUID,
    session_id: UUID,
    command: CreatorTranslationReviewCommand,
) -> TranslationReviewPublication | None:
    """Commit one immutable review command, reconciling one ambiguous DB failure."""

    async def write(store: Repository) -> TranslationReviewPublication | None:
        return await store.record_creator_translation_review_and_publish(
            tenant_id,
            session_id,
            command,
        )

    return await _commit_with_one_database_retry(repositories, tenant_id, write)
