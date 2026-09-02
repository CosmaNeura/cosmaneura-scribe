from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from conftest import RepositoryBackend, postgres_settings
from cosmaneura_scribe.external_transcript_v1 import (
    NormalizedSourceTranscriptReceiptV1,
    NormalizedSourceTranscriptRequestV1,
    NormalizedSourceTranscriptSegmentV1,
    SourceLocale,
    TranscriptLanguageMode,
)
from cosmaneura_scribe.normalized_source_persistence import (
    NormalizedSourceAcceptanceDisposition,
    NormalizedSourcePersistenceCode,
    NormalizedSourcePersistenceError,
    VersionedExternalSessionCreate,
)
from cosmaneura_scribe.postgres_repository import (
    PostgresRepositoryProvider,
    build_postgres_provider,
)
from cosmaneura_scribe.repository import InMemoryRepository
from cosmaneura_scribe.schemas import (
    CaptureModality,
    ConsentMethod,
    ConsentRecord,
    SpeakerRole,
)
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine


def _consent(*, revoked: bool = False) -> ConsentRecord:
    now = datetime.now(UTC)
    return ConsentRecord(
        id=uuid4(),
        appointment_id=f"synthetic-appointment-{uuid4()}",
        practitioner_id="synthetic-practitioner",
        patient_id="synthetic-patient",
        modality=CaptureModality.VIRTUAL,
        participant_regions={"FL"},
        method=ConsentMethod.PRE_VISIT_FORM,
        all_parties_consented=True,
        granted_at=now,
        policy_version="synthetic-policy-v1",
        revoked_at=now if revoked else None,
    )


def _draft(
    consent: ConsentRecord,
    *,
    language_mode: TranscriptLanguageMode = TranscriptLanguageMode.ENGLISH_SPANISH,
) -> VersionedExternalSessionCreate:
    return VersionedExternalSessionCreate(
        id=uuid4(),
        appointment_id=consent.appointment_id,
        practitioner_id=consent.practitioner_id,
        patient_id=consent.patient_id,
        consent_record_id=consent.id,
        modality=consent.modality,
        creator_actor_id="synthetic_core_actor",
        language_mode=language_mode,
    )


def _request(
    *,
    spanish_content: str = "Texto fuente sintetico en espanol.",
    tied_timing: bool = False,
) -> NormalizedSourceTranscriptRequestV1:
    return NormalizedSourceTranscriptRequestV1(
        schema_version="1.0",
        duration_ms=2_000,
        segments=(
            NormalizedSourceTranscriptSegmentV1(
                speaker_slot=0,
                speaker_role=SpeakerRole.CLINICIAN,
                source_locale=SourceLocale.ENGLISH_US,
                content="Synthetic English source text.",
                start_ms=0,
                end_ms=900,
                locale_confidence=0.99,
            ),
            NormalizedSourceTranscriptSegmentV1(
                speaker_slot=1,
                speaker_role=SpeakerRole.PATIENT,
                source_locale=SourceLocale.SPANISH_US,
                content=spanish_content,
                start_ms=0 if tied_timing else 1_000,
                end_ms=900 if tied_timing else 2_000,
                locale_confidence=0.98,
            ),
        ),
    )


def test_normalized_request_and_receipt_require_strict_wire_discriminators() -> None:
    request_payload = _request().model_dump(mode="python")
    request_payload.pop("schema_version")
    with pytest.raises(ValidationError):
        NormalizedSourceTranscriptRequestV1.model_validate(request_payload)
    with pytest.raises(ValidationError):
        NormalizedSourceTranscriptRequestV1.model_validate(
            {**_request().model_dump(mode="python"), "provider": "not-allowed"}
        )
    required = set(
        NormalizedSourceTranscriptRequestV1.model_json_schema().get("required", [])
    )
    assert required == {"schema_version", "duration_ms", "segments"}
    assert set(NormalizedSourceTranscriptReceiptV1.model_json_schema()["required"]) == {
        "schema_version",
        "session_id",
        "source_receipt_id",
        "source_transcript_version",
        "receipt_state",
        "received_at",
        "transcript_content_expires_at",
    }


