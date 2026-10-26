from __future__ import annotations

import json
import logging
import math
import re
from typing import TYPE_CHECKING, TextIO
from uuid import UUID

from .speech_observation import SpeechBoundaryObservation

if TYPE_CHECKING:
    from .external_transcript_v1 import NormalizedSourceTranscriptReceiptV1
    from .transcription import SttResult

LOGGER_NAME = "cosmaneura_scribe"
LOG_FIELD_ALLOWLIST = frozenset({"action", "entity_id", "tenant_id", "error_class", "duration_ms"})
PRIVATE_API_ACCEPTANCE_RESULT_FIELD_ALLOWLIST = frozenset(
    {
        "action",
        "algorithm",
        "duration_ms",
        "http_status",
        "key_operations",
        "key_size_bits",
        "kty",
        "key_version_present",
    }
)
PRIVATE_API_ACCEPTANCE_READINESS_FIELD_ALLOWLIST = frozenset(
    {"action", "elapsed_ms", "error_class", "poll_count"}
)

_PRIVATE_API_ACCEPTANCE_READINESS_ACTIONS = {
    "private_api_acceptance.readiness_started": None,
    "private_api_acceptance.readiness_succeeded": None,
    "private_api_acceptance.readiness_deadline_exhausted": (
        "PrivateApiAcceptanceReadinessDeadlineExhausted"
    ),
}
_PRIVATE_API_ACCEPTANCE_READINESS_MAX_POLLS = 36

# Namespaces whose libraries emit request URLs at INFO/DEBUG. A blob URL path
# carries the object name, which the hard rules forbid logging. The AST policy in
# scripts/check_phi_logs.py covers code we own; it cannot cover code we do not.
_PHI_RISK_LOG_NAMESPACES = ("azure", "httpcore", "httpx")

_SAFE_LABEL = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,79}$")
_LOGGER = logging.getLogger(LOGGER_NAME)

SPEECH_BOUNDARY_FIELD_ALLOWLIST = frozenset(
    {
        "action",
        "version",
        "tenant_id",
        "session_id",
        "consent_record_id",
        "scope_sha256",
        "observed_at_ms",
        "call_id",
        "track_index",
        "sdk_version",
        "diarization_enabled",
        "max_speakers",
        "phrase_count",
        "missing_speaker_count",
        "distinct_non_null_speaker_count",
        "accepted_phrase_count",
        "accepted_missing_speaker_count",
        "accepted_distinct_non_null_speaker_count",
        "accepted_distinct_speaker_count",
        "wave_header",
    }
)


