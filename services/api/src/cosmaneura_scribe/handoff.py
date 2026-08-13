from __future__ import annotations

from .schemas import (
    CaptureSession,
    LegacyTranscriptEntry,
    LegacyTranscriptPayload,
    SpeakerRole,
    Transcript,
)

ROLE_LABELS = {
    SpeakerRole.CLINICIAN: "Doctor",
    SpeakerRole.PATIENT: "Patient",
    SpeakerRole.OTHER: "Other",
    SpeakerRole.UNKNOWN: "Unknown",
}


def to_legacy_payload(session: CaptureSession, transcript: Transcript) -> LegacyTranscriptPayload:
    return LegacyTranscriptPayload(
        doctor_id=session.practitioner_id,
        appointment_id=session.appointment_id,
        patient_id=session.patient_id,
        duration=max(segment.end_ms for segment in transcript.segments) // 1000,
        transcript_data=[
            LegacyTranscriptEntry(
                speaker=ROLE_LABELS[segment.speaker_role],
                content=segment.content,
                startTime=segment.start_ms,
                endTime=segment.end_ms,
            )
            for segment in transcript.segments
        ],
    )