def test_normalized_request_json_arrays_and_strict_boundaries() -> None:
    request = _request()
    assert NormalizedSourceTranscriptRequestV1.model_validate_json(
        request.model_dump_json()
    ) == request
    payload = request.model_dump(mode="python")
    invalid_payloads = (
        {**payload, "duration_ms": 0},
        {**payload, "segments": tuple(reversed(request.segments))},
        {
            **payload,
            "segments": (
                {
                    **request.segments[0].model_dump(mode="python"),
                    "locale_confidence": float("nan"),
                },
                request.segments[1].model_dump(mode="python"),
            ),
        },
    )
    for invalid in invalid_payloads:
        with pytest.raises(ValidationError):
            NormalizedSourceTranscriptRequestV1.model_validate(invalid)
    json_payload = json.loads(request.model_dump_json())
    assert isinstance(json_payload["segments"], list)


def test_receipt_canonical_bytes_have_exact_protected_shape() -> None:
    receipt = NormalizedSourceTranscriptReceiptV1(
        schema_version="1.0",
        session_id=UUID("11111111-1111-4111-8111-111111111111"),
        source_receipt_id=UUID("22222222-2222-4222-8222-222222222222"),
        source_transcript_version=1,
        receipt_state="source_received",
        received_at=datetime(2026, 9, 1, 14, 30, tzinfo=UTC),
        transcript_content_expires_at=datetime(2026, 9, 15, 14, 30, tzinfo=UTC),
    )
    assert receipt.canonical_body() == (
        b'{"receipt_state":"source_received","received_at":"2026-09-01T14:30:00.000000Z",'
        b'"schema_version":"1.0","session_id":"11111111-1111-4111-8111-111111111111",'
        b'"source_receipt_id":"22222222-2222-4222-8222-222222222222",'
        b'"source_transcript_version":1,'
        b'"transcript_content_expires_at":"2026-09-15T14:30:00.000000Z"}'
    )
    assert "11111111" not in repr(receipt)
    with pytest.raises(ValidationError):
        NormalizedSourceTranscriptReceiptV1.model_validate(
            {
                **receipt.model_dump(mode="python"),
                "transcript_content_expires_at": receipt.received_at
                + timedelta(days=14, microseconds=1),
            }
        )


async def _seed_configured_session(
    provider: object,
    tenant_id: UUID,
    consent: ConsentRecord,
    draft: VersionedExternalSessionCreate,
) -> None:
    async with provider.transaction(tenant_id) as store:  # type: ignore[attr-defined]
        await store.add_consent(tenant_id, consent)
        created = await store.create_versioned_external_session(tenant_id, draft)
        assert created is not None
        assert (
            created.source_received_at,
            created.transcript_content_expires_at,
            created.content_purged_at,
            created.current_source_transcript_version,
        ) == (None, None, None, None)


async def _audit_actions(provider: object, tenant_id: UUID) -> list[str]:
    if isinstance(provider, InMemoryRepository):
        return [event.action for event in provider.audit_events if event.tenant_id == tenant_id]
    assert isinstance(provider, PostgresRepositoryProvider)
    async with provider.engine.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
            {"tenant_id": str(tenant_id)},
        )
        rows = await connection.execute(
            text("SELECT action FROM audit_events ORDER BY occurred_at, id")
        )
        return [row["action"] for row in rows.mappings()]


