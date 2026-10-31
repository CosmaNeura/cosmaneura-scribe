# ADR 0094: Dormant native existing-patient visit entry

Status: proposed source subset; production activation remains unapproved.

Use the fixed dual-authenticated Core native encounter facade for patient
search and creation of a visit for an existing doctor-owned patient. Fresh
qualified Clerk verification and current Core provider context bracket each
operation. Core derives and rechecks current roster/practice/tenant authority
and reuses its established creation-key receipt, writer and metadata audit.
No local shadow registry, alternate authority, patient-name match, automatic
retry, new dependency or schema is introduced.

The existing receiver encounter flag stays false by default. In the explicit
Core-context mode, enabling it advertises only `existing_patient_visits_v1`.
Native clients accept Production account display only with that capability,
show an existing-patient picker and withhold new/provisional patient, matching,
DOB and private-note mutation controls. Staging and the legacy registry retain
their current defaults and wire behavior. An uncertain creation retains the
original encrypted journal and exact key; an unsupported pending request is
never resubmitted as a different intent.

This is visit entry, not full Start-to-Save parity. Existing native admission
and preparation remain gated; remaining generic Agent API mutation/source-start
fallback must be replaced by a separate closed native consumer before the full
workflow can operate with global Agent API and Session Prep disabled. Actual
authority, Clerk, images, schema/Entra, grants/network, cohort/canary and recovery
acceptance remain held. Source flags do not authorize capture or clinical use.

Recovery follows the [Tier 2 flight plan](../flight-plans/2026-10-31-native-existing-patient-visits-dark.md):
stop submissions, retain uncertain keys, drain accepted work, restore the
qualified compatible image/configuration pair and preserve Core visits,
receipts/audit, mappings, ciphertext, keys and schema. No registry/CLI fallback
or immediate data deletion is an automatic recovery action.
