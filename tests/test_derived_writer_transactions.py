from __future__ import annotations

import asyncio
import traceback
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, cast
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend, postgres_settings
from cosmaneura_scribe.derived_writer_transactions import (
    DerivedWriterTransactionCode,
    DerivedWriterTransactionError,
    commit_creator_translation_review_and_publish,
    commit_translation_attempt_and_publish,
)
from cosmaneura_scribe.postgres_repository import (
    PostgresRepository,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import (
    InMemoryRepository,
    Repository,
    RepositoryProvider,
)
from cosmaneura_scribe.translation_attempt_persistence import (
    TranslationAttemptCommand,
    TranslationAttemptPersistenceCode,
    TranslationAttemptPersistenceError,
    TranslationAttemptPublication,
    TranslationAttemptWriteDisposition,
)
from cosmaneura_scribe.translation_review_persistence import (
    CreatorTranslationReviewCommand,
    TranslationReviewPersistenceCode,
    TranslationReviewPersistenceError,
    TranslationReviewPublication,
    TranslationReviewWriteDisposition,
)
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine
from test_translation_attempt_persistence import (
    _command,
    _seed_pending,
)
from test_translation_attempt_persistence import (
    _derived_counts as _attempt_counts,
)
from test_translation_review_persistence import (
    _derived_counts as _review_counts,
)
from test_translation_review_persistence import (
    _review_command,
    _seed_review_required,
)

_RAW_DATABASE_MARKER = "synthetic_raw_database_marker"
_PROTECTED_COMMAND_MARKER = "Synthetic protected command marker"


def _database_failure() -> DBAPIError:
    return DBAPIError(
        f"SELECT '{_RAW_DATABASE_MARKER}'",
        {"protected": _PROTECTED_COMMAND_MARKER},
        RuntimeError(_RAW_DATABASE_MARKER),
        True,
    )


class _RecordingStore:
    def __init__(
        self,
        delegate: Repository,
        commands: list[object],
        *,
        return_none: bool,
    ) -> None:
        self._delegate = delegate
        self._commands = commands
        self._return_none = return_none

    def __getattr__(self, name: str) -> object:
        return getattr(self._delegate, name)

    async def record_translation_attempt_and_publish(
        self,
        tenant_id: UUID,
        session_id: UUID,
        command: TranslationAttemptCommand,
    ) -> TranslationAttemptPublication | None:
        self._commands.append(command)
        if self._return_none:
            return None
        return await self._delegate.record_translation_attempt_and_publish(
            tenant_id,
            session_id,
            command,
        )

    async def record_creator_translation_review_and_publish(
        self,
        tenant_id: UUID,
        session_id: UUID,
        command: CreatorTranslationReviewCommand,
    ) -> TranslationReviewPublication | None:
        self._commands.append(command)
        if self._return_none:
            return None
        return await self._delegate.record_creator_translation_review_and_publish(
            tenant_id,
            session_id,
            command,
        )


_FailureMode = Literal[
    "rollback_first",
    "lose_first_acknowledgement",
    "fail_first_before_body",
    "fail_every_transaction",
    "first_failure_then_none",
]


class _FaultInjectingProvider:
    def __init__(self, delegate: RepositoryProvider, mode: _FailureMode) -> None:
        self._delegate = delegate
        self._mode = mode
        self.transaction_calls = 0
        self.commands: list[object] = []

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[Repository]:
        self.transaction_calls += 1
        call = self.transaction_calls
        if self._mode == "fail_every_transaction" or (
            call == 1 and self._mode in {"fail_first_before_body", "first_failure_then_none"}
        ):
            raise _database_failure()

        return_none = self._mode == "first_failure_then_none" and call == 2
        async with self._delegate.transaction(tenant_id) as store:
            yield cast(
                Repository,
                _RecordingStore(store, self.commands, return_none=return_none),
            )
            if call == 1 and self._mode == "rollback_first":
                raise _database_failure()
        if call == 1 and self._mode == "lose_first_acknowledgement":
            raise _database_failure()

    async def health(self) -> None:
        await self._delegate.health()

    async def close(self) -> None:
        await self._delegate.close()


def test_success_and_exact_replay_are_committed_for_both_backends(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()

    async def scenario() -> None:
        draft, spanish, _ = await _seed_pending(repository_backend.provider, tenant_id)
        attempt_command = _command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
        )
        attempt = await commit_translation_attempt_and_publish(
            repository_backend.provider,
            tenant_id,
            draft.id,  # type: ignore[attr-defined]
            attempt_command,
        )
        assert attempt is not None
        assert attempt.disposition == TranslationAttemptWriteDisposition.RECORDED
        attempt_counts = await _attempt_counts(
            repository_backend.provider,
            tenant_id,
            draft.id,  # type: ignore[attr-defined]
        )
        replayed_attempt = await commit_translation_attempt_and_publish(
            repository_backend.provider,
            tenant_id,
            draft.id,  # type: ignore[attr-defined]
            attempt_command,
        )
        assert replayed_attempt is not None
        assert replayed_attempt.disposition == TranslationAttemptWriteDisposition.REPLAYED
        assert (
            await _attempt_counts(
                repository_backend.provider,
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
            )
            == attempt_counts
        )

        review_command = _review_command(
            1,
            spanish.source_segment_id,  # type: ignore[attr-defined]
            spanish.source_segment_version,  # type: ignore[attr-defined]
            attempt.translation_id,
            attempt.translation_version,
            draft.creator_actor_id,  # type: ignore[attr-defined]
        )
        review = await commit_creator_translation_review_and_publish(
            repository_backend.provider,
            tenant_id,
            draft.id,  # type: ignore[attr-defined]
            review_command,
        )
        assert review is not None
        assert review.disposition == TranslationReviewWriteDisposition.RECORDED
        review_counts = await _review_counts(
            repository_backend.provider,
            tenant_id,
            draft.id,  # type: ignore[attr-defined]
        )
        replayed_review = await commit_creator_translation_review_and_publish(
            repository_backend.provider,
            tenant_id,
            draft.id,  # type: ignore[attr-defined]
            review_command,
        )
        assert replayed_review is not None
        assert replayed_review.disposition == TranslationReviewWriteDisposition.REPLAYED
        assert (
            await _review_counts(
                repository_backend.provider,
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
            )
            == review_counts
        )

    repository_backend.run(scenario)


@pytest.mark.asyncio
async def test_rollback_before_commit_retries_exact_commands_for_both_writers() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()

    draft, spanish, _ = await _seed_pending(provider, tenant_id)
    attempt_command = _command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
    )
    attempt_provider = _FaultInjectingProvider(provider, "rollback_first")
    attempt = await commit_translation_attempt_and_publish(
        attempt_provider,
        tenant_id,
        draft.id,  # type: ignore[attr-defined]
        attempt_command,
    )
    assert attempt is not None
    assert attempt.disposition == TranslationAttemptWriteDisposition.RECORDED
    assert attempt_provider.commands == [attempt_command, attempt_command]
    assert all(command is attempt_command for command in attempt_provider.commands)
    assert (
        await _attempt_counts(provider, tenant_id, draft.id) == (1, 2, 1)  # type: ignore[attr-defined]
    )

    review_command = _review_command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
        attempt.translation_id,
        attempt.translation_version,
        draft.creator_actor_id,  # type: ignore[attr-defined]
    )
    review_provider = _FaultInjectingProvider(provider, "rollback_first")
    review = await commit_creator_translation_review_and_publish(
        review_provider,
        tenant_id,
        draft.id,  # type: ignore[attr-defined]
        review_command,
    )
    assert review is not None
    assert review.disposition == TranslationReviewWriteDisposition.RECORDED
    assert review_provider.commands == [review_command, review_command]
    assert all(command is review_command for command in review_provider.commands)
    assert (
        await _review_counts(provider, tenant_id, draft.id) == (1, 3, 1)  # type: ignore[attr-defined]
    )


