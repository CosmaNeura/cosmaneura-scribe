"""Durable source-start ownership. No provider call, native source or startup hook.

An issued decision is an unconfirmed physical start, never a stopped recording.
Only the same live native process may recover its fixed, short-lived response.
"""

from __future__ import annotations

import hmac
import re
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from .captured_source_runtime import CapturedSourceRepository
from .repository import IdempotencyClaimUnavailableError, IdempotencyConflictError
from .source_start_contract import (
    SourceStartCapability,
    SourceStartIntent,
    SourceStartReceipt,
    SourceStartRetirementReceipt,
    StartAction,
)


class SourceStartUnavailable(RuntimeError):
    def __init__(self) -> None:
        super().__init__("source_start_unavailable")


class SourceStartConflict(RuntimeError):
    def __init__(self) -> None:
        super().__init__("source_start_conflict")


class SourceStartRepository(CapturedSourceRepository):
    async def act(
        self,
        tenant_id: UUID,
        session_id: UUID,
        actor: str,
        key: str,
        action: StartAction,
        intent: SourceStartIntent,
    ) -> SourceStartReceipt | SourceStartCapability | SourceStartRetirementReceipt:
        # Same consent advisory lock and session row lock as revocation, admission,
        # chunk uploads and lease renewal. Acquire before idempotency to avoid the
        # source-start path inverting the existing capture-context lock order.
        if action == "stop":
            return await self._stop(tenant_id, session_id, actor, key, intent)
        session = await self.lock_live_capture(tenant_id, session_id)
        if session.creator_actor_id != actor or session.status.value != "created":
            raise SourceStartUnavailable()
        await self._lock_attempt(tenant_id, intent.attempt_id)
        if await self._one_or_none(
            "SELECT id FROM source_start_retirements "
            "WHERE tenant_id = :tenant AND attempt_id = :attempt",
            tenant=tenant_id, attempt=intent.attempt_id,
        ) is not None:
            raise SourceStartConflict()
        context = await self.lock_capture_context(tenant_id, session_id)
        receipt = await self.get_capture_lease_receipt(tenant_id, intent.lease_receipt_id)
        if context is None or context.audio_key is None or context.lease is None:
            raise SourceStartUnavailable()
        lease = context.lease
        if (
            lease.closed_at is not None
            or lease.lease_id != intent.lease_id
            or lease.generation != intent.lease_generation
            or lease.expires_at != intent.capture_authorized_until
            or receipt is None
            or receipt.session_id != session_id
            or receipt.lease_id != lease.lease_id
            or receipt.generation != lease.generation
            or receipt.expires_at != lease.expires_at
        ):
            raise SourceStartUnavailable()
        reserved = await self._session.scalar(
            text("""
            SELECT EXISTS (
                SELECT 1 FROM audio_chunk_reservation_batches AS b
                JOIN audio_chunk_reservation_batch_items AS i
                    ON i.tenant_id = b.tenant_id AND i.batch_id = b.id
                    AND i.session_id = b.session_id
                JOIN audio_chunk_reservations AS r
                    ON r.tenant_id = i.tenant_id AND r.object_id = i.object_id
                    AND r.session_id = i.session_id
                WHERE b.tenant_id = :tenant AND b.session_id = :session
                    AND b.lease_id = :lease AND b.lease_generation = :generation
                    AND b.capture_authorized_until = :deadline
                    AND r.channel = :channel AND r.sequence_number = :first_sequence
            )
        """),
            {
                "tenant": tenant_id,
                "session": session_id,
                "lease": lease.lease_id,
                "generation": lease.generation,
                "deadline": lease.expires_at,
                "channel": "mixed" if intent.source == "desktop_companion" else "microphone",
                "first_sequence": intent.first_sequence_number,
            },
        )
        if not reserved:
            raise SourceStartUnavailable()

        existing = await self._one_or_none(
            """
            SELECT * FROM source_start_attempts
            WHERE tenant_id = :tenant_id AND attempt_id = :attempt_id
        """,
            tenant_id=tenant_id,
            attempt_id=intent.attempt_id,
        )
        start_id = UUID(str(existing["id"])) if existing else uuid4()
        previous = await self.claim_idempotency(
            tenant_id=tenant_id,
            operation=f"source_start.{action}",
            key=key,
            request_fingerprint=intent.fingerprint(session_id, actor),
            entity_id=start_id,
        )
        if previous is not None and (existing is None or previous != start_id):
            raise SourceStartConflict()
        now = await self._now()
        if lease.expires_at <= now:
            raise SourceStartUnavailable()
        if existing is not None:
            self._match(existing, session_id, actor, intent)
        if action == "prepare":
            if existing is None:
                # Only an unissued reservation can expire. Issued ownership is
                # retained even after capability/lease expiry or a lost response.
                expired = (
                    await self._session.execute(
                        text("""
                    UPDATE source_start_attempts SET state = 'expired'
                    WHERE tenant_id = :tenant AND session_id = :session
                        AND state = 'prepared' AND preparation_expires_at <= :now
                    RETURNING id
                """),
                        {"tenant": tenant_id, "session": session_id, "now": now},
                    )
                ).scalars()
                for expired_id in expired:
                    await self._audit(tenant_id, "expired", expired_id)
                occupied = await self._session.scalar(
                    text("""
                    SELECT id FROM source_start_attempts
                    WHERE tenant_id = :tenant AND session_id = :session
                        AND state IN ('prepared', 'issued')
                """),
                    {"tenant": tenant_id, "session": session_id},
                )
                if occupied is not None:
                    raise SourceStartConflict()
                params = dict(
                    tenant_id=tenant_id,
                    session_id=session_id,
                    id=start_id,
                    attempt_id=intent.attempt_id,
                    creator_actor_id=actor,
                    consent_record_id=session.consent_record_id,
                    source=intent.source,
                    owner_proof_sha256=intent.proof_digest,
                    lease_id=intent.lease_id,
                    lease_receipt_id=intent.lease_receipt_id,
                    lease_generation=intent.lease_generation,
                    capture_authorized_until=lease.expires_at,
                    prepared_at=now,
                    preparation_expires_at=min(now + timedelta(minutes=2), lease.expires_at),
                    capability_id=uuid4(),
                    first_sequence_number=intent.first_sequence_number,
                )
                existing = dict(
                    (
                        await self._session.execute(
                            text("""
                    INSERT INTO source_start_attempts (
                        tenant_id, session_id, id, attempt_id, creator_actor_id,
                        consent_record_id, source, owner_proof_sha256, lease_id,
                        lease_receipt_id, lease_generation, capture_authorized_until,
                        prepared_at, preparation_expires_at, capability_id, first_sequence_number
                    ) VALUES (
                        :tenant_id, :session_id, :id, :attempt_id, :creator_actor_id,
                        :consent_record_id, :source, :owner_proof_sha256, :lease_id,
                        :lease_receipt_id, :lease_generation, :capture_authorized_until,
                        :prepared_at, :preparation_expires_at,
                        :capability_id, :first_sequence_number
                    ) RETURNING *
                """),
                            params,
                        )
                    )
                    .mappings()
                    .one()
                )
                await self._audit(tenant_id, "prepared", start_id)
            return self._receipt(existing)
        if existing is None:
            raise SourceStartConflict()
        if action == "cancel":
            if existing["state"] == "prepared":
                existing = await self._transition(tenant_id, start_id, "cancelled", now)
                await self._audit(tenant_id, "cancelled", start_id)
            elif existing["state"] != "cancelled":
                raise SourceStartConflict()
            return self._receipt(existing)
        if existing["state"] == "prepared":
            if existing["preparation_expires_at"] <= now:
                raise SourceStartConflict()
            existing = await self._transition(tenant_id, start_id, "issued", now)
            await self._audit(tenant_id, "issued", start_id)
        elif existing["state"] != "issued":
            raise SourceStartConflict()
        # Do not refresh timestamps/capability IDs on replay. Recheck the database
        # clock after the write and before exposing a capability, not a caller clock.
        if existing["expires_at"] <= await self._now():
            raise SourceStartConflict()
        return SourceStartCapability(receipt=self._receipt(existing), secret=intent.owner_proof)

    async def _stop(
        self,
        tenant_id: UUID,
        session_id: UUID,
        actor: str,
        key: str,
        intent: SourceStartIntent,
    ) -> SourceStartReceipt | SourceStartRetirementReceipt:
        # This records native-confirmed cessation, not permission to capture.
        # Retain the usual consent -> session -> owner -> idempotency lock order,
        # but do not require a live lease/session/consent to retire its old owner.
        reference = await self._one_or_none(
            "SELECT consent_record_id FROM scribe_sessions "
            "WHERE tenant_id = :tenant AND id = :session",
            tenant=tenant_id,
            session=session_id,
        )
        if reference is None:
            raise SourceStartUnavailable()
        await self._lock_consent_scope(tenant_id, reference["consent_record_id"])
        session = await self._one_or_none(
            "SELECT creator_actor_id, consent_record_id FROM scribe_sessions "
            "WHERE tenant_id = :tenant AND id = :session FOR UPDATE",
            tenant=tenant_id,
            session=session_id,
        )
        if (
            session is None
            or session["creator_actor_id"] != actor
            or session["consent_record_id"] != reference["consent_record_id"]
        ):
            raise SourceStartUnavailable()
        await self._lock_attempt(tenant_id, intent.attempt_id)
        row = await self._one_or_none(
            "SELECT * FROM source_start_attempts "
            "WHERE tenant_id = :tenant AND attempt_id = :attempt FOR UPDATE",
            tenant=tenant_id,
            attempt=intent.attempt_id,
        )
        if row is None:
            return await self._retire_unstarted(
                tenant_id, session_id, actor, key, intent, session["consent_record_id"]
            )
        if row["consent_record_id"] != session["consent_record_id"]:
            raise SourceStartConflict()
        self._match(row, session_id, actor, intent)
        start_id = UUID(str(row["id"]))
        previous = await self.claim_idempotency(
            tenant_id=tenant_id,
            operation="source_start.stop",
            key=key,
            request_fingerprint=intent.fingerprint(session_id, actor),
            entity_id=start_id,
        )
        if previous is not None and previous != start_id:
            raise SourceStartConflict()
        if row["state"] == "issued":
            row = dict(
                (
                    await self._session.execute(
                        text("""
                UPDATE source_start_attempts SET state = 'stopped', stopped_at = clock_timestamp()
                WHERE tenant_id = :tenant AND id = :id AND state = 'issued' RETURNING *
            """),
                        {"tenant": tenant_id, "id": start_id},
                    )
                )
                .mappings()
                .one()
            )
            await self._audit(tenant_id, "stopped", start_id)
        elif row["state"] == "prepared":
            row = await self._transition(tenant_id, start_id, "cancelled", await self._now())
            await self._audit(tenant_id, "cancelled", start_id)
        elif row["state"] not in {"stopped", "cancelled", "expired"}:
            raise SourceStartConflict()
        return self._receipt(row)

    async def _lock_attempt(self, tenant_id: UUID, attempt_id: UUID) -> None:
        await self._session.execute(text(
            "SELECT pg_advisory_xact_lock(hashtextextended('scribe-native-attempt:' "
            "|| CAST(:tenant AS text) || ':' || CAST(:attempt AS text), 0))"
        ), {"tenant": str(tenant_id), "attempt": str(attempt_id)})

    async def _retire_unstarted(
        self, tenant_id: UUID, session_id: UUID, actor: str, key: str,
        intent: SourceStartIntent, consent_record_id: UUID,
    ) -> SourceStartRetirementReceipt:
        row = await self._one_or_none(
            "SELECT * FROM source_start_retirements "
            "WHERE tenant_id = :tenant AND attempt_id = :attempt",
            tenant=tenant_id, attempt=intent.attempt_id,
        )
        if row is None:
            # The database checks immutable historical receipt/reservation scope
            # and the same attempt lock used by every start. No live preparation
            # or backdated timestamps/capability are manufactured.
            params = dict(
                tenant=tenant_id, session=session_id, id=uuid4(), attempt=intent.attempt_id,
                actor=actor, consent=consent_record_id, source=intent.source,
                proof=intent.proof_digest, lease=intent.lease_id, receipt=intent.lease_receipt_id,
                generation=intent.lease_generation, deadline=intent.capture_authorized_until,
                position=intent.first_sequence_number)
            row = dict((await self._session.execute(text("""
                INSERT INTO source_start_retirements (
                    tenant_id, session_id, id, attempt_id, creator_actor_id, consent_record_id,
                    source, owner_proof_sha256, lease_id, lease_receipt_id, lease_generation,
                    capture_authorized_until, first_sequence_number
                ) VALUES (:tenant, :session, :id, :attempt, :actor, :consent, :source, :proof,
                    :lease, :receipt, :generation, :deadline, :position) RETURNING *
            """), params)).mappings().one())
            await self.audit(tenant_id=tenant_id, action="source_start.retired_unstarted",
                entity_type="source_retirement", entity_id=row["id"])
        self._match(row, session_id, actor, intent)
        if row["consent_record_id"] != consent_record_id:
            raise SourceStartConflict()
        previous = await self.claim_idempotency(tenant_id=tenant_id, operation="source_start.stop",
            key=key, request_fingerprint=intent.fingerprint(session_id, actor), entity_id=row["id"])
        if previous is not None and previous != row["id"]:
            raise SourceStartConflict()
        return SourceStartRetirementReceipt.model_validate({
            key: row["id" if key == "retirement_id" else key]
            for key in SourceStartRetirementReceipt.model_fields
            if key not in {"schema_version", "state"}
        })

    async def _transition(
        self,
        tenant_id: UUID,
        start_id: UUID,
        state: str,
        now: datetime,
    ) -> dict[str, Any]:
        row = (
            (
                await self._session.execute(
                    text("""
            UPDATE source_start_attempts SET state = CAST(:state AS varchar),
                issued_at = CASE WHEN CAST(:state AS varchar) = 'issued'
                    THEN CAST(:now AS timestamptz) END,
                expires_at = CASE WHEN CAST(:state AS varchar) = 'issued'
                    THEN LEAST(CAST(:now AS timestamptz) + INTERVAL '15 seconds',
                               capture_authorized_until) END
            WHERE tenant_id = :tenant AND id = :id AND state = 'prepared'
            RETURNING *
        """),
                    {"tenant": tenant_id, "id": start_id, "state": state, "now": now},
                )
            )
            .mappings()
            .one()
        )
        return dict(row)

    async def _now(self) -> datetime:
        now = await self._session.scalar(text("SELECT clock_timestamp()"))
        if not isinstance(now, datetime):
            raise SourceStartUnavailable()
        return now

    async def _audit(self, tenant_id: UUID, action: str, start_id: UUID) -> None:
        await self.audit(
            tenant_id=tenant_id,
            action=f"source_start.{action}",
            entity_type="source_start",
            entity_id=start_id,
        )

    @staticmethod
    def _match(
        row: dict[str, Any],
        session_id: UUID,
        actor: str,
        intent: SourceStartIntent,
    ) -> None:
        if (
            row["session_id"] != session_id
            or row["creator_actor_id"] != actor
            or row["source"] != intent.source
            or row["lease_id"] != intent.lease_id
            or row["lease_receipt_id"] != intent.lease_receipt_id
            or row["lease_generation"] != intent.lease_generation
            or row["capture_authorized_until"] != intent.capture_authorized_until
            or row["first_sequence_number"] != intent.first_sequence_number
            or not hmac.compare_digest(row["owner_proof_sha256"], intent.proof_digest)
        ):
            raise SourceStartConflict()

    @staticmethod
    def _receipt(row: dict[str, Any]) -> SourceStartReceipt:
        return SourceStartReceipt.model_validate(
            {
                key: row["id" if key == "source_start_id" else key]
                for key in SourceStartReceipt.model_fields
                if key != "schema_version"
            }
        )


