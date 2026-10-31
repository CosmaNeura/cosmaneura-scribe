# Full native visit actions v2 — source-only flight plan

An ordinary first visit starts with a name-only provisional patient. The
production Core-context receiver currently offers only existing-patient visits,
which also hides patient matching and author reminders. This source change adds
explicit full-workflow negotiation while retaining that existing v1 subset.

Risk is Tier 2: patient-data paths and a closed native contract. Core is the
receiver-first dependency: [Core PR 924](https://github.com/CosmaNeura/cosmaneura/pull/924).
Its existing writers remain authoritative for patient creation, explicit
identity decisions, encrypted author reminders, tenant/provider/practice checks,
idempotency, metadata receipts, and commit-time authorization.

The new receiver configuration field `native_visit_actions_v2_enabled` defaults
to false and requires `core-provider-context-v1` plus encounter creation. An
enabled source profile opts in to Core provider context with literal
`include_native_visit_actions_v2: true`. Only a fresh strict boolean Core reply
may confer `native_visit_actions_v2`; it is bound into account comparisons. The
Core action facade selects encounter version 2 on the existing fixed dual-auth
route. The version 1 transport remains existing-patient-only.

Version 2 permits only `patients`, `create` with existing or new/provisional
selection, `patient_match_candidates`, `patient_match_save`, `private_note_read`
and `private_note_save`. Optional DOB belongs to explicit new-patient
confirmation. The obsolete `add_birth_date` port is omitted from full native
setup. No general encounter-action forwarding is added.

The native catalog retains `existing_patient_visits_v1` for old clients. Updated
iPhone and Mac renderers give the explicit full v2 marker precedence, require
Production and the compatible creation/subset markers, and reject ambiguous
negotiation. Staging and current existing-only clients keep their old behavior.
Clinical note save, consent, capture, source start and audio authorization use
their existing paths.

The owner of an enabled release decision is the founder; no initial production
cohort is activated by this PR. Reconcile the dark controls and remove obsolete
source-only assumptions before the first enabled release decision. Validate the
exact Core/Scribe pair locally with synthetic mock/ASGI ports, review final
source independently, then qualify newly built production-profile clients in
the separately authorized release process. The renderer inputs change here:
signed source `0d3c33ef9bd9fb61d92b4c8c6e763e4a88b682ef` candidates do not prove
the new full-workflow UI or installed production acceptance.

Recovery is to leave or return the full source control to default-off and retain
the compatible existing v1 path. Do not revert committed patient identities,
author reminders, or retry receipts. This PR applies no schema, configuration,
grant, workload, deployment, cohort, native upload, or production mutation.
