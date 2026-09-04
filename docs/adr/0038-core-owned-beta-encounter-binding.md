# ADR 0038: Keep beta encounter matching and demographics in Core

**Status:** Accepted as a dormant cross-system contract

## Context

The beta provider must be able to start from an existing appointment or enter a synthetic patient
name and date of birth for an unscheduled encounter, resolve possible matches explicitly, and see
the resulting item in the limited dashboard. Scribe already accepts opaque appointment,
practitioner, patient, and consent identifiers. Adding names, dates of birth, or matching logic to
Scribe would duplicate Core's source of truth, widen the protected-data boundary, and require an
unnecessary Scribe schema expansion.

## Decision

Core owns both encounter-entry paths:

1. For an existing appointment, Core freshly verifies the signed-in provider's practice and
   appointment access.
2. For manual entry, Core receives name and date of birth, searches only the authorized practice
   scope, and returns bounded possible matches. It never auto-merges. The provider explicitly
   chooses an authorized existing patient context, explicitly creates a new unscheduled patient
   context, or cancels.

Core then commits one canonical encounter binding under a required idempotency key. Exact replay
returns the same binding; reuse with different input fails closed and creates nothing. Only after
the binding and required consent exist may Core create the Scribe session through the existing
Entra workload path.

Scribe receives only its current opaque `appointment_id`, `practitioner_id`, `patient_id`,
`consent_record_id`, and `modality` request fields. Tenant comes from verified workload context;
the immutable creator comes from Core's authenticated actor context. Name, date of birth, possible
matches, tenant, and a caller-asserted creator never enter the Scribe request. The existing Scribe
`appointment_id` carries the canonical encounter/appointment binding, including an unscheduled
encounter, so this feature does not require a Scribe schema change.

Once configured, the new item appears in the same creator-only dashboard state machine as an
appointment-backed recording. Patient/appointment visibility remains Core policy; recording,
transcript, translation, and note visibility remains limited to the immutable recording creator.

## Security and operational boundary

- Closed beta allows only synthetic demographics in the isolated beta practice.
- Match results, name, and date of birth must never enter Scribe, URLs, analytics, logs, crash
  reports, notifications, or the acceptance-evidence manifest.
- Direct identifiers and selected match IDs require fresh authorization; view-as, revoked session,
  revoked grant, wrong practice, and unauthorized match cases fail before Scribe creation.
- Encounter binding and consent precede capture. A partially configured or unresolved match cannot
  start audio processing.
- This decision adds only a synthetic matrix and tests. It does not modify Core, Auth, IAM, Scribe
  routes/schema, clients, infrastructure, a live environment, or any patient data.

## Consequences and next gates

The machine-checkable matrix at
`tests/fixtures/beta/encounter_binding_matrix_v1.json` gives Core and both clients one shared set of
success, explicit-resolution, replay, and denial cases. After the stabilized Core base is
available, implementation still requires its own reviewed persistence and route design, exact
Clerk session-continuity tests, creator/direct-object checks, safe match-result UX, and synthetic
end-to-end evidence on the signed desktop and TestFlight artifacts.
