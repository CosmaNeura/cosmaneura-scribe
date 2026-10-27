# Confirm patient identity before a separate visit

Tier 2: this changes the local custody of patient-confirmation intent. Core's
patient ownership, identity-resolution, consent, and creation checks are unchanged.

The iOS recovery action submitted a provisional source patient as an existing
patient. Core correctly returned 403, closing the workspace. A scoped read found
the original provisional identity and no new committed appointment. The creation
owner retained its original request and key.

The recovery screen now uses the existing explicit patient-confirmation dialog
before offering a separate visit for a provisional patient. A confirmed or matched
identity supplies its canonical patient reference. Confirmation alone never creates
a visit, adopts the old recording, or supplies consent.

Because this device has no capture journal for the old recording, pending patient
confirmation uses a separate record in the existing encrypted store. Its key binds
the authenticated account recovery scope and exact appointment; its payload also
binds the original patient. Atomic compare-and-swap rejects competing writers.
The same match key survives interrupted confirmation and local cleanup. No capture
progress is invented, and old creation/capture records are not removed.

For the demonstrated rejected request, explicitly keeping the provisional entry
as a new patient confirms that same patient ID. The normal creation-result check
then resubmits the original creation key and body. A pre-existing request is never
replaced by a newly selected patient or automatically resubmitted. If that original
request remains unconfirmed, its existing result-check screen remains authoritative;
the confirmation flow does not claim that another patient's request was cancelled.

Deployment: rebuild the capture renderer for iOS/Android and the renderer/main
bundle for Desktop. No native plugin, receiver, Core, database, or configuration
rollout is required. First qualify the existing synthetic provisional visit through
normal confirmation, original-key result checking, and a new unchecked consent
screen. Keep recording separately gated by ordinary consent.

Recovery: restore the previous app bundle while retaining app data. The additive
encrypted match record may remain; older code ignores it. Do not delete it, clear
the original creation key, or reinterpret an interrupted operation as rejected.

Validation covers provisional/confirmed/matched identity selection, explicit action
ordering, original creation-key retention, interrupted match cleanup/reopen, foreign
scope and stale-account rejection, concurrent writes, and the real Desktop IPC
round-trip. Synthetic tests do not qualify a live confirmation or recording.
