# Scribe web capture

P1a is a responsive React web application/PWA for provider computers and exam-room tablets. It
shares the generated Scribe OpenAPI client, consent gate, capture state machine, encrypted chunk
format, and review components with the broader platform.

The browser client is a foreground capture surface. Its acceptance boundary includes microphone
permission education, persistent recording indication, voice-activity detection, 30–60 second
encrypted chunks, bounded offline/retry behavior, refresh/crash recovery, pause/resume, and local
purge after confirmed upload. It must never promise lock-screen or unrestricted background capture
where browser operating systems cannot guarantee it.

No audio, object path, patient identifier, or transcript content may enter analytics, client logs,
crash reports, service-worker caches, or browser storage outside the encrypted queue.