def _speech_boundary_payload(
    *,
    tenant_id: UUID,
    session_id: UUID,
    consent_record_id: UUID,
    scope_sha256: str,
    observed_at_ms: int,
    observation: SpeechBoundaryObservation,
) -> dict[str, object]:
    """Closed provider-response metadata, not evidence of durable publication or roles."""

    def integer(value: object, maximum: int = 10_000_000) -> int:
        if type(value) is not int or not 0 <= value <= maximum:
            raise ValueError("speech_observation_metadata_invalid")
        return value

    def valid_identifier(value: object) -> bool:
        return isinstance(value, UUID) and value.int != 0

    for identifier in (tenant_id, session_id, consent_record_id):
        if not valid_identifier(identifier):
            raise ValueError("speech_observation_metadata_invalid")
    if (
        not isinstance(observation.call_id, str)
        or re.fullmatch(r"[0-9a-f-]{36}", observation.call_id) is None
        or str(UUID(observation.call_id)) != observation.call_id
        or UUID(observation.call_id).int == 0
    ):
        raise ValueError("speech_observation_metadata_invalid")
    if re.fullmatch(r"[0-9a-f]{64}", scope_sha256) is None:
        raise ValueError("speech_observation_metadata_invalid")
    if re.fullmatch(r"[0-9][0-9A-Za-z.+-]{0,31}", observation.sdk_version) is None:
        raise ValueError("speech_observation_metadata_invalid")
    if type(observation.diarization_enabled) is not bool:
        raise ValueError("speech_observation_metadata_invalid")
    counts = {
        key: integer(getattr(observation, key))
        for key in (
            "phrase_count",
            "missing_speaker_count",
            "distinct_non_null_speaker_count",
            "accepted_phrase_count",
            "accepted_missing_speaker_count",
            "accepted_distinct_non_null_speaker_count",
            "accepted_distinct_speaker_count",
        )
    }
    if not (
        counts["accepted_phrase_count"] <= counts["phrase_count"]
        and counts["missing_speaker_count"] <= counts["phrase_count"]
        and counts["accepted_missing_speaker_count"] <= counts["missing_speaker_count"]
        and counts["accepted_missing_speaker_count"] <= counts["accepted_phrase_count"]
        and counts["distinct_non_null_speaker_count"]
        <= counts["phrase_count"] - counts["missing_speaker_count"]
        and counts["accepted_distinct_non_null_speaker_count"]
        <= counts["distinct_non_null_speaker_count"]
        and counts["accepted_distinct_non_null_speaker_count"]
        <= counts["accepted_phrase_count"] - counts["accepted_missing_speaker_count"]
        and counts["accepted_distinct_speaker_count"]
        == counts["accepted_distinct_non_null_speaker_count"]
        + int(counts["accepted_missing_speaker_count"] > 0)
        and counts["accepted_distinct_speaker_count"] <= counts["accepted_phrase_count"]
    ):
        raise ValueError("speech_observation_metadata_invalid")
    header = observation.wave_header
    wave = (
        None
        if header is None
        else {
            "channels": integer(header.channels, 64),
            "sample_rate_hz": integer(header.sample_rate_hz, 384000),
            "sample_width_bits": integer(header.sample_width_bits, 64),
            "format_code": integer(header.format_code, 65535),
        }
    )
    payload: dict[str, object] = {
        "action": "captured_speech.provider_boundary",
        "version": 1,
        "tenant_id": str(tenant_id),
        "session_id": str(session_id),
        "consent_record_id": str(consent_record_id),
        "scope_sha256": scope_sha256,
        "observed_at_ms": integer(observed_at_ms, 10**15),
        "call_id": str(observation.call_id),
        "track_index": integer(observation.track_index, 63),
        "sdk_version": observation.sdk_version,
        "diarization_enabled": observation.diarization_enabled,
        "max_speakers": integer(observation.max_speakers, 36),
        **counts,
        "wave_header": wave,
    }
    if frozenset(payload) != SPEECH_BOUNDARY_FIELD_ALLOWLIST:
        raise ValueError("speech_observation_metadata_invalid")
    return payload


def log_speech_boundary(
    *,
    tenant_id: UUID,
    session_id: UUID,
    consent_record_id: UUID,
    scope_sha256: str,
    observed_at_ms: int,
    observation: SpeechBoundaryObservation,
) -> None:
    payload = _speech_boundary_payload(
        tenant_id=tenant_id,
        session_id=session_id,
        consent_record_id=consent_record_id,
        scope_sha256=scope_sha256,
        observed_at_ms=observed_at_ms,
        observation=observation,
    )
    _LOGGER.log(logging.INFO, json.dumps(payload, sort_keys=True, separators=(",", ":")))


SPEECH_PUBLICATION_FIELD_ALLOWLIST = frozenset(
    {
        "action",
        "version",
        "tenant_id",
        "session_id",
        "consent_record_id",
        "scope_sha256",
        "observed_at_ms",
        "job_id",
        "attempt_count",
        "source_receipt_id",
        "source_transcript_version",
        "source_received_at_ms",
        "result_segment_count",
        "result_distinct_speaker_count",
        "calls",
    }
)


