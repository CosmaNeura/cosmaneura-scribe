"""Apply immutable creator evidence to a derived view, never to the source."""

from __future__ import annotations

from .creator_edit_contract import CreatorTranscriptEditV1, validate_edit_history
from .external_transcript_v1 import EnglishWorkingTranscriptV1


def apply_creator_edits(
    working: EnglishWorkingTranscriptV1, edits: tuple[CreatorTranscriptEditV1, ...]
) -> EnglishWorkingTranscriptV1:
    validate_edit_history(edits)
    rows = {item.source_segment_id: item for item in working.segments}
    speaker_ids = {item.speaker_id for item in working.segments}
    for edit in edits:
        request = edit.request
        if (
            request.expected_source_transcript_version != working.source_transcript_version
            or request.expected_working_transcript_id != working.working_transcript_id
            or edit.working_transcript_version > working.working_transcript_version
        ):
            raise ValueError("creator_edit_lineage_invalid")
        for correction in request.corrections:
            row = rows.get(correction.source_segment_id)
            if (
                row is None
                or row.source_segment_version != correction.expected_source_segment_version
            ):
                raise ValueError("creator_edit_segment_invalid")
            if row.content is None or row.resolution == "unresolved":
                raise ValueError("creator_edit_unresolved_translation")
            rows[correction.source_segment_id] = row.model_copy(
                update={"content": correction.content}
            )
        for speaker in request.speakers:
            if speaker.speaker_id not in speaker_ids:
                raise ValueError("creator_edit_speaker_invalid")
            for segment_id, row in tuple(rows.items()):
                if row.speaker_id == speaker.speaker_id:
                    rows[segment_id] = row.model_copy(update={"speaker_role": speaker.role})
    result = working.model_copy(update={"segments": tuple(rows.values())})
    # Revalidate total content limits and existing readiness/translation constraints.
    if sum(len(row.content or "") for row in result.segments) > 1000000:
        raise ValueError("creator_edit_too_large")
    return EnglishWorkingTranscriptV1.model_validate(result.model_dump(exclude={"note_ready"}))
