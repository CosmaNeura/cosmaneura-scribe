"""Append-only renewal chain with the original native stop owner unchanged."""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID, uuid4

from sqlalchemy import text

from .repository import IdempotencyClaimUnavailableError, IdempotencyConflictError
from .source_extension_contract import (
    SourceExtensionCapability,
    SourceExtensionIntent,
    SourceExtensionReceipt,
)
from .source_start_runtime import (
    SourceStartConflict,
    SourceStartRepository,
    SourceStartRepositoryProvider,
    SourceStartUnavailable,
)


class SourceExtensionRepository(SourceStartRepository):
    async def extend(
        self, tenant: UUID, session_id: UUID, actor: str, key: str, intent: SourceExtensionIntent
    ) -> SourceExtensionCapability:
        session = await self.lock_live_capture(tenant, session_id)
        if session.creator_actor_id != actor or session.status.value not in {
            "created",
            "capturing",
        }:
            raise SourceStartUnavailable()
        await self._lock_attempt(tenant, intent.owner.attempt_id)
        owner = await self._one_or_none(
            "SELECT * FROM source_start_attempts WHERE tenant_id = :tenant "
            "AND attempt_id = :attempt FOR UPDATE",
            tenant=tenant,
            attempt=intent.owner.attempt_id,
        )
        if (
            owner is None
            or owner["state"] != "issued"
            or owner["consent_record_id"] != session.consent_record_id
        ):
            raise SourceStartUnavailable()
        self._match(owner, session_id, actor, intent.owner)
        context = await self.lock_capture_context(tenant, session_id)
        receipt = await self.get_capture_lease_receipt(tenant, intent.lease_receipt_id)
        now = await self._now()
        if (
            context is None
            or context.audio_key is None
            or context.lease is None
            or context.lease.closed_at is not None
            or context.lease.lease_id != intent.owner.lease_id
            or context.lease.generation != intent.lease_generation
            or context.lease.expires_at != intent.capture_authorized_until
            or intent.capture_authorized_until <= now
            or receipt is None
            or receipt.session_id != session_id
            or receipt.lease_id != intent.owner.lease_id
            or receipt.generation != intent.lease_generation
            or receipt.expires_at != intent.capture_authorized_until
        ):
            raise SourceStartUnavailable()
        fingerprint = intent.fingerprint(session_id, actor)
        existing = await self._one_or_none(
            "SELECT * FROM source_start_extensions WHERE tenant_id = :tenant "
            "AND source_start_id = :owner AND lease_generation = :generation",
            tenant=tenant,
            owner=owner["id"],
            generation=intent.lease_generation,
        )
        extension_id = existing["id"] if existing else uuid4()
        replay = await self.claim_idempotency(
            tenant_id=tenant,
            operation="source_start.extend",
            key=key,
            request_fingerprint=fingerprint,
            entity_id=extension_id,
        )
        if replay is not None and (existing is None or replay != extension_id):
            raise SourceStartConflict()
        if existing is not None:
            if existing["request_sha256"] != fingerprint:
                raise SourceStartConflict()
        else:
            prior = await self._one_or_none(
                "SELECT * FROM source_start_extensions WHERE tenant_id = :tenant "
                "AND source_start_id = :owner ORDER BY lease_generation DESC LIMIT 1",
                tenant=tenant,
                owner=owner["id"],
            )
            previous_id = prior["id"] if prior else None
            previous_generation = prior["lease_generation"] if prior else owner["lease_generation"]
            previous_deadline = (
                prior["capture_authorized_until"] if prior else owner["capture_authorized_until"]
            )
            if (
                previous_id != intent.previous_extension_id
                or intent.lease_generation != previous_generation + 1
                or previous_deadline <= now
                or intent.capture_authorized_until <= previous_deadline
            ):
                raise SourceStartConflict()
            params = dict(
                tenant=tenant,
                session=session_id,
                id=extension_id,
                owner=owner["id"],
                previous=previous_id,
                lease=intent.owner.lease_id,
                receipt=intent.lease_receipt_id,
                generation=intent.lease_generation,
                previous_deadline=previous_deadline,
                deadline=intent.capture_authorized_until,
                batch=intent.reservation_batch_id,
                first=intent.first_sequence_number,
                last=intent.first_sequence_number + intent.reservation_count - 1,
                issued=now,
                expires=min(now + timedelta(seconds=15), previous_deadline),
                capability=uuid4(),
                fingerprint=fingerprint,
            )
            existing = dict(
                (
                    await self._session.execute(
                        text("""
                INSERT INTO source_start_extensions (tenant_id, session_id, id, source_start_id,
                    previous_extension_id, lease_id, lease_receipt_id, lease_generation,
                    previous_capture_authorized_until, capture_authorized_until,
                    reservation_batch_id,
                    first_sequence_number, maximum_sequence_number, issued_at, expires_at,
                    capability_id, request_sha256)
                VALUES (:tenant, :session, :id, :owner, :previous, :lease, :receipt, :generation,
                    :previous_deadline, :deadline, :batch, :first, :last, :issued, :expires,
                    :capability, :fingerprint) RETURNING *
            """),
                        params,
                    )
                )
                .mappings()
                .one()
            )
            await self._audit(tenant, "extended", extension_id)
        # The original response remains fixed on replay, including its short expiry.
        if existing["expires_at"] <= await self._now():
            raise SourceStartConflict()
        fields = {
            name: existing[name] for name in SourceExtensionReceipt.model_fields if name in existing
        }
        fields.update(
            extension_id=existing["id"],
            attempt_id=owner["attempt_id"],
            creator_actor_id=owner["creator_actor_id"],
            consent_record_id=owner["consent_record_id"],
            source=owner["source"],
        )
        return SourceExtensionCapability(
            receipt=SourceExtensionReceipt.model_validate(fields), secret=intent.owner.owner_proof
        )


class SourceExtensionRepositoryProvider(SourceStartRepositoryProvider):
    repository_type = SourceExtensionRepository


class SourceExtensionRuntime:
    def __init__(
        self,
        repositories: SourceExtensionRepositoryProvider,
        *,
        tenant_ids: frozenset[UUID],
        enabled: bool = False,
    ) -> None:
        self.repositories, self.tenant_ids, self.enabled = repositories, tenant_ids, enabled is True

    async def extend(
        self, tenant: UUID, session: UUID, actor: str, key: str, intent: SourceExtensionIntent
    ) -> SourceExtensionCapability:
        if not self.enabled or tenant not in self.tenant_ids or not 8 <= len(key) <= 255:
            raise SourceStartUnavailable()
        conflict = False
        try:
            async with self.repositories.transaction(tenant) as store:
                if not isinstance(store, SourceExtensionRepository):
                    raise SourceStartUnavailable()
                result = await store.extend(tenant, session, actor, key, intent)
            return result  # Commit before returning any capability.
        except (SourceStartConflict, IdempotencyConflictError, IdempotencyClaimUnavailableError):
            conflict = True
        except Exception:
            pass
        if conflict:
            raise SourceStartConflict()
        raise SourceStartUnavailable()
