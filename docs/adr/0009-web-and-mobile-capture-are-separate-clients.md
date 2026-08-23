# ADR 0009: Web and mobile capture are separate first-class clients

**Status:** Accepted; superseded in part by local ADR 0018 (2026-08-17), amended by central
architecture ADR 0018 (2026-08-21). Local ADR 0018 replaces the React Native framework choice and
the "the mobile app is not a webview" constraint with a single Capacitor codebase. Central ADR 0018
accelerates the desktop companion with an Electron shell and replaceable mixed-audio adapter while
retaining native dual-channel capture as the destination. Central ADR 0019 and local ADR 0020 make
Electron the sole desktop delivery framework through 2028-08-23. The custody, acceptance-testing,
offline-queue, purge, and no-PHI-in-telemetry requirements in this ADR remain binding where applicable.

## Decision

P1 has two deliverables. P1a is a responsive React web/PWA capture experience for provider
computers and exam-room tablets. P1b is a dedicated React Native iOS/Android application using
signed native builds and native modules for capture, background execution, encrypted local queues,
secure storage, and connectivity recovery.

Both clients consume the same generated API contract and implement the same consent, chunk,
idempotency, and custody state machines. They may share TypeScript packages and review components,
but the mobile app is not a webview and the web app does not claim mobile background guarantees it
cannot deliver. The Electron desktop companion remains a separate virtual-visit client. Its initial
accepted adapter is online, audio-only mixed capture; native dual-channel capture remains the
replacement destination and is not an initial-adapter guarantee. Tauri remains the long-term shell
roadmap for a wholly owned native stack, not a parallel delivery target during the 24-month Electron
horizon.

## Consequences

- Web can ship first without defining away mobile reliability requirements.
- Mobile distribution requires Cosmaneura-owned Apple/Google accounts, bundle IDs, signing custody,
  privacy declarations, and release approvals.
- Native audio interruptions, route changes, lock/background behavior, offline recovery, and local
  purge receive platform-specific acceptance tests.
- No capture client may place PHI in analytics, crash reporting, ordinary logs, notifications, or
  unencrypted caches.
