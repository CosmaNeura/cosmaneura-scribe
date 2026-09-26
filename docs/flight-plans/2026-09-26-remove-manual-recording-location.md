# Remove unnecessary recording-location entry

Tier 2. Owner requested removing the confusing timezone/setup field if unnecessary.
There is no timezone input in the native recorder. Its participant-regions input
feeds metadata; the current all-party-v1 policy requires everyone's consent in all
locations and does not use this metadata to select a recording rule.

Remove the manual field. New native admissions explicitly send an empty region
list, meaning not collected. Do not infer participant location from timezone,
device locale or a practice address. Keep explicit all-party consent, authorized
encounter binding, freshness and revocation unchanged. Preserve and continue to
display any existing region values during recovery of an older admission.

Scribe request/receipt validation and native recovery journals accept empty region
metadata. Core attestation and its Scribe client must accept it too. Existing
PostgreSQL text[] NOT NULL storage already permits an empty array, so no migration,
rewrite, new fixture or permission/configuration change is needed.

Release all Scribe readers/writers first, then Core, then native clients. Retain
expanded readers after creating records with empty metadata; rollback may restore
the old UI, but must not deploy old validators over new empty-region records.
Validate actual consent/session/revocation behavior for both empty and existing
metadata and the compiled UI's prepare/recovery paths. No microphone test required.
