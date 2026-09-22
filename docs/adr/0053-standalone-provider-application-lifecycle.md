# ADR 0053 — Own standalone provider startup and cleanup

Date: 2026-09-22

Status: accepted for local source preparation and offline qualification

## Context and decision

The provider recorder/workspace and native connection were assembled, but the
standalone application had no owner for sign-in, restored sessions, sign-out or
cleanup failures. A host must not discard an unconfirmed recorder stop or allow a
late connection to restore clinical content after access closes.

`mountNativeProviderIOSApplication` now composes the existing native session,
receiver backend, iOS recorder/storage host and complete provider workspace.
The caller supplies the reviewed ciphertext upload target and Core navigation.
The native session plugin is registered once and shared by startup and backend.
No token-returning interface is added.

The application observes the existing native phases and revision. It opens one
restored ready session, then requires explicit reopen after access/connection
changes. Native events and foreground/state reads cannot be overwritten by an
older async reply. Session read failure clears access. There is no new credential
store, claim parser or authentication decision in the UI.

Sign-out remains usable during a pending connection. It clears clinical content
immediately and invokes native sign-out even if recorder cleanup fails. A local
pending sign-out blocks reopening when the native SDK still reports the old ready
session. A late connection is disposed without mounting its workspace. Failed
cleanup retains its exact disposer; the user can retry stopping before reopening.
An outer host also receives a rejected disposer and must retain it for retry.

## Evidence

Evidence root:
`/Users/jw/Desktop/Cosmas/scribe-provider-application-20260922.FhyAep/`.

Ten checks against the actual compiled application and JSDOM pass with
`AbortSignal.any` absent. They cover sign-in/startup, immediate sign-out clearing,
identity revision changes, explicit reopening, sign-out while connecting, late
connection disposal, retained failed cleanup, failed native sign-out, stale state
reads, late listener disposal and failed state reads. The complete iOS startup
also reaches the real recording preparation UI through offline Capacitor
session/catalog/mount responses, then signs out and removes both listeners.
It requests no microphone, native token getter, upload or clinical mutation.

All eight native backend checks pass after sharing plugin registration.
TypeScript, affected lint and provider build pass. The first nine-check build
exposed duplicate plugin registration; that initial log is retained. The final
ten-check build registers it once. Initial TypeScript errors were corrected
before the final successful typecheck. Native auth sources were not changed.

The separate default preview build/guard is retained in the same evidence root;
the new application remains absent from that preview. No preview is deployed.
Protected Core HEAD and all 82 existing dirty paths, statuses and file hashes
still match the original recovery manifest.

## Scope and recovery

Tier 2: application lifecycle around clinical access and recorder ownership.
This is within the approved local provider-workflow source preparation, with
explicit offline fixtures. It is not physical native lifecycle acceptance.
Recovery leaves the new entry unmounted and preserves retained encrypted work.

The phone was reconnected and verified paired/ready using a read-only device
query. No app was installed, launched or restarted. W13's completed acceptance,
the approved Mac R2, active private receiver, certificates and databases remain
unchanged. The iPhone runs iOS 27; the iOS 17 compatibility check is not a physical
iOS 17 qualification.

The new application is built into the provider library, not an installable
standalone app. The exact separate native identity/callback source change is
prepared, unapplied, in the
[identity packet](../beta/SCRIBE_STANDALONE_IOS_IDENTITY_PACKET_20260922.md).
The owner was asked to approve that missing scope. Reviewed real Core runtime,
account/encounter correspondence, upload and Core creation/navigation still need
their configuration. Installation, physical capture/fidelity, desktop hosting
and distribution remain open. No cloud/shared runtime or live service is enabled.