@pytest.mark.asyncio
async def test_lost_commit_acknowledgement_replays_without_duplicate_evidence() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()

    draft, spanish, _ = await _seed_pending(provider, tenant_id)
    attempt_command = _command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
    )
    attempt_provider = _FaultInjectingProvider(provider, "lose_first_acknowledgement")
    attempt = await commit_translation_attempt_and_publish(
        attempt_provider,
        tenant_id,
        draft.id,  # type: ignore[attr-defined]
        attempt_command,
    )
    assert attempt is not None
    assert attempt.disposition == TranslationAttemptWriteDisposition.REPLAYED
    assert attempt_provider.commands == [attempt_command, attempt_command]
    assert all(command is attempt_command for command in attempt_provider.commands)
    assert (
        await _attempt_counts(provider, tenant_id, draft.id) == (1, 2, 1)  # type: ignore[attr-defined]
    )

    review_command = _review_command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
        attempt.translation_id,
        attempt.translation_version,
        draft.creator_actor_id,  # type: ignore[attr-defined]
    )
    review_provider = _FaultInjectingProvider(provider, "lose_first_acknowledgement")
    review = await commit_creator_translation_review_and_publish(
        review_provider,
        tenant_id,
        draft.id,  # type: ignore[attr-defined]
        review_command,
    )
    assert review is not None
    assert review.disposition == TranslationReviewWriteDisposition.REPLAYED
    assert review_provider.commands == [review_command, review_command]
    assert all(command is review_command for command in review_provider.commands)
    assert (
        await _review_counts(provider, tenant_id, draft.id) == (1, 3, 1)  # type: ignore[attr-defined]
    )