def log_speech_publication(
    *,
    tenant_id: UUID,
    session_id: UUID,
    consent_record_id: UUID,
    scope_sha256: str,
    observed_at_ms: int,
    job_id: object,
    attempt_count: int,
    receipt: NormalizedSourceTranscriptReceiptV1,
    result: SttResult,
) -> None:
    """Only invoked after a newly ACCEPTED publication transaction has returned."""
    metadata = result.observation
    if (
        metadata is None
        or not 1 <= len(metadata.boundaries) <= 64
        or len(metadata.boundaries) != len(metadata.track_channels)
        or len(set(metadata.track_channels)) != len(metadata.track_channels)
        or not set(metadata.track_channels) <= {"microphone", "system_audio", "mixed"}
        or not isinstance(job_id, UUID)
        or job_id.int == 0
        or type(attempt_count) is not int
        or not 1 <= attempt_count <= 1000
        or receipt.session_id != session_id
        or receipt.source_transcript_version != 1
        or receipt.source_receipt_id.int == 0
    ):
        raise ValueError("speech_publication_metadata_invalid")
    calls: list[dict[str, object]] = []
    for index, (channel, boundary) in enumerate(
        zip(metadata.track_channels, metadata.boundaries, strict=True)
    ):
        validated = _speech_boundary_payload(
            tenant_id=tenant_id,
            session_id=session_id,
            consent_record_id=consent_record_id,
            scope_sha256=scope_sha256,
            observed_at_ms=observed_at_ms,
            observation=boundary,
        )
        segments = [segment for segment in result.segments if segment.channel.value == channel]
        if (
            boundary.track_index != index
            or len(segments) != boundary.accepted_phrase_count
            or len({segment.provider_speaker_id for segment in segments})
            != boundary.accepted_distinct_speaker_count
        ):
            raise ValueError("speech_publication_metadata_invalid")
        calls.append(
            {
                "call_id": validated["call_id"],
                "track_index": index,
                "channel": channel,
                "accepted_phrase_count": boundary.accepted_phrase_count,
                "accepted_distinct_speaker_count": boundary.accepted_distinct_speaker_count,
            }
        )
    if (
        len({call["call_id"] for call in calls}) != len(calls)
        or sum(boundary.accepted_phrase_count for boundary in metadata.boundaries)
        != len(result.segments)
        or not 1 <= len(result.segments) <= 10_000_000
    ):
        raise ValueError("speech_publication_metadata_invalid")
    received_at_ms = int(receipt.received_at.timestamp() * 1000)
    if not 0 <= received_at_ms <= observed_at_ms:
        raise ValueError("speech_publication_metadata_invalid")
    payload = {
        "action": "captured_speech.source_publication",
        "version": 1,
        "tenant_id": str(tenant_id),
        "session_id": str(session_id),
        "consent_record_id": str(consent_record_id),
        "scope_sha256": scope_sha256,
        "observed_at_ms": observed_at_ms,
        "job_id": str(job_id),
        "attempt_count": attempt_count,
        "source_receipt_id": str(receipt.source_receipt_id),
        "source_transcript_version": 1,
        "source_received_at_ms": received_at_ms,
        "result_segment_count": len(result.segments),
        "result_distinct_speaker_count": len(
            {(s.channel, s.provider_speaker_id) for s in result.segments}
        ),
        "calls": calls,
    }
    if frozenset(payload) != SPEECH_PUBLICATION_FIELD_ALLOWLIST:
        raise ValueError("speech_publication_metadata_invalid")
    _LOGGER.log(logging.INFO, json.dumps(payload, sort_keys=True, separators=(",", ":")))


class _StandaloneSafeLogHandler(logging.StreamHandler[TextIO]):
    """Marker handler used only by command-line jobs."""


def _silence(namespace: str) -> None:
    """Make one third-party logger namespace incapable of emitting."""

    external = logging.getLogger(namespace)
    external.handlers.clear()
    external.addHandler(logging.NullHandler())
    external.propagate = False
    external.disabled = True


def configure_standalone_logging() -> None:
    """Emit allowlisted job events at INFO without enabling third-party INFO logs."""

    if not any(isinstance(handler, _StandaloneSafeLogHandler) for handler in _LOGGER.handlers):
        handler = _StandaloneSafeLogHandler()
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter("%(message)s"))
        _LOGGER.addHandler(handler)
    _LOGGER.setLevel(logging.INFO)
    _LOGGER.propagate = False


def configure_private_api_acceptance_logging() -> None:
    """Expose only the safe Scribe logger in the public-key acceptance process."""

    configure_standalone_logging()
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(logging.NullHandler())
    root.setLevel(logging.CRITICAL + 1)
    for namespace in _PHI_RISK_LOG_NAMESPACES:
        _silence(namespace)


