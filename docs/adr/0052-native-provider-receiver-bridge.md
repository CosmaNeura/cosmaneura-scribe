# ADR 0052 — Connect the provider host through the existing native session

Date: 2026-09-22

Status: accepted for local source preparation and offline qualification

## Context

The standalone provider receiver now has real identity/creator authorization,
but the iOS host still required its native request binding. The retained W13
session owner has already passed physical sign-in/catalog/restart/logout checks.
Its application configuration accepts only CosmasOS synthetic bundle identities;
it cannot be relabeled as the standalone Scribe app or silently granted another
bundle/callback/Keychain profile.

## Decision

Reuse that exact `NativeWorkspaceAuth` and native token policy. Add a separate
`NativeProviderConnection` and endpoint-specific `ProviderNativeTransport`, then
prepare a copy of the retained Capacitor bridge with fixed provider methods.
Only six receiver actions are available. Native code obtains a fresh SDK token
for each request, keeps it out of JavaScript, checks the session revision before
and after awaits and cancels outstanding work on native session changes.
Caller cancellation before dispatch is retained. Late replies cannot reopen a
revoked scope. Cancellation does not undo a mutation already sent to Core.

The transport uses one explicitly configured RFC1918 HTTPS endpoint, its bundled
CA and exact leaf pin. It denies redirects, cookies, credential persistence,
arbitrary paths/headers, oversized bodies/replies and raw error propagation.
No Keychain or system trust setting is changed. The original token-returning and
W13-only catalog methods are not registered in the prepared provider bridge.
Capacitor 8.5's native dispatch checks its registered method list before invoking
an Objective-C selector; no token getter is exposed by this bridge.

`connectNativeProviderIOSBackend` binds the fixed native interface to
`createProviderIOSHost`: encounter listing/mount, configured capture/review/note
requests and recorder reauthorization. It validates the server scope, preserves
mutation keys, rejects arbitrary request paths and forwards cancellation. Native
state changes and the retained five-second foreground state check invalidate the
host; these state checks do not fetch SDK tokens. Disposal also handles listeners
that arrive after cancellation. It uses no `AbortSignal.any`.

Capacitor can log native response bodies when debug logging is enabled. The
prepared bridge's `getProviderState` reports readiness only with a valid receiver
profile, `loggingEnabled == false` and `CAPLog.enableLogging == false`. The web
backend refuses to send provider payloads without that readiness. The bridge
rechecks before dispatch and returning a result. Existing capture packaging uses
`loggingBehavior: "none"`; the final app artifact must retain that setting.

## Risk, activation and recovery

September 25 long-visit receiver amendment: operation responses now allow the
Core 32 MiB review plus 8 KiB provenance envelope. Admission/note response and all
request limits remain unchanged. Desktop JSON-string frames allow twice the
Core envelope plus 8 KiB; geometric Node buffers reuse the audio decoder's
synchronous byte ownership and clearing pattern. Large buffers are released
after a reply; overflow, parser failure or closure clears partial content.
Core PR507 precedes this reader change. Larger Scribe writers and persistent
aggregate constraints follow only after compatible readers are deployed.
See `../flight-plans/2026-09-25-long-review-receivers.md` for staged recovery.

Tier 2: new native clinical transport and lifecycle behavior. This is within the
owner's approved local configured workflow preparation, with invented data only.
The native authentication source, installed W13 app/receiver, approved Mac R2,
other apps, demos, protected Core/OS paths and cloud configuration remain intact.
No new app identity, callback, Keychain namespace or actual Core endpoint is
configured or activated. Source tests do not authorize those runtime changes.

The host still supplies the existing authorized ciphertext upload target and Core
encounter creation/navigation. The next concrete packet must bind the standalone
Scribe identity/callback and reviewed Core workload/account/encounter configuration,
then perform the actual provider workflow acceptance. Preserve the separate
desktop, native lifecycle, physical audio, fidelity and signed-release gates.

Recovery is to leave the separate receiver/app profile absent and keep the accepted
W13 artifacts. The preparation script refuses an existing output directory. No
database schema, stored capture record, consent or credential migration is added.

## Evidence and limits

Evidence root:
`/Users/jw/Desktop/Cosmas/scribe-provider-native-bridge-20260922.WPYCoIZE/`.

- Eight focused TypeScript checks pass for current Core-client requests, scope
  validation, logging readiness, native cancellation, stale/late replies, listener
  cleanup, revocation and conflict recovery. Types and lint pass.
- Nine compiled Swift checks pass with the unchanged native session owner/token
  policy and explicit offline driver/wire/access-block fixtures. They cover fresh
  token calls, cancellation before dispatch and during token acquisition, logout,
  identity change, expiry, bounded inputs, error redaction and endpoint policy.
- A real native URLSession HTTPS check passes against a temporary private receiver
  and new socket-only PostgreSQL fixture. Its offline signed JWT is verified by
  the retained receiver verifier. Five native requests cover catalog, Core mount,
  configured admission, creator review and note templates; fifteen Core requests
  use an explicit wire fixture. A wrong certificate pin is rejected and logout
  prevents another request. No real Clerk/Core/model/Speech service is contacted.
- The complete prepared Capacitor bridge typechecks with Swift 6, warnings as
  errors and an iOS 17 target against the retained native dependencies. The built
  provider entry reaches recording preparation through the new backend and clears
  the real UI on native sign-out, with `AbortSignal.any` absent. This uses offline
  native responses and JSDOM, not a physical device.

All temporary HTTPS listeners and the owned test database were stopped after
verification. The accepted phone was not queried, installed, launched or changed.
The library and bridge are source/connection evidence, not a signed standalone
Scribe app, live SDK refresh/revocation acceptance, physical recording, real Core
SOAP fidelity or beta release qualification.
