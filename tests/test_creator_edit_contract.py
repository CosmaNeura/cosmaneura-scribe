from datetime import UTC, datetime
from uuid import uuid4

import pytest
from cosmaneura_scribe.creator_edit_contract import (
    CreatorTranscriptEditBodyV1,
    CreatorTranscriptEditV1,
)
from cosmaneura_scribe.creator_edit_projection import apply_creator_edits
from cosmaneura_scribe.external_transcript_v1 import (
    EnglishWorkingTranscriptSegmentV1,
    EnglishWorkingTranscriptV1,
    SourceLocale,
    WorkingSegmentResolution,
)
from cosmaneura_scribe.schemas import SpeakerRole


def test_explicit_correction_never_mutates_base_working_evidence():
    row = EnglishWorkingTranscriptSegmentV1(
        source_segment_id=uuid4(),
        source_segment_version=1,
        source_locale=SourceLocale.ENGLISH_US,
        speaker_id=uuid4(),
        speaker_role=SpeakerRole.UNKNOWN,
        start_ms=0,
        end_ms=1000,
        resolution=WorkingSegmentResolution.ENGLISH_SOURCE,
        content="Synthetic original.",
    )
    working = EnglishWorkingTranscriptV1(
        working_transcript_id=uuid4(),
        working_transcript_version=2,
        source_transcript_version=1,
        segments=(row,),
    )
    request = CreatorTranscriptEditBodyV1(
        expected_source_transcript_version=1,
        expected_working_transcript_id=working.working_transcript_id,
        expected_working_transcript_version=1,
        corrections=(
            {
                "source_segment_id": row.source_segment_id,
                "expected_source_segment_version": 1,
                "content": "Synthetic correction.",
            },
        ),
        speakers=(
            {
                "speaker_id": row.speaker_id,
                "role": "other",
                "detail": "interpreter",
                "display_name": "Fictional interpreter",
            },
        ),
    )
    edit = CreatorTranscriptEditV1(
        edit_id=uuid4(), working_transcript_version=2, created_at=datetime.now(UTC), request=request
    )
    result = apply_creator_edits(working, (edit,))
    assert working.segments[0].content == "Synthetic original."
    assert working.segments[0].speaker_role == SpeakerRole.UNKNOWN
    assert result.segments[0].content == "Synthetic correction."
    assert result.segments[0].speaker_role == SpeakerRole.OTHER
    assert result.note_ready
    assert "Synthetic" not in repr(edit) and "Fictional" not in str(edit)
    for update in [
        {"expected_source_transcript_version": 2},
        {"expected_working_transcript_id": uuid4()},
    ]:
        with pytest.raises(ValueError, match="lineage"):
            apply_creator_edits(
                working, (edit.model_copy(update={"request": request.model_copy(update=update)}),)
            )


def test_utf8_request_size_is_bounded_before_encrypted_journaling():
    with pytest.raises(ValueError, match="creator_edit_too_large"):
        CreatorTranscriptEditBodyV1(
            expected_source_transcript_version=1,
            expected_working_transcript_id=uuid4(),
            expected_working_transcript_version=1,
            corrections=tuple(
                {
                    "source_segment_id": uuid4(),
                    "expected_source_segment_version": 1,
                    "content": "界" * 100000,
                }
                for _ in range(4)
            ),
        )


@pytest.mark.parametrize("content", ["bad\x00text", "bad\ud800text", "bad\udffftext"])
def test_unencodable_or_nul_correction_is_rejected_without_rendering_input(content):
    with pytest.raises(ValueError, match="creator_edit_text_invalid|string_unicode") as error:
        CreatorTranscriptEditBodyV1(
            expected_source_transcript_version=1,
            expected_working_transcript_id=uuid4(),
            expected_working_transcript_version=1,
            corrections=(
                {
                    "source_segment_id": uuid4(),
                    "expected_source_segment_version": 1,
                    "content": content,
                },
            ),
        )
    assert "bad" not in str(error.value)