class SourceStartRepositoryProvider:
    """Borrows the explicitly supplied existing engine; never closes its owner."""

    def __init__(self, engine: AsyncEngine) -> None:
        self._sessions = async_sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def transaction(self, tenant_id: UUID) -> AsyncGenerator[SourceStartRepository]:
        async with self._sessions() as session, session.begin():
            await session.execute(text("SET LOCAL lock_timeout = '5s'"))
            await session.execute(text("SET LOCAL statement_timeout = '10s'"))
            await session.execute(
                text("SELECT set_config('app.tenant_id', :tenant, true)"),
                {"tenant": str(tenant_id)},
            )
            yield SourceStartRepository(session)


class SourceStartRuntime:
    def __init__(
        self,
        repositories: SourceStartRepositoryProvider,
        *,
        tenant_ids: frozenset[UUID],
        enabled: bool = False,
    ) -> None:
        self.repositories, self.tenant_ids, self.enabled = repositories, tenant_ids, enabled is True

    async def act(
        self,
        tenant_id: UUID,
        session_id: UUID,
        actor: str,
        key: str,
        action: StartAction,
        intent: SourceStartIntent,
    ) -> SourceStartReceipt | SourceStartCapability | SourceStartRetirementReceipt:
        if (
            not self.enabled
            or tenant_id not in self.tenant_ids
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", actor) is None
            or not 8 <= len(key) <= 255
            or action not in {"prepare", "authorize", "cancel", "stop"}
        ):
            raise SourceStartUnavailable()
        conflict = False
        try:
            async with self.repositories.transaction(tenant_id) as store:
                result = await store.act(tenant_id, session_id, actor, key, action, intent)
            # Transaction commit precedes delivery. Rollback/commit failure never
            # leaks a decision that was not durably recorded.
            return result
        except (SourceStartConflict, IdempotencyConflictError, IdempotencyClaimUnavailableError):
            conflict = True
        except Exception:
            pass
        if conflict:
            raise SourceStartConflict()
        raise SourceStartUnavailable()