def configure_service_logging() -> None:
    """Expose only the safe Scribe logger inside the long-running API service.

    Deliberately narrow. It does not touch the root logger or this service's own
    logger: under uvicorn those already carry startup and request errors, and
    `log_event` is closed-schema, so neither can carry a clinical payload. It
    closes the one gap they cannot — third-party HTTP clients that log the URLs
    they call.

    Without this the service is protected only by Python's default root level of
    WARNING, which is a default rather than a decision — one ``--log-level debug``
    turns it into blob object names on stdout.
    """

    for namespace in _PHI_RISK_LOG_NAMESPACES:
        _silence(namespace)


def log_event(
    *,
    action: str,
    entity_id: UUID | None = None,
    tenant_id: UUID | None = None,
    error_class: str | None = None,
    duration_ms: int | float | None = None,
) -> None:
    """Emit one JSON event whose fields cannot contain clinical payloads."""

    if _SAFE_LABEL.fullmatch(action) is None:
        raise ValueError("Structured log action must be a fixed safe label")
    if error_class is not None and _SAFE_LABEL.fullmatch(error_class) is None:
        raise ValueError("Structured log error_class must be a fixed safe label")
    if duration_ms is not None and (
        isinstance(duration_ms, bool) or not math.isfinite(duration_ms) or duration_ms < 0
    ):
        raise ValueError("Structured log duration_ms must be a nonnegative finite number")

    payload: dict[str, object] = {
        "action": action,
        "entity_id": str(entity_id) if entity_id is not None else None,
        "tenant_id": str(tenant_id) if tenant_id is not None else None,
        "error_class": error_class,
        "duration_ms": round(duration_ms, 3) if duration_ms is not None else None,
    }
    level = logging.WARNING if error_class is not None else logging.INFO
    _LOGGER.log(level, json.dumps(payload, sort_keys=True, separators=(",", ":")))


def log_private_api_acceptance_result(*, duration_ms: int | float) -> None:
    """Emit only the fixed metadata proven by the private API acceptance job."""

    if isinstance(duration_ms, bool) or not math.isfinite(duration_ms) or duration_ms < 0:
        raise ValueError("Structured log duration_ms must be a nonnegative finite number")
    payload: dict[str, object] = {
        "action": "private_api_acceptance.completed",
        "algorithm": "RSA-OAEP-256",
        "duration_ms": round(duration_ms, 3),
        "http_status": 200,
        "key_operations": ["wrapKey"],
        "key_size_bits": 3072,
        "kty": "RSA",
        "key_version_present": True,
    }
    if frozenset(payload) != PRIVATE_API_ACCEPTANCE_RESULT_FIELD_ALLOWLIST:
        raise RuntimeError("private API acceptance log schema is not closed")
    _LOGGER.log(logging.INFO, json.dumps(payload, sort_keys=True, separators=(",", ":")))


def log_private_api_acceptance_readiness(
    *,
    action: str,
    poll_count: object,
    elapsed_ms: int | float,
) -> None:
    """Emit only fixed readiness lifecycle metadata."""

    if action not in _PRIVATE_API_ACCEPTANCE_READINESS_ACTIONS:
        raise ValueError("Private API readiness action must be a fixed safe label")
    if (
        not isinstance(poll_count, int)
        or isinstance(poll_count, bool)
        or not 0 <= poll_count <= _PRIVATE_API_ACCEPTANCE_READINESS_MAX_POLLS
    ):
        raise ValueError("Structured log poll_count must be a bounded nonnegative integer")
    if isinstance(elapsed_ms, bool) or not math.isfinite(elapsed_ms) or elapsed_ms < 0:
        raise ValueError("Structured log elapsed_ms must be a nonnegative finite number")
    error_class = _PRIVATE_API_ACCEPTANCE_READINESS_ACTIONS[action]
    payload: dict[str, object] = {
        "action": action,
        "elapsed_ms": round(elapsed_ms, 3),
        "error_class": error_class,
        "poll_count": poll_count,
    }
    if frozenset(payload) != PRIVATE_API_ACCEPTANCE_READINESS_FIELD_ALLOWLIST:
        raise RuntimeError("private API readiness log schema is not closed")
    level = logging.WARNING if error_class is not None else logging.INFO
    _LOGGER.log(level, json.dumps(payload, sort_keys=True, separators=(",", ":")))
