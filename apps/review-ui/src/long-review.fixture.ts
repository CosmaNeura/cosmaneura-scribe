// Invented contract-capacity fixture only; not audio, a clinical source or a translation evaluation.
export function longReviewFixture(sessionId: string) {
  const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  const segments = Array.from({ length: 10_000 }, (_, i) => ({
    source_segment_id: id(i + 1), source_segment_version: 1, source_locale: "es-US",
    speaker_id: id(20_001), speaker_role: "patient", start_ms: i * 1080, end_ms: (i + 1) * 1080,
    content: "🧪".repeat(50), locale_confidence: 0.9,
  }));
  return { schema_version: "1.0", session_id: sessionId, status: "review_required",
    source: { schema_version: "1.0", source_transcript_version: 1, language_mode: "en-US+es-US",
      transcription_adapter_id: "synthetic", transcription_model_profile_id: "synthetic",
      normalization_profile_id: "synthetic", duration_ms: 10_800_000, segments },
    working: { schema_version: "1.0", working_transcript_id: id(20_002), working_transcript_version: 1,
      source_transcript_version: 1, note_ready: false,
      segments: segments.map(segment => ({
        source_segment_id: segment.source_segment_id, source_segment_version: 1, source_locale: "es-US",
        speaker_id: segment.speaker_id, speaker_role: segment.speaker_role,
        start_ms: segment.start_ms, end_ms: segment.end_ms,
        resolution: "unresolved", content: null, translation_id: null,
        translation_version: null, translation_review_id: null,
      })),
      blockers: segments.map(segment => ({ source_segment_id: segment.source_segment_id,
        code: "translation_review_required" })),
    },
    review_queue: { schema_version: "1.0", session_id: sessionId, source_transcript_version: 1,
      working_transcript_id: id(20_002), working_transcript_version: 1, status: "review_required",
      items: segments.map(segment => ({ source_segment_id: segment.source_segment_id,
        source_segment_version: 1, translation_id: id(20_003), translation_version: 1,
        source_locale: "es-US", target_locale: "en-US", speaker_role: segment.speaker_role,
        start_ms: segment.start_ms, end_ms: segment.end_ms,
        source_content: segment.content, translated_content: segment.content,
      })),
    }, translation_progress: [],
  };
}
