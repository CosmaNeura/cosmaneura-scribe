# ADR 0008: Keep speech-to-text provider-neutral and benchmark Azure first

**Status:** Accepted

## Decision

The worker depends on a `SpeechToTextProvider` contract that requires an opaque session ID, valid
consent-record ID, object IDs, and assembled local audio tracks, then returns channel-preserving,
time-aligned speaker segments. Audio paths and transcript content are excluded from object
representations and logs. Speaker-role labeling remains a later interface; the provider reports
only its speaker identity and capture channel.

Azure AI Speech is the first adapter. It uses the stable Azure AI Transcription client, Entra
managed identity, file-stream input, diarization, unmasked clinical vocabulary, and SDK wire
logging disabled. No public or signed audio URL is required. Separate microphone/system tracks are
transcribed independently and merged by timestamp so the downstream role labeler retains the
strong channel prior.

Provider selection requires an explicitly de-identified benchmark manifest with a verified consent
record and fixture provenance for every case. The harness emits only opaque case IDs and aggregate
word-error, timing, segment, and speaker metrics. It never emits audio paths, reference text,
hypotheses, consent IDs, endpoints, or tokens.

## Consequences

- Azure service behavior can be benchmarked without coupling custody/orchestration to its SDK.
- Deepgram or another BAA-covered adapter can be compared later without changing session storage.
- Word error rate is necessary but insufficient; medical terms, speaker attribution, and
  low-confidence segments need controlled human review.
- The production worker remains disabled until the Speech resource, RBAC, private networking,
  de-identified evidence, and cost are separately reviewed.
