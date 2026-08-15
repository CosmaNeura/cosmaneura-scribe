from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from .canonical_json import canonical_sha256
from .consent import ConsentError, ConsentPolicy
from .handoff import (
    HandoffConflictError,
    HandoffDisabledError,
    HandoffRejectedError,
    HandoffRetryableError,
    MasterPlatformHandoff,
    to_master_platform_payload,
)
from .repository import RepositoryProvider
from .safe_logging import log_event
from .schemas import (
    DeliveryStatus,
    MasterTranscriptDeliveryRequest,
    SessionStatus,
    TranscriptDelivery,
)
from .session_state_v1 import can_transition_session


async def complete_delivery_failure(
    repositories: RepositoryProvider,
    *,
    tenant_id: UUID,
    attempted: TranscriptDelivery,
    failure_status: DeliveryStatus,
    error_code: str,
    audit_action: str,
    now: datetime | None = None,
) -> TranscriptDelivery:
    completed_at = now or datetime.now(UTC)
    async with repositories.transaction(tenant_id) as store:
        failed = await store.complete_delivery_failure(
            tenant_id,
            attempted.id,
            expected_attempt_count=attempted.attempt_count,
            failure_status=failure_status,
            error_code=error_code,
            now=completed_at,
        )
        if failed is not None:
            await store.audit(
                tenant_id=tenant_id,
                action=audit_action,
                entity_type="transcript_delivery",
                entity_id=attempted.id,
            )
            return failed
        current = await store.get_delivery(tenant_id, attempted.id)
        if current is None:
            raise RuntimeError("delivery receipt is unavailable")
        return current


async def complete_delivery_success(
    repositories: RepositoryProvider,
    *,
    tenant_id: UUID,
    attempted: TranscriptDelivery,
    platform_transcript_id: str,
    now: datetime | None = None,
) -> TranscriptDelivery:
    completed_at = now or datetime.now(UTC)
    async with repositories.transaction(tenant_id) as store:
        delivered = await store.complete_delivery_success(
            tenant_id,
            attempted.id,
            platform_transcript_id=platform_transcript_id,
            now=completed_at,
        )
        if delivered is not None:
            await store.audit(
                tenant_id=tenant_id,
                action="transcript.delivered",
                entity_type="transcript_delivery",
                entity_id=attempted.id,
            )
        else:
            delivered = await store.get_delivery(tenant_id, attempted.id)
            if delivered is None:
                raise RuntimeError("delivery receipt is unavailable")

    await synchronize_delivery_session(
        repositories,
        tenant_id=tenant_id,
        delivery=delivered,
    )
    return delivered


async def synchronize_delivery_session(
    repositories: RepositoryProvider,
    *,
    tenant_id: UUID,
    delivery: TranscriptDelivery,
) -> bool:
    try:
        async with repositories.transaction(tenant_id) as store:
            session = await store.lock_session(tenant_id, delivery.session_id)
            if session is None:
                log_event(
                    action="delivery.session_sync_skipped",
                    tenant_id=tenant_id,
                    entity_id=delivery.id,
                    error_class="SessionUnavailable",
                )
                return False
            if session.status == SessionStatus.HANDED_OFF:
                return True
            if not can_transition_session(session.status, SessionStatus.HANDED_OFF):
                log_event(
                    action="delivery.session_sync_skipped",
                    tenant_id=tenant_id,
                    entity_id=delivery.id,
                    error_class="SessionStateConflict",
                )
                return False
            await store.update_session(
                tenant_id,
                session.model_copy(update={"status": SessionStatus.HANDED_OFF}),
            )
            await store.audit(
                tenant_id=tenant_id,
                action="transcript.delivery_session_synchronized",
                entity_type="scribe_session",
                entity_id=session.id,
            )
            return True
    except Exception as exc:
        log_event(
            action="delivery.session_sync_failed",
            tenant_id=tenant_id,
            entity_id=delivery.id,
            error_class=type(exc).__name__,
        )
        return False


@dataclass(frozen=True)
class DeliveryReconcileResult:
    claimed: int
    delivered: int
    retryable: int
    terminal: int
    skipped: int


