# Direct recording entry and startup feedback

Tier 2 because the explicit recording action follows the existing consent gate.
Implements the owner's fewer-click recording and faster readiness direction.
Reuse the existing workspace, recorder component, native input selector,
controller, admission journal and Core requests.

The current consent screen offers one explicit “Confirm consent & record”
action beside a plain all-party recording/transcription attestation. English and
the device-appropriate visit type are visible defaults; optional settings are
collapsed. The action binds to the currently mounted button and is consumed
before journaling. A cloned, stale, double-tapped or recovered action cannot
create a new admission. It persists admission and prepares the recorder before
carrying one in-memory start request to the mounted component. No start intent
is persisted. Recovery, reopening, renewal and late replies after revocation
never auto-start. Keep native source selection and permission gates. Show iPhone
input choice before Start; reuse the same labels/help in the recorder. Remember
only the last language and visit type for this mounted workspace's lifetime.
The Mac picker presents one button per eligible Zoom/Chrome window; each button
selects and continues once, preserving cancellation/request fences and the
application-wide Chrome audio disclosure. Routine entry is encounter selection,
consent-and-record, then a meeting-window choice on Mac. First-time permissions
and recovery may add actions.

Overlap the consent-scoped capabilities read with key binding. The receiver
explicitly allows capabilities without an audio key. Wait for both results even
on failure, preserve pending/bound key custody, and issue no lease until both
succeed. The recording controller reports starting until source readiness
confirms; visible input levels remain native signal data, never animation.
Remove the redundant preparation confirmation card and provider step numbering.

Validate compiled provider DOM with synthetic desktop/iPhone hosts: one fresh
Start, input forwarding, no unrequested/replayed/recovered start, permission and
revocation barriers. Test concurrent preparation with delayed key/capability
responses and source readiness. Re-run existing provider/recovery checks,
TypeScript/lint and the foreground flow integration suite. Local fixture timing
is not a measured iPhone latency or a claim that the halving target is achieved.

Recovery reverts the UI/controller optimization while keeping journals, keys,
recordings and admission contracts intact. No native installation or staging
activation here; release remains the separately authorized staging handoff.
