# Transitional Scribe mobile-capture planning stub

This directory does not contain an application. Phase 2 will fold these P1b requirements into the
single Capacitor source tree at `apps/capture/`, then remove this stub. It must not become a
separate React Native client.

The native profiles are signed Capacitor iOS and Android shells. Every authenticated API/control
operation goes through the master platform BFF, and the profiles consume the same generated
capture-protocol package as the PWA. WebCrypto runs the protocol while a key is active in the
packaged first-party webview; native modules own raw-PCM audio capture, background execution, OS
secure storage, and network recovery. Device-bound Keychain/Keystore wrapping must not be described
as hardware-backed without platform-specific proof.

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
