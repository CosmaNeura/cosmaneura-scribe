# Ambient scribe build plan

## Product boundary

Cosmaneura Scribe owns consent, capture sessions, raw-audio custody, diarized speech-to-text,
speaker-role labeling, quality gates, retention, and handoff. Note styling and value-point extraction
stay in the existing Cosmaneura engine.

## Delivery phases

1. **P0 pipeline:** consent, private Blob ingestion, orchestration, pluggable STT, role labeling,
   quality gates, and note-engine handoff behind the current upload UX.
2. **P1 in-person:** mobile/web capture with VAD, encrypted chunks, offline queue/resume, and review.
3. **P2 virtual:** Tauri macOS/Windows companion with separate microphone and system-audio channels.
4. **P3 phone:** Azure Communication Services consent IVR and recording.
5. **P4 real-time:** streaming STT and draft notes within 60 seconds of visit end.

## Current Sprint 0 slice

- Conservative consent policy and consent/session state machines
- Short-lived user-delegation upload grants and grant-bound chunk custody metadata
- Structured transcript contract
- Legacy note-engine adapter
- Reversible database baseline, validated private-storage OpenTofu baseline, and CI guardrails

## Required external decisions

- Confirm the provider mobile-app stack before P1.
- Have counsel approve the state × modality consent matrix before replacing the conservative
  all-party default.
- Benchmark Azure Speech and Deepgram only on de-identified samples under the appropriate BAAs.