class DeliveryReconciler:
    """Retry a bounded tenant-scoped batch of durable delivery receipts."""

    def __init__(
        self,
        *,
        repositories: RepositoryProvider,
        handoff: MasterPlatformHandoff,
        consent_policy: ConsentPolicy | None = None,
    ) -> None:
        self._repositories = repositories
        self._handoff = handoff
        self._consent_policy = consent_policy or ConsentPolicy()

    async def reconcile(
        self,
        *,
        tenant_id: UUID,
        stale_before: datetime,
        limit: int = 25,
        now: datetime | None = None,
    ) -> DeliveryReconcileResult:
        if limit < 1 or limit > 100:
            raise ValueError("delivery reconciliation limit must be between 1 and 100")
        claimed_at = now or datetime.now(UTC)
        async with self._repositories.transaction(tenant_id) as store:
            claimed = await store.claim_stale_deliveries(
                tenant_id,
                stale_before=stale_before,
                now=claimed_at,
                limit=limit,
            )
            for attempt in claimed:
                await store.audit(
                    tenant_id=tenant_id,
                    action="transcript.delivery_attempted",
                    entity_type="transcript_delivery",
                    entity_id=attempt.id,
                )

        delivered_count = 0
        retryable_count = 0
        terminal_count = 0
        skipped_count = 0
        for attempt in claimed:
            payload, preparation_error = await self._prepare_payload(
                tenant_id=tenant_id,
                attempt=attempt,
            )
            if preparation_error is not None:
                outcome = await complete_delivery_failure(
                    self._repositories,
                    tenant_id=tenant_id,
                    attempted=attempt,
                    failure_status=DeliveryStatus.TERMINAL,
                    error_code=preparation_error,
                    audit_action="transcript.delivery_rejected",
                )
            else:
                assert payload is not None
                try:
                    platform_result = await self._handoff.deliver(
                        payload,
                        idempotency_key=attempt.idempotency_key,
                    )
                except (HandoffDisabledError, HandoffRetryableError) as exc:
                    outcome = await complete_delivery_failure(
                        self._repositories,
                        tenant_id=tenant_id,
                        attempted=attempt,
                        failure_status=DeliveryStatus.RETRYABLE,
                        error_code=exc.code,
                        audit_action="transcript.delivery_retryable",
                    )
                except (HandoffConflictError, HandoffRejectedError) as exc:
                    outcome = await complete_delivery_failure(
                        self._repositories,
                        tenant_id=tenant_id,
                        attempted=attempt,
                        failure_status=DeliveryStatus.TERMINAL,
                        error_code=exc.code,
                        audit_action="transcript.delivery_rejected",
                    )
                else:
                    outcome = await complete_delivery_success(
                        self._repositories,
                        tenant_id=tenant_id,
                        attempted=attempt,
                        platform_transcript_id=platform_result.transcript_id,
                    )

            if outcome.status == DeliveryStatus.DELIVERED:
                delivered_count += 1
            elif outcome.status == DeliveryStatus.RETRYABLE:
                retryable_count += 1
            elif outcome.status == DeliveryStatus.TERMINAL:
                terminal_count += 1
            else:
                skipped_count += 1

        return DeliveryReconcileResult(
            claimed=len(claimed),
            delivered=delivered_count,
            retryable=retryable_count,
            terminal=terminal_count,
            skipped=skipped_count,
        )

    async def _prepare_payload(
        self,
        *,
        tenant_id: UUID,
        attempt: TranscriptDelivery,
    ) -> tuple[MasterTranscriptDeliveryRequest | None, str | None]:
        async with self._repositories.transaction(tenant_id) as store:
            session = await store.lock_session(tenant_id, attempt.session_id)
            if session is None:
                return None, "session_unavailable"
            if session.status not in {
                SessionStatus.TRANSCRIPT_READY,
                SessionStatus.HANDED_OFF,
            }:
                return None, "session_not_deliverable"
            consent = await store.get_consent(tenant_id, session.consent_record_id)
            if consent is None:
                return None, "consent_unavailable"
            try:
                self._consent_policy.validate_session(consent, session)
            except ConsentError:
                return None, "consent_invalid"
            transcript = await store.transcript_for(tenant_id, attempt.session_id)
            if transcript is None:
                return None, "transcript_unavailable"
            try:
                payload = to_master_platform_payload(session, transcript)
            except ValueError:
                return None, "payload_invalid"
            if canonical_sha256(payload) != attempt.payload_sha256:
                return None, "payload_mismatch"
            return payload, None