def test_accept_replay_converge_correction_and_current_read_are_backend_equivalent(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    first_request = _request(tied_timing=True)
    corrected_request = _request(
        spanish_content="Contenido sintetico corregido.", tied_timing=True
    )

    async def scenario() -> None:
        await _seed_configured_session(repository_backend.provider, tenant_id, consent, draft)
        async with repository_backend.provider.transaction(tenant_id) as store:
            first = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="source-key-0001",
                request=first_request,
            )
        assert first is not None
        assert first.disposition == NormalizedSourceAcceptanceDisposition.ACCEPTED
        assert first.receipt.source_transcript_version == 1
        assert first.receipt.transcript_content_expires_at <= (
            first.receipt.received_at + timedelta(days=14)
        )
        assert set(first.receipt.model_dump(mode="json")) == {
            "schema_version",
            "session_id",
            "source_receipt_id",
            "source_transcript_version",
            "receipt_state",
            "received_at",
            "transcript_content_expires_at",
        }
        async with repository_backend.provider.transaction(tenant_id) as store:
            configured = await store.get_versioned_external_session(tenant_id, draft.id)
            locked = await store.lock_versioned_external_session(tenant_id, draft.id)
        assert configured == locked
        assert configured is not None
        assert configured.current_source_transcript_version == 1
        assert configured.source_received_at is not None
        assert (
            configured.transcript_content_expires_at
            == first.receipt.transcript_content_expires_at
        )
        assert configured.content_purged_at is None

        before_replay_audits = len(
            await _audit_actions(repository_backend.provider, tenant_id)
        )
        async with repository_backend.provider.transaction(tenant_id) as store:
            replay = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="source-key-0001",
                request=first_request,
            )
        assert replay is not None
        assert replay.disposition == NormalizedSourceAcceptanceDisposition.REPLAYED
        assert replay.receipt_body == first.receipt_body
        assert len(await _audit_actions(repository_backend.provider, tenant_id)) == (
            before_replay_audits
        )

        async with repository_backend.provider.transaction(tenant_id) as store:
            converged = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="source-key-0002",
                request=first_request,
            )
        assert converged is not None
        assert converged.disposition == NormalizedSourceAcceptanceDisposition.CONVERGED
        assert converged.receipt_body == first.receipt_body

        async with repository_backend.provider.transaction(tenant_id) as store:
            corrected = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="source-key-0003",
                request=corrected_request,
            )
        assert corrected is not None
        assert corrected.disposition == NormalizedSourceAcceptanceDisposition.CORRECTED
        assert corrected.receipt.source_transcript_version == 2
        assert corrected.receipt.source_receipt_id != first.receipt.source_receipt_id
        assert (
            corrected.receipt.transcript_content_expires_at
            == first.receipt.transcript_content_expires_at
        )

        async with repository_backend.provider.transaction(tenant_id) as store:
            current = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
        assert current is not None
        assert current.receipt == corrected.receipt
        assert current.segments[0].speaker_id != current.segments[1].speaker_id
        segment_order = [
            (item.start_ms, item.end_ms, item.source_segment_id.int) for item in current.segments
        ]
        assert segment_order == sorted(segment_order)
        assert "Texto fuente" not in repr(first)
        assert "Contenido sintetico" not in repr(current)
        assert "source-key" not in repr(first)
        assert await _audit_actions(repository_backend.provider, tenant_id) == [
            "normalized_source.accepted",
            "normalized_source.converged",
            "normalized_source.corrected",
            "normalized_source.read",
        ]

    repository_backend.run(scenario)


def test_conflicts_consent_and_transaction_rollback_leave_no_partial_source(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    request = _request()

    async def scenario() -> None:
        await _seed_configured_session(repository_backend.provider, tenant_id, consent, draft)
        with pytest.raises(RuntimeError, match="synthetic rollback"):
            async with repository_backend.provider.transaction(tenant_id) as store:
                assert await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="rollback-key-0001",
                    request=request,
                ) is not None
                raise RuntimeError("synthetic rollback")

        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.get_current_normalized_source_transcript(tenant_id, draft.id) is None
            accepted = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="accepted-key-0001",
                request=request,
            )
        assert accepted is not None
        assert accepted.receipt.source_transcript_version == 1

        with pytest.raises(NormalizedSourcePersistenceError) as conflicting:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="accepted-key-0001",
                    request=_request(spanish_content="Different synthetic content."),
                )
        assert conflicting.value.code == NormalizedSourcePersistenceCode.IDEMPOTENCY_CONFLICT

        async with repository_backend.provider.transaction(tenant_id) as store:
            await store.revoke_consent(tenant_id, consent.id)
        with pytest.raises(NormalizedSourcePersistenceError) as revoked:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="accepted-key-0001",
                    request=request,
                )
        assert revoked.value.code == NormalizedSourcePersistenceCode.CONSENT_INVALID

        async with repository_backend.provider.transaction(uuid4()) as store:
            assert await store.accept_normalized_source_transcript(
                uuid4(),
                draft.id,
                idempotency_key="cross-tenant-key",
                request=request,
            ) is None

    repository_backend.run(scenario)


