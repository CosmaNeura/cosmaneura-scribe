# Transitional Scribe web-capture planning stub

This directory does not contain an application. Phase 2 will fold these P1a requirements into the
single Capacitor source tree at `apps/capture/`, then remove this stub. It must not become a
separate web client.

The PWA profile is a responsive foreground capture experience for provider computers and exam-room
tablets. Every authenticated API/control operation goes through the master platform BFF, and the
profile consumes the generated capture-protocol package; it never receives a Scribe workload token
or calls the private Scribe API directly.

The browser client is a foreground capture surface. Its acceptance boundary includes microphone
permission education, persistent recording indication, voice-activity detection, 30–60 second
encrypted chunks from a tested raw-PCM browser adapter, bounded offline/retry behavior,
refresh/crash recovery, pause/resume, and local purge after confirmed upload. A native PCM plugin
does not satisfy this profile. It must never promise lock-screen or unrestricted background capture
where browser operating systems cannot guarantee it.

No audio, object path, patient identifier, or transcript content may enter analytics, client logs,
crash reports, service-worker caches, or browser storage outside the encrypted queue.
