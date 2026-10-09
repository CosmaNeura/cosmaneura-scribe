# Explicit speaker name suggestions

Risk: Tier 2 because the native identity adapter exposes additional profile
metadata to an existing authorized view. Authority, consent, token freshness,
ciphertext custody and transcript persistence contracts remain unchanged.

The speaker editor may suggest the explicit `patient_name` from the latest
authorized Core encounter and the first/last name already loaded for the current
Clerk user. No name is inferred from email, appointment title or meeting profile.
The profile read is synchronous, requires the same ready identity and revision
before and after, and adds no network call or token request. Names are ephemeral
display values; the existing encrypted edit journal and versioned server mutation
remain the only persistence path after **Save correction**.

The user must identify the detected voice and select a shortcut. Opening the
editor does not assign a speaker. Manual entry and **Not sure** remain available.
Malformed, absent or overlong optional suggestions are omitted, without changing
authorization. Legacy hosts and encounters without names keep the manual editor.
Provider account keys and command envelopes remain exact; the existing session
state response receives only an optional field. Names never enter identity,
revision, custody namespace, logs or authority inputs.

Validation uses synthetic records: native identity/revision/logout and custody
checks; actual pinned Clerk SDK typechecking; receiver current-selection checks;
TypeScript host/parser tests; compiled review and immediate post-upload DOM
checks; and browser keyboard, explicit-save and overflow checks at 390/780px.
Check delayed prior-encounter disposal, unsafe HTML, invalid Unicode, absent
names, manual replacement and no writes before Save correction. All relevant
names and transcript lines in fixtures are fictional. Native package/device
acceptance remains a separate merged-source delivery step.

Recovery is a source revert and normal native/web rebuild. Older hosts ignore or
omit optional metadata. No schema, migration, backfill, persisted identity or
capture-lease transition is introduced; existing saved speaker corrections remain
valid. Release follows the existing owner-approved staging cohort and native
delivery process. No production or live-data action is authorized by this plan.