def test_english_only_session_rejects_spanish_before_any_source_write(
    repository_backend: RepositoryBackend,
) -> None:
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent, language_mode=TranscriptLanguageMode.ENGLISH)

    async def scenario() -> None:
        await _seed_configured_session(repository_backend.provider, tenant_id, consent, draft)
        with pytest.raises(NormalizedSourcePersistenceError) as failure:
            async with repository_backend.provider.transaction(tenant_id) as store:
                await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="language-key-0001",
                    request=_request(),
                )
        assert failure.value.code == NormalizedSourcePersistenceCode.LANGUAGE_MODE_CONFLICT
        async with repository_backend.provider.transaction(tenant_id) as store:
            assert await store.get_current_normalized_source_transcript(tenant_id, draft.id) is None
        assert await _audit_actions(repository_backend.provider, tenant_id) == []

    repository_backend.run(scenario)


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_concurrent_changed_receipts_allocate_monotonic_versions(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(
        postgres_settings(app_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    await _seed_configured_session(provider, tenant_id, consent, draft)

    async def accept(key: str, content: str) -> int:
        async with provider.transaction(tenant_id) as store:
            result = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key=key,
                request=_request(spanish_content=content),
            )
            assert result is not None
            return result.receipt.source_transcript_version

    try:
        versions = await asyncio.gather(
            accept("race-key-0001", "Primer contenido sintetico."),
            accept("race-key-0002", "Segundo contenido sintetico."),
        )
        assert sorted(versions) == [1, 2]
        async with provider.transaction(tenant_id) as store:
            current = await store.get_current_normalized_source_transcript(tenant_id, draft.id)
        assert current is not None
        assert current.source_transcript_version == 2
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_concurrent_same_key_converges_without_duplicate_source(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(
        postgres_settings(app_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    await _seed_configured_session(provider, tenant_id, consent, draft)

    async def accept() -> tuple[NormalizedSourceAcceptanceDisposition, bytes]:
        async with provider.transaction(tenant_id) as store:
            result = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="same-race-key",
                request=_request(),
            )
            assert result is not None
            return result.disposition, result.receipt_body

    try:
        results = await asyncio.gather(accept(), accept())
        assert {result[0] for result in results} == {
            NormalizedSourceAcceptanceDisposition.ACCEPTED,
            NormalizedSourceAcceptanceDisposition.REPLAYED,
        }
        assert results[0][1] == results[1][1]
        async with provider.engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            assert await connection.scalar(
                text(
                    "SELECT count(*) FROM normalized_source_transcripts "
                    "WHERE tenant_id = :tenant_id AND session_id = :session_id"
                ),
                {"tenant_id": tenant_id, "session_id": draft.id},
            ) == 1
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_receipt_and_revocation_share_consent_lock(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(
        postgres_settings(app_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    await _seed_configured_session(provider, tenant_id, consent, draft)
    receipt_ready = asyncio.Event()
    release_receipt = asyncio.Event()

    async def receipt_first() -> None:
        async with provider.transaction(tenant_id) as store:
            result = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="consent-race-key",
                request=_request(),
            )
            assert result is not None
            receipt_ready.set()
            await release_receipt.wait()

    async def revoke_second() -> None:
        await receipt_ready.wait()
        async with provider.transaction(tenant_id) as store:
            assert await store.revoke_consent(tenant_id, consent.id) is not None

    try:
        receipt_task = asyncio.create_task(receipt_first())
        revoke_task = asyncio.create_task(revoke_second())
        await receipt_ready.wait()
        await asyncio.sleep(0.05)
        assert not revoke_task.done()
        release_receipt.set()
        await asyncio.gather(receipt_task, revoke_task)

        with pytest.raises(NormalizedSourcePersistenceError) as replay:
            async with provider.transaction(tenant_id) as store:
                await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="consent-race-key",
                    request=_request(),
                )
        assert replay.value.code == NormalizedSourcePersistenceCode.CONSENT_INVALID
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_revocation_winning_the_lock_prevents_any_receipt_write(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(
        postgres_settings(app_url).model_copy(
            update={"database_pool_size": 2, "database_max_overflow": 0}
        )
    )
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    await _seed_configured_session(provider, tenant_id, consent, draft)
    revoked_but_uncommitted = asyncio.Event()
    release_revocation = asyncio.Event()

    async def revoke_first() -> None:
        async with provider.transaction(tenant_id) as store:
            assert await store.revoke_consent(tenant_id, consent.id) is not None
            revoked_but_uncommitted.set()
            await release_revocation.wait()

    async def receipt_second() -> None:
        await revoked_but_uncommitted.wait()
        with pytest.raises(NormalizedSourcePersistenceError) as failure:
            async with provider.transaction(tenant_id) as store:
                await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="revocation-first-key",
                    request=_request(),
                )
        assert failure.value.code == NormalizedSourcePersistenceCode.CONSENT_INVALID

    try:
        revocation_task = asyncio.create_task(revoke_first())
        receipt_task = asyncio.create_task(receipt_second())
        await revoked_but_uncommitted.wait()
        await asyncio.sleep(0.05)
        assert not receipt_task.done()
        release_revocation.set()
        await asyncio.gather(revocation_task, receipt_task)
        async with provider.engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            assert await connection.scalar(
                text(
                    "SELECT count(*) FROM normalized_source_transcripts "
                    "WHERE tenant_id = :tenant_id AND session_id = :session_id"
                ),
                {"tenant_id": tenant_id, "session_id": draft.id},
            ) == 0
    finally:
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_database_clock_retention_gate_precedes_cached_replay(
    postgres_urls: tuple[str, str],
) -> None:
    admin_url, app_url = postgres_urls
    provider = build_postgres_provider(postgres_settings(app_url))
    admin = create_async_engine(admin_url, connect_args={"ssl": False})
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    await _seed_configured_session(provider, tenant_id, consent, draft)
    try:
        async with provider.transaction(tenant_id) as store:
            assert await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="expired-replay-key",
                request=_request(),
            ) is not None
        async with admin.begin() as connection:
            await connection.execute(text("SET LOCAL session_replication_role = replica"))
            await connection.execute(
                text(
                    """
                    UPDATE scribe_sessions
                    SET source_received_at = statement_timestamp() - INTERVAL '14 days',
                        transcript_content_expires_at =
                            statement_timestamp() - INTERVAL '1 microsecond'
                    WHERE tenant_id = :tenant_id AND id = :session_id
                    """
                ),
                {"tenant_id": tenant_id, "session_id": draft.id},
            )
        with pytest.raises(NormalizedSourcePersistenceError) as expired:
            async with provider.transaction(tenant_id) as store:
                await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="expired-replay-key",
                    request=_request(),
                )
        assert expired.value.code == NormalizedSourcePersistenceCode.RETENTION_EXPIRED
    finally:
        await admin.dispose()
        await provider.close()


@pytest.mark.postgres
@pytest.mark.asyncio
async def test_postgres_handoff_allows_exact_replay_but_rejects_replacement(
    postgres_urls: tuple[str, str],
) -> None:
    _, app_url = postgres_urls
    provider = build_postgres_provider(postgres_settings(app_url))
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)
    await _seed_configured_session(provider, tenant_id, consent, draft)
    try:
        async with provider.transaction(tenant_id) as store:
            accepted = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="handoff-source-key",
                request=_request(),
            )
        assert accepted is not None
        async with provider.engine.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
                {"tenant_id": str(tenant_id)},
            )
            await connection.execute(
                text(
                    "UPDATE scribe_sessions SET status = 'transcript_ready' "
                    "WHERE tenant_id = :tenant_id AND id = :session_id"
                ),
                {"tenant_id": tenant_id, "session_id": draft.id},
            )
            await connection.execute(
                text(
                    "UPDATE scribe_sessions SET status = 'handed_off' "
                    "WHERE tenant_id = :tenant_id AND id = :session_id"
                ),
                {"tenant_id": tenant_id, "session_id": draft.id},
            )
        async with provider.transaction(tenant_id) as store:
            replay = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="handoff-source-key",
                request=_request(),
            )
        assert replay is not None
        assert replay.receipt_body == accepted.receipt_body
        with pytest.raises(NormalizedSourcePersistenceError) as changed:
            async with provider.transaction(tenant_id) as store:
                await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="handoff-change-key",
                    request=_request(spanish_content="Synthetic replacement after handoff."),
                )
        assert changed.value.code == NormalizedSourcePersistenceCode.STATE_CONFLICT
    finally:
        await provider.close()


def test_memory_retention_gate_precedes_cached_replay() -> None:
    provider = InMemoryRepository()
    tenant_id = uuid4()
    consent = _consent()
    draft = _draft(consent)

    async def scenario() -> None:
        await _seed_configured_session(provider, tenant_id, consent, draft)
        async with provider.transaction(tenant_id) as store:
            result = await store.accept_normalized_source_transcript(
                tenant_id,
                draft.id,
                idempotency_key="retention-key-0001",
                request=_request(),
            )
        assert result is not None
        session = provider.versioned_external_sessions[(tenant_id, draft.id)]
        provider.versioned_external_sessions[(tenant_id, draft.id)] = replace(
            session,
            transcript_content_expires_at=datetime.now(UTC) - timedelta(microseconds=1),
        )
        with pytest.raises(NormalizedSourcePersistenceError) as expired:
            async with provider.transaction(tenant_id) as store:
                await store.accept_normalized_source_transcript(
                    tenant_id,
                    draft.id,
                    idempotency_key="retention-key-0001",
                    request=_request(),
                )
        assert expired.value.code == NormalizedSourcePersistenceCode.RETENTION_EXPIRED

    asyncio.run(scenario())
