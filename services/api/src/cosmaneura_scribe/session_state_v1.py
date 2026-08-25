from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from types import MappingProxyType
from typing import Final


class SessionStatus(StrEnum):
    CREATED = "created"
    CAPTURING = "capturing"
    UPLOADED = "uploaded"
    PROCESSING = "processing"
    TRANSCRIPT_READY = "transcript_ready"
    HANDED_OFF = "handed_off"
    FAILED = "failed"


class SessionIngestMode(StrEnum):
    CHUNK_UPLOAD = "chunk_upload"
    EXTERNAL_ASYNC_TRANSCRIPT = "external_async_transcript"


SESSION_STATUS_TRANSITIONS: Final[Mapping[SessionStatus, frozenset[SessionStatus]]] = (
    MappingProxyType(
        {
            SessionStatus.CREATED: frozenset({SessionStatus.CAPTURING, SessionStatus.FAILED}),
            SessionStatus.CAPTURING: frozenset({SessionStatus.UPLOADED, SessionStatus.FAILED}),
            SessionStatus.UPLOADED: frozenset(
                {
                    SessionStatus.PROCESSING,
                    SessionStatus.TRANSCRIPT_READY,
                    SessionStatus.FAILED,
                }
            ),
            SessionStatus.PROCESSING: frozenset(
                {SessionStatus.TRANSCRIPT_READY, SessionStatus.FAILED}
            ),
            SessionStatus.TRANSCRIPT_READY: frozenset(
                {SessionStatus.HANDED_OFF, SessionStatus.FAILED}
            ),
            SessionStatus.HANDED_OFF: frozenset({SessionStatus.FAILED}),
            SessionStatus.FAILED: frozenset({SessionStatus.UPLOADED}),
        }
    )
)


def can_transition_session(
    old: SessionStatus,
    new: SessionStatus,
    *,
    ingest_mode: SessionIngestMode = SessionIngestMode.CHUNK_UPLOAD,
) -> bool:
    return (
        old == new
        or new in SESSION_STATUS_TRANSITIONS[old]
        or (
            ingest_mode == SessionIngestMode.EXTERNAL_ASYNC_TRANSCRIPT
            and old == SessionStatus.CREATED
            and new == SessionStatus.TRANSCRIPT_READY
        )
    )


def render_transition_predicate(
    *,
    old_expression: str = "OLD.status",
    new_expression: str = "NEW.status",
) -> str:
    clauses = [f"{old_expression} = {new_expression}"]
    for old in SessionStatus:
        targets = SESSION_STATUS_TRANSITIONS[old]
        if not targets:
            continue
        rendered_targets = ", ".join(
            f"'{status.value}'" for status in SessionStatus if status in targets
        )
        clauses.append(
            f"({old_expression} = '{old.value}' AND {new_expression} IN ({rendered_targets}))"
        )
    return "\n                OR ".join(clauses)


def render_status_values() -> str:
    return ", ".join(f"'{status.value}'" for status in SessionStatus)
