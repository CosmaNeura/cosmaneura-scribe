# ADR 0022: Replaceable desktop authentication and bound lifecycle receipts

**Status:** Accepted

## Context

The master platform's authentication user experience and identity-provider composition can change
while the Electron recorder is being developed. Authentication UI is not capture authority. Coupling
the controller, stop recovery, or Recall adapter to a particular page or identity vendor would make
those safety controls change whenever the sign-in experience changes.

Desktop lifecycle mutations also cross an unreliable network boundary. A status-only response could
be accepted for the wrong session or capability, and an encrypted stop intent from an earlier
session could otherwise be sent using a replacement session credential.

## Decision

`DesktopSessionCoordinator` depends on an injected, main-process-only `DesktopAuthenticationPort`.
The current `PlatformDesktopAuthentication` implementation performs the exact custom-protocol
launch, system-browser S256 PKCE flow, callback validation, and `/desktop/v1/oauth/token` exchange.
An authentication UI or provider revision replaces that adapter or preserves its narrow wire
contract; it does not change capture authority, lifecycle coordination, renderer IPC, or the native
adapter.

The platform bearer and grant remain main-process only. The production BFF must derive tenant and
actor identity from its verified request context, bind the returned grant to that context, and
durably enforce one-time capability consumption and idempotency. No tenant, consent, lease, or
capture authority is accepted from renderer input.

Heartbeat and stop responses are exact lifecycle receipts. Each receipt must echo the authorized
capture-session identifier and capability identifier and include a metadata-only receipt identifier.
The client rejects extra fields, mismatched bindings, and invalid states. A stop intent is encrypted
before network use, retains one idempotency key across retries, and is sent only when the current
credential is for the same capture session.

## Consequences

- Authentication UI work can proceed independently from the recorder state machine.
- Clerk, Entra, or another identity implementation never becomes a capture-adapter dependency.
- A replacement credential cannot accidentally carry an old capability into a new session.
- The current mock acceptance proves the client contract only. Production tenant binding, durable
  one-time enforcement, certificate validation, webhook controls, and retention remain backend
  release gates.

## Related

- ADR 0016
- ADR 0018
- ADR 0020
- `apps/desktop-companion/src/desktop-authentication.ts`
- `apps/desktop-companion/src/desktop-lifecycle.ts`
