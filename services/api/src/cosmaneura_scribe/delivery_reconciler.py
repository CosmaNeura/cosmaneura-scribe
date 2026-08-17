from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from .canonical_json import canonical_sha256
from .consent import ConsentError, ConsentPolicy
from .handoff import (
    HandoffConflictError,
    HandoffDisabledError,
    HandoffRejectedError,
    HandoffRetryableError,
    MasterPlatformHandoff,
    to_master_platform_payload_parts,
)
from .repository import (
    DeliveryClaimPolicy,
    DeliverySessionSyncResult,
    DeliverySuccessConflictError,
    RepositoryProvider,
)
from .safe_logging import log_event
from .schemas import (
    DeliveryAttempt,
    DeliveryStatus,
    MasterTranscriptDeliveryRequest,
    SessionStatus,
    TranscriptDelivery,
)


async def complete_delivery_failure(
    repositories: RepositoryProvider,
    *,
    tenant_id: UUID,
    attempted: DeliveryAttempt,
    failure_status: DeliveryStatus,
    error_code: str,
    audit_action: str,
) -> DeliveryAttempt:
    async with repositories.transaction(tenant_id) as store:
        failed = await store.complete_delivery_failure(
            tenant_id,
            attempted.id,
            expected_attempt_count=attempted.attempt_count,
            failure_status=failure_status,
            error_code=error_code,
        )
        if failed is not None:
            await store.audit(
                tenant_id=tenant_id,
                action=audit_action,
                entity_type="transcript_delivery",
                entity_id=attempted.id,
            )
            return failed
        current = await store.get_delivery_attempt(tenant_id, attempted.id)
        if current is None:
            raise RuntimeError("delivery receipt is unavailable")
        return current


async def complete_delivery_success(
    repositories: RepositoryProvider,
    *,
    tenant_id: UUID,
    attempted: DeliveryAttempt,
    platform_transcript_id: str,
) -> DeliveryAttempt:
    async with repositories.transaction(tenant_id) as store:
        completion = await store.complete_delivery_success(
            tenant_id,
            attempted.id,
            expected_payload_sha256=attempted.payload_sha256,
            platform_transcript_id=platform_transcript_id,
        )
        if completion is None:
            raise RuntimeError("delivery receipt is unavailable")
        delivered = completion.delivery
        if completion.changed:
            await store.audit(
                tenant_id=tenant_id,
                action="transcript.delivered",
                entity_type="transcript_delivery",
                entity_id=attempted.id,
            )

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
    delivery: DeliveryAttempt | TranscriptDelivery,
) -> bool:
    try:
        async with repositories.transaction(tenant_id) as store:
            result = await store.synchronize_delivery_session(
                tenant_id,
                delivery.session_id,
            )
            if result == DeliverySessionSyncResult.SESSION_UNAVAILABLE:
                log_event(
                    action="delivery.session_sync_skipped",
                    tenant_id=tenant_id,
                    entity_id=delivery.id,
                    error_class="SessionUnavailable",
                )
                return False
            if result in {
                DeliverySessionSyncResult.SYNCHRONIZED,
                DeliverySessionSyncResult.ALREADY_SYNCHRONIZED,
            }:
                return True
            if result == DeliverySessionSyncResult.SESSION_STATE_CONFLICT:
                log_event(
                    action="delivery.session_sync_skipped",
                    tenant_id=tenant_id,
                    entity_id=delivery.id,
                    error_class="SessionStateConflict",
                )
                return False
            raise RuntimeError("delivery session synchronization returned an invalid result")
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
        claim_policy: DeliveryClaimPolicy | None = None,
        maximum_deliveries: int = 25,
    ) -> None:
        if maximum_deliveries < 1 or maximum_deliveries > 100:
            raise ValueError("delivery reconciliation maximum must be between 1 and 100")
        self._repositories = repositories
        self._handoff = handoff
        self._consent_policy = consent_policy or ConsentPolicy()
        self._claim_policy = claim_policy or DeliveryClaimPolicy()
        self._maximum_deliveries = maximum_deliveries

    async def reconcile(
        self,
        *,
        tenant_id: UUID,
    ) -> DeliveryReconcileResult:
        claimed_count = 0
        delivered_count = 0
        retryable_count = 0
        terminal_count = 0
        skipped_count = 0
        attempted_delivery_ids: set[UUID] = set()
        for _ in range(self._maximum_deliveries):
            async with self._repositories.transaction(tenant_id) as store:
                attempt = await store.claim_delivery_attempt(
                    tenant_id,
                    policy=self._claim_policy,
                    excluded_delivery_ids=frozenset(attempted_delivery_ids),
                )
                if attempt is None:
                    break
            attempted_delivery_ids.add(attempt.id)
            claimed_count += 1
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
                    try:
                        outcome = await complete_delivery_success(
                            self._repositories,
                            tenant_id=tenant_id,
                            attempted=attempt,
                            platform_transcript_id=platform_result.transcript_id,
                        )
                    except DeliverySuccessConflictError:
                        async with self._repositories.transaction(tenant_id) as store:
                            await store.audit(
                                tenant_id=tenant_id,
                                action="transcript.delivery_success_conflict",
                                entity_type="transcript_delivery",
                                entity_id=attempt.id,
                            )
                        log_event(
                            action="delivery.success_conflict",
                            tenant_id=tenant_id,
                            entity_id=attempt.id,
                            error_class="DeliverySuccessConflict",
                        )
                        skipped_count += 1
                        continue

            if outcome.status == DeliveryStatus.DELIVERED:
                delivered_count += 1
            elif outcome.status == DeliveryStatus.RETRYABLE:
                retryable_count += 1
            elif outcome.status == DeliveryStatus.TERMINAL:
                terminal_count += 1
            else:
                skipped_count += 1

        return DeliveryReconcileResult(
            claimed=claimed_count,
            delivered=delivered_count,
            retryable=retryable_count,
            terminal=terminal_count,
            skipped=skipped_count,
        )

    async def _prepare_payload(
        self,
        *,
        tenant_id: UUID,
        attempt: DeliveryAttempt,
    ) -> tuple[MasterTranscriptDeliveryRequest | None, str | None]:
        async with self._repositories.transaction(tenant_id) as store:
            source = await store.delivery_payload_source(tenant_id, attempt.session_id)
            session = source.session
            if session is None:
                return None, "session_unavailable"
            if session.status not in {
                SessionStatus.TRANSCRIPT_READY,
                SessionStatus.HANDED_OFF,
            }:
                return None, "session_not_deliverable"
            consent = source.consent
            if consent is None:
                return None, "consent_unavailable"
            if consent.id != session.consent_record_id:
                return None, "consent_invalid"
            try:
                self._consent_policy.validate_delivery_source(consent, session)
            except ConsentError:
                return None, "consent_invalid"
            transcript = source.transcript
            if transcript is None:
                return None, "transcript_unavailable"
            if transcript.session_id != attempt.session_id:
                return None, "transcript_unavailable"
            try:
                payload = to_master_platform_payload_parts(
                    encounter_id=session.appointment_id,
                    session_id=session.id,
                    segments=transcript.segments,
                )
            except ValueError:
                return None, "payload_invalid"
            if canonical_sha256(payload) != attempt.payload_sha256:
                return None, "payload_mismatch"
            return payload, None
