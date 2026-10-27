# Use the Core account default as an explicit note choice

Tier 2: an additive cross-repository read at the existing note boundary. No
Scribe database, consent, recording, transcript storage, schema-generation or
note-save contract changes are included. Core owns the persisted preference;
Scribe only presents it.

Deploy the Core `template_preference` receiver and its generated additive
preference table before this consumer. The Core flight plan is
`docs/flight-plans/2026-10-27-note-template-default.md`. Its owner-scoped Settings
control is opt-in and permits clearing the default.

When a new note has multiple eligible templates, Scribe requests the separate
read-only `capture-notes` action `template_preference`, without `schema_ref`,
edits or scratch notes. Accept only `{session_id, default_schema_ref}` for the
same session and either null or a reference in the current template catalogue.
The default is visibly selected, can be changed, and cannot open or prepare a
note without the existing explicit Open note action. Existing retained drafts,
pending preparations/saves and successor operations keep their original schema;
the preference does not reinterpret their fields or overwrite generated text.

An older receiver's 404/422 retains the original picker. Authorization/service
failures and malformed, foreign or unavailable template references remain errors.
The old `templates` receipt is unchanged, so old Scribe clients remain compatible.

Recovery: revert this display-preference consumer to restore the original picker.
There is no local preference data to migrate or erase. Keep Core's additive table
dormant if its receiver is reverted; do not drop it as immediate recovery.

Initial live verification is limited to the already authorized synthetic lab
account and separately selected builds. Verify Settings persistence, changeable
selection, and retained-draft preservation with actual deployment/build identity.
Local tests use synthetic responses and cannot qualify a deployed native app,
clinical content, recording performance or audio. Keep logs metadata-only.
