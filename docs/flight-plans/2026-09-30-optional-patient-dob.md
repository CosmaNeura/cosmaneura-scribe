# Optional patient date of birth in Scribe

Risk: Tier 1 for this additive client contract. Owner: John Clemente. Initial
cohort: existing staging and the owner's Mac/iPhone beta apps; review by
2026-10-07 before expanding. The owner explicitly requested that missing DOB
never block recording an impromptu visit on either device. Core's separate
schema/reader change has its own flight plan and migration rehearsal.

## Behavior

Prompt for an optional DOB when adding a patient. Keep name required and consent
explicit. Empty DOB becomes JSON null, never an invented date. Preserve known
dates and the existing encrypted pending-request format, creation key and retry
comparison. A selected existing patient without DOB can open a new visit.
This changes no consent, audio, authority, transcript, identity matching or
legacy Core file-upload behavior. The receiver already forwards the JSON field
and validates account/tenant/version; no receiver change is required.

## Receiver-first sequence

1. Merge/rehearse Core's nullable patient DOB, Scribe contract and null-safe
   readers. Deploy that backward-compatible receiver/schema first, retaining
   current configuration and other merged functionality.
2. Build both Mac and iPhone from the final merged Scribe source. Verify
   signature, identity, source inventory and synthetic creation tests before
   installing into idle apps. Preserve all queues, keys, journals and notes.
3. Update both clients before creating a DOB-less patient in staging: older
   client catalog parsers require a string and cannot read a null DOB row.
4. Verify one synthetic unknown-DOB visit reaches consent on both devices.
   Browser/native-port fixtures are virtual evidence, not physical acceptance.

## Validation and recovery

Exercise null and known-date creation on both layouts, required-name validation,
consent before a synthetic start, same-key recovery after an uncertain response
with both plain and Capacitor storage, null catalog parsing and malformed-date
rejection. Run relevant type checks and receiver transport regressions.

Before any null patient exists, prior signed clients remain compatible. Once
null rows exist, retain null-capable clients and forward-fix; do not install an
older strict client or invent DOBs to make it work. Leave the additive nullable
schema in place. No deletion, backfill, queue reset or immediate NOT NULL
rollback is part of recovery.