@pytest.mark.asyncio
async def test_bounded_errors_and_cancellation_are_never_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = uuid4()
    session_id = uuid4()
    provider = InMemoryRepository()
    attempt_command = _command(1, uuid4(), 1)
    attempt_calls = 0

    async def reject_attempt(*_: object) -> TranslationAttemptPublication | None:
        nonlocal attempt_calls
        attempt_calls += 1
        try:
            raise _database_failure()
        except DBAPIError:
            raise TranslationAttemptPersistenceError(
                TranslationAttemptPersistenceCode.STATE_CONFLICT
            ) from None

    monkeypatch.setattr(provider, "record_translation_attempt_and_publish", reject_attempt)
    with pytest.raises(TranslationAttemptPersistenceError) as rejected_attempt:
        await commit_translation_attempt_and_publish(
            provider,
            tenant_id,
            session_id,
            attempt_command,
        )
    assert rejected_attempt.value.code == TranslationAttemptPersistenceCode.STATE_CONFLICT
    assert rejected_attempt.value.__cause__ is None
    assert rejected_attempt.value.__context__ is None
    assert _RAW_DATABASE_MARKER not in "".join(traceback.format_exception(rejected_attempt.value))
    assert attempt_calls == 1

    review_command = _review_command(1, uuid4(), 1, uuid4(), 1, "synthetic_creator")
    review_calls = 0

    async def reject_review(*_: object) -> TranslationReviewPublication | None:
        nonlocal review_calls
        review_calls += 1
        try:
            raise _database_failure()
        except DBAPIError:
            raise TranslationReviewPersistenceError(
                TranslationReviewPersistenceCode.CREATOR_MISMATCH
            ) from None

    monkeypatch.setattr(
        provider,
        "record_creator_translation_review_and_publish",
        reject_review,
    )
    with pytest.raises(TranslationReviewPersistenceError) as rejected_review:
        await commit_creator_translation_review_and_publish(
            provider,
            tenant_id,
            session_id,
            review_command,
        )
    assert rejected_review.value.code == TranslationReviewPersistenceCode.CREATOR_MISMATCH
    assert rejected_review.value.__cause__ is None
    assert rejected_review.value.__context__ is None
    assert _RAW_DATABASE_MARKER not in "".join(traceback.format_exception(rejected_review.value))
    assert review_calls == 1

    cancellation_calls = 0

    async def cancel_attempt(*_: object) -> TranslationAttemptPublication | None:
        nonlocal cancellation_calls
        cancellation_calls += 1
        raise asyncio.CancelledError

    monkeypatch.setattr(provider, "record_translation_attempt_and_publish", cancel_attempt)
    with pytest.raises(asyncio.CancelledError):
        await commit_translation_attempt_and_publish(
            provider,
            tenant_id,
            session_id,
            attempt_command,
        )
    assert cancellation_calls == 1


