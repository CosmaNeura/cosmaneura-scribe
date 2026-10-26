# Native Save completion observation

Tier 2: lab-only, session-bound evidence. No product API, capture permission,
clinical data storage or deployed runtime behavior changes.

On the owned iOS13 run, all restored note field hashes matched the acknowledged
draft. One normal Save and review click showed Saved for review and opened the
dashboard. Its normal `openInCore` mount cleared the passive note cache, so the
coordinator incorrectly failed `bound_note_response_not_observed`. A clean
autosave flush correctly sends no extra save request; a dirty flush acknowledges
the new draft before that mount. The original failed run and recovery10 remain
unchanged, and dashboard verification is still a separate gate.

The passive visit observer now retains only the latest acknowledged note
metadata across its exact normal mount request and successful same-auth response.
Any later provider/capture operation, failed/foreign mount or auth change retires
the handoff. Original promises and normal note-cache invalidation are preserved.
No request body, note field text or dashboard URL is retained.

The iOS coordinator requires an actual pre-click ordered field digest, one
acknowledged normal click, the new same-visit/auth mount, and the actual Saved for
review completion with its normal navigation controls. The acknowledged note
must match those field/source/session hashes; a changed draft additionally needs
its fresh save acknowledgement and new note reference. Persistence retains its
original Core action (`prepare`, `read` or `save`); manual completion is explicit
separate evidence. Historical autosave alone cannot satisfy this new completion
gate. Existing desktop save handling is unchanged.

Validation covers clean and dirty saves, real observer promise ordering, old,
foreign, lost and superseded mounts, auth switches, field changes and canceled
Save. The old coordinator's clean-save failure is reproduced with the same
regression fixture. Relevant coordinator/native suites run locally while GitHub
Actions remains disabled; final-head independent review is required.

Recovery: keep all original run, capture and failure evidence. Changed tooling
changes the implementation identity; do not silently resume an old journal with
new observer bytes or replay an uncertain Save. Reconcile owned resources and
use an explicitly scoped current-runtime recovery with a real retest. Failure
keeps the existing quarantine. This tooling update does not require rebuilding
unchanged app inputs and does not qualify rebuilt-client, dashboard, playback or
full-journey acceptance by itself.
