# Native recording context in the retained connection

Tier 2: authenticated device key scope. Continue the owner-approved native
three-hour continuity integration using the existing native auth and Core
provider connection. Core PR510 supplies this read and is deployed in staging.

The receiver accepts only the no-payload `native_recording_context` read. The
native connection obtains a fresh SDK token, rechecks the current revision
before and after I/O, and validates the complete Core envelope, nonce, recent
check time, admitted workspace/session and Scribe tenant UUID. Key custody uses
the Scribe tenant, never Core's authority-tenant reference or a renderer value.
Uploaded sessions, unexpected fields, stale replies and account changes fail.

The native auth owner derives a stable recording-account digest from its
immutable identity policy and current account. It includes issuer, audience,
identity profile, native origin, user and organization, excluding the ephemeral
SDK session ID. Signing in again to the same account can recover the same
device keys. This digest is neither a credential nor capture permission.

This native-only method is not registered on Capacitor or the desktop renderer
bridge. It supplies the upcoming key-binding/renewal owner. Existing capture
still uses its current key stores and source-start gate; no key, journal,
consent, admission, source authority or lifecycle behavior changes here.

Validate actual Swift connection/auth code with offline token/wire fixtures:
created/capturing responses, scope/nonce/time/schema mismatch, completed sessions,
unknown fields, denial, revocation, and stable versus different account scopes.
Run receiver transport tests, Python lint/types, iOS compilation and desktop
helper build. Record exact commit and implementer review in the PR.

Recovery: retain the additive receiver read and leave the native method unused.
No deployment, schema write, key migration or runtime activation is required
for this source increment. Three-hour background recording remains incomplete
until key binding, native packet persistence and lease renewal are connected.
