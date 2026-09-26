# Direct recording entry and startup feedback

Tier 2 because the explicit recording action follows the existing consent gate.
Implements the owner's fewer-click recording and faster readiness direction.
Reuse the existing workspace, recorder component, native input selector,
controller, admission journal and Core requests.

A fresh Start recording click still requires selected language and an explicit
all-party checkbox. It persists admission and prepares the recorder before
carrying one in-memory start request to the mounted component. No start intent
is persisted. Recovery, reopening, renewal and late replies after revocation
never auto-start. Keep native source selection and permission gates. Show iPhone
input choice before Start; reuse the same labels/help in the recorder. Remember
only the last explicitly chosen language for this mounted workspace's lifetime.

Overlap the consent-scoped capabilities read with key binding. The receiver
explicitly allows capabilities without an audio key. Wait for both results even
on failure, preserve pending/bound key custody, and issue no lease until both
succeed. The recording controller reports starting until source readiness
confirms; visible input levels remain native signal data, never animation.
Remove the redundant preparation confirmation card and provider step numbering.

Validate compiled provider DOM with synthetic desktop/iPhone hosts: one fresh
Start, input forwarding, no unchecked/replayed/recovered start, permission and
revocation barriers. Test concurrent preparation with delayed key/capability
responses and source readiness. Re-run existing provider/recovery checks,
TypeScript/lint and the foreground flow integration suite. Local fixture timing
is not a measured iPhone latency or a claim that the halving target is achieved.

Recovery reverts the UI/controller optimization while keeping journals, keys,
recordings and admission contracts intact. No native installation or staging
activation here; release remains the separately authorized staging handoff.