@pytest.mark.asyncio
async def test_bounded_retry_error_is_current_state_and_passes_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tenant_id = uuid4()
    session_id = uuid4()
    delegate = InMemoryRepository()
    attempt_command = _command(1, uuid4(), 1)
    calls = 0

    async def expired(*_: object) -> TranslationAttemptPublication | None:
        nonlocal calls
        calls += 1
        raise TranslationAttemptPersistenceError(
            TranslationAttemptPersistenceCode.RETENTION_EXPIRED
        )

    monkeypatch.setattr(delegate, "record_translation_attempt_and_publish", expired)
    provider = _FaultInjectingProvider(delegate, "fail_first_before_body")
    with pytest.raises(TranslationAttemptPersistenceError) as current_state:
        await commit_translation_attempt_and_publish(
            provider,
            tenant_id,
            session_id,
            attempt_command,
        )
    assert current_state.value.code == TranslationAttemptPersistenceCode.RETENTION_EXPIRED
    assert current_state.value.__cause__ is None
    assert current_state.value.__context__ is None
    rendered = "".join(traceback.format_exception(current_state.value))
    assert _RAW_DATABASE_MARKER not in rendered
    assert _PROTECTED_COMMAND_MARKER not in rendered
    assert provider.transaction_calls == 2
    assert calls == 1


@pytest.mark.asyncio
async def test_none_semantics_distinguish_normal_absence_from_unknown_outcome() -> None:
    tenant_id = uuid4()
    session_id = uuid4()
    command = _command(1, uuid4(), 1)

    assert (
        await commit_translation_attempt_and_publish(
            InMemoryRepository(),
            tenant_id,
            session_id,
            command,
        )
        is None
    )

    provider = _FaultInjectingProvider(InMemoryRepository(), "first_failure_then_none")
    with pytest.raises(DerivedWriterTransactionError) as unknown:
        await commit_translation_attempt_and_publish(
            provider,
            tenant_id,
            session_id,
            command,
        )
    assert unknown.value.code == DerivedWriterTransactionCode.COMMIT_OUTCOME_UNKNOWN
    assert provider.transaction_calls == 2


