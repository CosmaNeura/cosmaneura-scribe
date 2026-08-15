# Scribe mobile capture

P1b is a dedicated React Native application for iOS and Android, delivered through signed native
builds rather than a webview wrapper. It shares TypeScript contracts and visual tokens with web,
while native modules own audio capture, background execution, secure storage, and network recovery.

Acceptance requirements include:

- explicit consent before native audio APIs can start;
- visible recording state and predictable interruption handling for calls, alarms, Bluetooth, and
  audio-route changes;
- encrypted 30–60 second chunks with an authenticated local queue;
- airplane-mode capture followed by ordered, idempotent resume;
- safe behavior across screen lock/background transitions allowed by each platform;
- platform secure storage for non-PHI credentials and keys, with no raw tokens in app logs;
- local audio purge only after server receipt confirmation and a bounded retry window;
- remote sign-out/revocation handling and a no-PHI crash/analytics policy.

Before distribution, Cosmaneura must control the Apple and Google developer accounts, bundle IDs,
signing keys/certificates, privacy declarations, and release approvals. Device-management support
for practice-owned hardware is a product decision, not a prerequisite for the first pilot.
