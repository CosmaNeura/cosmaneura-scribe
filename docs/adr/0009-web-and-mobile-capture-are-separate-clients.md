# ADR 0009: Web and mobile capture are separate first-class clients

**Status:** Accepted; superseded in part by ADR 0018 (2026-08-17) — the React Native framework
choice and the "the mobile app is not a webview" constraint are replaced by a single Capacitor
codebase. The custody, acceptance-testing, offline-queue, purge, and no-PHI-in-telemetry
requirements in this ADR remain binding.

## Decision

P1 has two deliverables. P1a is a responsive React web/PWA capture experience for provider
computers and exam-room tablets. P1b is a dedicated React Native iOS/Android application using
signed native builds and native modules for capture, background execution, encrypted local queues,
secure storage, and connectivity recovery.

Both clients consume the same generated API contract and implement the same consent, chunk,
idempotency, and custody state machines. They may share TypeScript packages and review components,
but the mobile app is not a webview and the web app does not claim mobile background guarantees it
cannot deliver. The Tauri desktop companion remains a separate P2 client for dual-channel virtual
visit capture.

## Consequences

- Web can ship first without defining away mobile reliability requirements.
- Mobile distribution requires Cosmaneura-owned Apple/Google accounts, bundle IDs, signing custody,
  privacy declarations, and release approvals.
- Native audio interruptions, route changes, lock/background behavior, offline recovery, and local
  purge receive platform-specific acceptance tests.
- No capture client may place PHI in analytics, crash reporting, ordinary logs, notifications, or
  unencrypted caches.
