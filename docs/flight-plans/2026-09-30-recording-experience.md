# Recording controls and note readiness

Risk: Tier 1. Owner: John Clemente. Initial cohort: the existing staging test
environment and the owner's Mac beta identity. Review by 2026-10-07 before
expanding distribution. Local checks, implementer review, passing PR merges,
staging delivery and idle same-identity native updates are owner-authorized.

The owner's Zoom rehearsal reached a SOAP note. Reported friction was a buried
meeting picker, competing control windows, and manual refreshes before the note
appeared. Recording completeness and clinical fidelity were not independently
verified by that report. Preserve the tested encounter and other retained work.

## Independently deployable changes

- Scribe: float the explicit window chooser across Spaces; make the persistent
  native recording indicator compact; keep the main timer, Pause/Resume, and
  Stop and upload together. Put source guidance below the controls, reduce the
  default window size, and display long transcript phrases as shorter paragraphs
  with consistent detected speaker numbers. Formatting preserves every source
  character and never assigns a person's identity or changes stored speech.
  Recover an uncertain explicit note preparation through bounded fresh reads,
  without submitting preparation again. Preserve source selection, stop acknowledgement,
  indicator visibility enforcement, recovery actions and recording authority.
- Core: a separate PR checks fresh authorized reads while a Scribe-owned,
  transcript-only note page is open. It must stop on draft availability, route
  disposal and a finite deadline; it must never generate a note or overwrite
  editable fields. Core's lack of automatic revalidation is a confirmed code
  gap; the owner confirmed refreshes were needed in both Scribe and staging.

Neither change depends on the other's deployment. No schema, consent, identity,
data-retention or external-contract changes are included.
The full single-window recording handoff and optional patient DOB are separate
changes. This release keeps the independent native safety panel; it does not
claim that competing controls or named-speaker assignment are fully resolved.

## Validation and delivery

1. Validate the native AppKit layout with hidden panels and the actual browser
   controls with synthetic states. Test cancel, paused finish, Resume, failed
   stop and access closure. Persona screenshot feedback is simulated research,
   not physical desktop or clinician acceptance.
2. Record exact reviewed/tested commits and local results in each PR, and merge
   passing work under the owner's local-validation policy.
3. Build Mac38 from merged source using the existing pinned staging packaging.
   Compare source inventories, identity, configuration and entitlements. Keep
   the prior signed Mac bundle. Update only after the current app is idle;
   do not interrupt the owner's recording or note review.
4. Before any Core deployment, reconcile the active source/image/schema/config
   and preserve Session Prep/CosmaBot. Build and verify the exact merged source,
   then use the existing staging deployment path. Do not deploy production.
5. Report installed and deployed versions separately from local implementation.
   Physical busy-desktop/full-screen picker placement remains an acceptance
   check; synthetic UI tests do not establish recording speed or fidelity.

## Recovery

Retain the current verified app/revision until its replacement passes checks.
Restore the previous signed Mac bundle if needed; do not reset app data. For
Core, restore prior revision traffic using recorded reconciliation evidence.
Retain recordings, notes, encrypted queues, keys, journals, accounts and all
current configuration. No database rollback is part of this release.
