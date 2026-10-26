"""Expiring metadata scope; never a consent, tenant or processing authority."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast
from uuid import UUID

from .safe_logging import log_speech_boundary
from .speech_observation import SpeechBoundaryObservation

if TYPE_CHECKING:
    from .transcription import SpeechObserver, SpeechObserverFactory, TranscriptionRequest


def capture_speech_observer(
    raw: str | None,
    *,
    tenant_id: UUID,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> SpeechObserverFactory | None:
    """Invalid/missing scopes disable only observation, including during startup."""
    try:
        if raw is None or len(raw.encode()) > 1024:
            return None

        def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
            result: dict[str, object] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("speech_observation_scope_invalid")
                result[key] = value
            return result

        decoded: object = json.loads(raw, object_pairs_hook=unique)
        if not isinstance(decoded, dict):
            return None
        value = cast(dict[str, object], decoded)
        if set(value) != {
            "version",
            "tenant_id",
            "session_id",
            "consent_record_id",
            "issued_at",
            "expires_at",
        }:
            return None
        if type(value["version"]) is not int or value["version"] != 1:
            return None

        def string(key: str) -> str:
            result = value[key]
            if not isinstance(result, str):
                raise ValueError("speech_observation_scope_invalid")
            return result

        identifiers = tuple(
            UUID(string(key)) for key in ("tenant_id", "session_id", "consent_record_id")
        )
        if any(identifier.int == 0 for identifier in identifiers) or identifiers[0] != tenant_id:
            return None
        issued, expires = (
            datetime.fromisoformat(string(key)) for key in ("issued_at", "expires_at")
        )
        if issued.utcoffset() != timedelta(0) or expires.utcoffset() != timedelta(0):
            return None
        if not timedelta(0) < expires - issued <= timedelta(hours=1):
            return None
        if not issued <= clock() < expires:
            return None
        digest = hashlib.sha256(raw.encode()).hexdigest()

        def for_request(request: TranscriptionRequest) -> SpeechObserver | None:
            if (request.session_id, request.consent_record_id) != identifiers[1:]:
                return None
            if not issued <= clock() < expires:
                return None

            def observe(observation: SpeechBoundaryObservation) -> None:
                # The provider response can arrive after expiry. In that case
                # publication proceeds normally and this diagnostic stays silent.
                now = clock()
                if not issued <= now < expires:
                    return
                log_speech_boundary(
                    tenant_id=tenant_id,
                    session_id=request.session_id,
                    consent_record_id=request.consent_record_id,
                    scope_sha256=digest,
                    observed_at_ms=int(now.timestamp() * 1000),
                    observation=observation,
                )

            return observe

        return for_request
    except Exception:
        return None