@pytest.mark.asyncio
async def test_second_database_failure_is_chain_free_and_metadata_only() -> None:
    tenant_id = uuid4()
    provider = _FaultInjectingProvider(InMemoryRepository(), "fail_every_transaction")
    command = _command(1, uuid4(), 1, content=_PROTECTED_COMMAND_MARKER)

    with pytest.raises(DerivedWriterTransactionError) as unknown:
        await commit_translation_attempt_and_publish(
            provider,
            tenant_id,
            uuid4(),
            command,
        )
    error = unknown.value
    assert error.code == DerivedWriterTransactionCode.COMMIT_OUTCOME_UNKNOWN
    assert provider.transaction_calls == 2
    assert error.__cause__ is None
    assert error.__context__ is None
    rendered = "".join(traceback.format_exception(error))
    for representation in (str(error), repr(error), rendered):
        assert _RAW_DATABASE_MARKER not in representation
        assert _PROTECTED_COMMAND_MARKER not in representation


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_deferred_expiry_is_reconciled_to_bounded_current_state(
    postgres_urls: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(postgres_settings(admin_url))
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    draft, spanish, _ = await _seed_pending(provider, tenant_id)
    command = _command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
        content=_PROTECTED_COMMAND_MARKER,
    )
    original = PostgresRepository.record_translation_attempt_and_publish
    calls = 0

    async def delay_first_attempt(
        self: PostgresRepository,
        inner_tenant_id: UUID,
        session_id: UUID,
        inner_command: TranslationAttemptCommand,
    ) -> TranslationAttemptPublication | None:
        nonlocal calls
        calls += 1
        result = await original(self, inner_tenant_id, session_id, inner_command)
        if calls == 1:
            await self._session.execute(text("SELECT pg_sleep(2.1)"))
        return result

    try:
        async with engine.begin() as connection:
            await connection.execute(text("SET LOCAL session_replication_role = replica"))
            await connection.execute(
                text(
                    """
                    UPDATE scribe_sessions
                    SET transcript_content_expires_at = clock_timestamp() + INTERVAL '2 seconds'
                    WHERE tenant_id = :tenant AND id = :session
                    """
                ),
                {"tenant": tenant_id, "session": draft.id},  # type: ignore[attr-defined]
            )
        monkeypatch.setattr(
            PostgresRepository,
            "record_translation_attempt_and_publish",
            delay_first_attempt,
        )
        with pytest.raises(TranslationAttemptPersistenceError) as expired:
            await commit_translation_attempt_and_publish(
                provider,
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                command,
            )
        assert expired.value.code == TranslationAttemptPersistenceCode.RETENTION_EXPIRED
        assert calls == 2
        assert (
            await _attempt_counts(provider, tenant_id, draft.id)  # type: ignore[attr-defined]
            == (0, 1, 0)
        )
    finally:
        await engine.dispose()
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_deferred_review_expiry_is_bounded_without_duplicates(
    postgres_urls: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin_url, _ = postgres_urls
    provider = build_postgres_provider(postgres_settings(admin_url))
    engine = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    draft, spanish, _, attempt = await _seed_review_required(provider, tenant_id)
    command = _review_command(
        1,
        spanish.source_segment_id,  # type: ignore[attr-defined]
        spanish.source_segment_version,  # type: ignore[attr-defined]
        attempt.translation_id,  # type: ignore[attr-defined]
        attempt.translation_version,  # type: ignore[attr-defined]
        draft.creator_actor_id,  # type: ignore[attr-defined]
    )
    original = PostgresRepository.record_creator_translation_review_and_publish
    calls = 0

    async def delay_first_review(
        self: PostgresRepository,
        inner_tenant_id: UUID,
        session_id: UUID,
        inner_command: CreatorTranslationReviewCommand,
    ) -> TranslationReviewPublication | None:
        nonlocal calls
        calls += 1
        result = await original(self, inner_tenant_id, session_id, inner_command)
        if calls == 1:
            await self._session.execute(text("SELECT pg_sleep(2.1)"))
        return result

    try:
        async with engine.begin() as connection:
            await connection.execute(text("SET LOCAL session_replication_role = replica"))
            await connection.execute(
                text(
                    """
                    UPDATE scribe_sessions
                    SET transcript_content_expires_at = clock_timestamp() + INTERVAL '2 seconds'
                    WHERE tenant_id = :tenant AND id = :session
                    """
                ),
                {"tenant": tenant_id, "session": draft.id},  # type: ignore[attr-defined]
            )
        monkeypatch.setattr(
            PostgresRepository,
            "record_creator_translation_review_and_publish",
            delay_first_review,
        )
        with pytest.raises(TranslationReviewPersistenceError) as expired:
            await commit_creator_translation_review_and_publish(
                provider,
                tenant_id,
                draft.id,  # type: ignore[attr-defined]
                command,
            )
        assert expired.value.code == TranslationReviewPersistenceCode.RETENTION_EXPIRED
        assert calls == 2
        assert (
            await _review_counts(provider, tenant_id, draft.id)  # type: ignore[attr-defined]
            == (0, 2, 0)
        )
    finally:
        await engine.dispose()
        await provider.close()


def test_wrappers_remain_internal_without_auth_network_or_activation_surface() -> None:
    root = Path(__file__).resolve().parents[1]
    source_path = (
        root / "services" / "api" / "src" / "cosmaneura_scribe" / "derived_writer_transactions.py"
    )
    source = source_path.read_text()
    wrapper_names = (
        "commit_translation_attempt_and_publish",
        "commit_creator_translation_review_and_publish",
    )
    assert "RepositoryProvider" in source
    assert all(
        token not in source
        for token in (
            "httpx",
            "requests",
            "azure.identity",
            "service_auth",
            "Settings",
            "GRANT ",
        )
    )
    forbidden_surfaces = (
        root / "services" / "api" / "src" / "cosmaneura_scribe" / "main.py",
        root / "services" / "api" / "src" / "cosmaneura_scribe" / "service_auth.py",
        root / "services" / "api" / "src" / "cosmaneura_scribe" / "settings.py",
        root / "services" / "api" / "src" / "cosmaneura_scribe" / "database_bootstrap.py",
        *(root / "services" / "api" / "src" / "cosmaneura_scribe").glob("*routes.py"),
        *(root / "alembic" / "versions").glob("*.py"),
    )
    for path in forbidden_surfaces:
        contents = path.read_text()
        assert all(name not in contents for name in wrapper_names)
