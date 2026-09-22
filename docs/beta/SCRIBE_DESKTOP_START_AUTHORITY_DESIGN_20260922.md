# Desktop start authority — unresolved server contract

Date: 2026-09-22. Design preparation only; no server route, schema, policy or
client call-order change is applied by this document. It does not authorize
editing Core/OS or activating a service. Preserve the existing shared-Core
decision and both protected authority files.

## Proven gap

The desktop recorder expects a backend mount grant and a fresh authenticated
start decision. The receiver's existing `recorder` action only reauthorizes the
configured session and returns its session ID/native revision. After the local
receiver correction, it uses the existing creator-review read; this does not
create desktop source authority or a one-time capability.

The protected validator requires exact equality of `captureSessionId`, `actorId`,
`consentRecordId`, granted consent, authorized session, `desktop_companion` source
and `sourceLeaseId`. Start authority carries a unique capability ID, opaque secret
and expiry. Its issuance window is at most five minutes; capability and decision
expiry must match. The trusted main process consumes the capability once and
clears its secret after the native start attempt. No renderer field, Clerk token,
capabilities receipt or client-generated UUID can stand in for that server grant.

The present recorder calls `authorizeMount` before `flow.prepareConfigured`.
The latter binds the key, reads capabilities, persists the lease request/key,
issues the Scribe capture lease, persists active state and reserves upload slots.
Therefore the initial mount cannot refer to that newly issued lease yet. The
generic `sourceLeaseId` contract does not itself prove that it is the Scribe
upload/capture lease. No existing desktop source-lease backend was found in the
current Scribe source. Treat their correspondence as an unresolved design choice,
not an established equivalence or permission to invent a second lease.

## Recommended scope to resolve before implementation

Prefer binding desktop source authority to the existing configured capture lease
if its server semantics satisfy desktop exclusivity. This would require a paired
change, with exact Core/Scribe endpoints and persistence reviewed together:

1. Reauthorize the immutable configured creator/consent/session through the
   existing Core facade before opening resources. Keep that check separate from
   the desktop grant; no physical source starts during preparation.
2. Restore or prepare through the existing flow, using its saved request and
   idempotency key. Read the resulting lease from trusted active state. Do not
   issue another lease from the adapter or reset a retained preparation to obtain
   a new one. Recovery of uploaded/failed work does not obtain a new start grant.
3. Have the backend verify current creator, consent, configuration, source,
   lease ID/generation/expiry and allowed session state. Return the exact desktop
   grant only after that verification. Initialize the existing controller with
   it; reauthorize immediately before physical start, after local readiness.
4. Resolve durable one-time start semantics, concurrent desktop/mobile attempts,
   lost-response recovery, server/process restart, revocation and lease expiry.
   The current local replay registry alone does not establish cross-process
   exclusion. The existing `IdempotencyRecord` stores only a fingerprint and
   entity UUID; it is not a durable capability response store. Do not overload it
   with a random entity or add an unreviewed schema/key/signing service.
5. Keep all decisions and secrets in the authenticated server/native-main path.
   Preserve current workload identity separation and fixed error handling. No
   raw authority/capability or credential enters renderer IPC, logs or journals.

The mapping must also account for the existing desktop source choice: a selected
Chrome/Zoom application's audio plus microphone, with explicit capture extent.
No upload budget or lease renewal silently extends physical recording authority.

Expected new checks are server-backed creator/consent revocation, wrong binding,
expired/changed lease generation, concurrent starts, lost start reply and replay
after process restart, plus client ordering and failed-stop retention. Use owned
offline databases first; installed acceptance follows only under approved native
and runtime configuration. Do not rerun unchanged physical/live-service trials.

This is not yet a reviewable implementation patch: durable grant/exclusion
semantics and the exact server surface remain unresolved. Do not treat the
pending Electron/iOS identity approvals as approval for this authority change.
The local native presentation source (ADR 0063) can remain unbound while this
contract is settled. The Core release/mobile receiver packet remains separately
unapplied.
