"""Real PostgreSQL reservation cost, canonical recovery and atomicity."""

import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from conftest import RepositoryBackend, postgres_settings
from cosmaneura_scribe.capture_protocol_v1 import (
    MAX_AGGREGATE_PLAINTEXT_BYTES,
    MAX_CHUNKS,
    MAX_RESERVATIONS_PER_BATCH,
    PROTOCOL_VERSION,
)
from cosmaneura_scribe.postgres_repository import build_postgres_provider
from cosmaneura_scribe.schemas import CaptureChannel
from sqlalchemy import event
from sqlalchemy.exc import IntegrityError
from test_capture_repository import _draft, _seed_capture

pytestmark = pytest.mark.postgres


async def _reserve(provider, tenant, session, lease, drafts):
    async with provider.transaction(tenant) as store:
        return await store.create_chunk_reservation_batch(
            tenant,
            session.id,
            batch_id=uuid4(),
            lease_id=lease,
            lease_generation=1,
            requested_protocol_version=PROTOCOL_VERSION,
            drafts=tuple(drafts),
            maximum_batch_size=MAX_RESERVATIONS_PER_BATCH,
            maximum_chunks=MAX_CHUNKS,
            maximum_plaintext_bytes=MAX_AGGREGATE_PLAINTEXT_BYTES,
        )


async def _capture(provider):
    tenant, session = await _seed_capture(RepositoryBackend("postgres", provider))
    lease = uuid4()
    async with provider.transaction(tenant) as store:
        assert await store.issue_capture_lease(
            tenant,
            session.id,
            lease_id=lease,
            receipt_id=uuid4(),
            duration=timedelta(minutes=15),
        )
    return tenant, session, lease


@pytest.mark.parametrize("count", [1, 90])
def test_reservation_round_trips_are_bounded_and_recovery_keeps_canonical_order(
    postgres_urls,
    count,
    record_property,
):
    async def scenario():
        provider = build_postgres_provider(postgres_settings(postgres_urls[1]))
        statements = []

        def observe(_connection, _cursor, statement, _parameters, _context, _many):
            if "audio_chunk_reservation" in statement:
                statements.append(statement.split()[0])

        event.listen(provider.engine.sync_engine, "before_cursor_execute", observe)
        try:
            tenant, session, lease = await _capture(provider)

            # Mixed channels deliberately share sequence numbers; canonical
            # lookup must use both fields and preserve the requested order.
            def drafts(first):
                return [
                    _draft(
                        sequence_number=(first + i) // 2,
                        channel=CaptureChannel.MICROPHONE
                        if (first + i) % 2 == 0
                        else CaptureChannel.SYSTEM_AUDIO,
                    )
                    for i in range(count)
                ]

            initial = drafts(0)
            statements.clear()
            first = await _reserve(provider, tenant, session, lease, initial)
            first_cost = len(statements)
            assert [r.object_id for r in first.reservations] == [d.object_id for d in initial]
            canonical = {(r.channel, r.sequence_number): r for r in first.reservations}

            # Reverse input order and replace overlapping object IDs/AAD.
            # Existing positions must keep their original immutable records.
            overlap = list(reversed(drafts(count // 2)))
            statements.clear()
            second = await _reserve(provider, tenant, session, lease, overlap)
            overlap_cost = len(statements)
            for row, draft in zip(second.reservations, overlap, strict=True):
                position = (draft.channel, draft.sequence_number)
                assert (row.channel, row.sequence_number) == position
                if position in canonical:
                    assert row == canonical[position]
                else:
                    assert row.object_id == draft.object_id
                    canonical[position] = row

            statements.clear()
            recovered = await _reserve(provider, tenant, session, lease, overlap)
            recovery_cost = len(statements)
            assert recovered.reservations == second.reservations
            assert recovered.id != second.id
            record_property("reservation_statements", (first_cost, overlap_cost, recovery_cost))
            # An upper bound on database dispatches, independent of chunk count.
            # This catches a return to per-chunk insert/read/item operations.
            assert max(first_cost, overlap_cost, recovery_cost) <= 8
        finally:
            event.remove(provider.engine.sync_engine, "before_cursor_execute", observe)
            await provider.close()

    asyncio.run(scenario())


def test_bulk_reservation_conflict_rolls_back_every_position(postgres_urls):
    async def scenario():
        provider = build_postgres_provider(postgres_settings(postgres_urls[1]))
        try:
            tenant, session, lease = await _capture(provider)
            drafts = [_draft(sequence_number=i) for i in range(90)]
            drafts[45] = _draft(sequence_number=45, object_id=drafts[0].object_id)
            with pytest.raises(IntegrityError):
                await _reserve(provider, tenant, session, lease, drafts)
            async with provider.transaction(tenant) as store:
                usage = await store.capture_reservation_usage(tenant, session.id)
                assert usage.reservation_count == 0
            valid = [_draft(sequence_number=i) for i in range(90)]
            recovered = await _reserve(provider, tenant, session, lease, valid)
            assert [r.object_id for r in recovered.reservations] == [d.object_id for d in valid]
        finally:
            await provider.close()

    asyncio.run(scenario())
