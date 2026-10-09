# Native recording responsiveness

Risk: Tier 1. Owner: John Clemente. Scope: existing staging desktop and iPhone
beta identities on the owner's devices. Production and cloud services are outside
this rollout. The owner authorized local validation, implementer review, merge,
staging delivery and idle same-identity application updates.

The change releases canceled starts, bounds macOS window discovery, exposes
expired setup, and overlaps independent preparation checks. It also makes visit
type, language, save status and recovery actions clearer. Consent, fresh trusted
authorization, key custody, durable requests and stop acknowledgement remain
required. A retained request is never replaced to escape a wait.

## Validation and release

1. Record the tested/reviewed commit and applicable local test results in the PR.
   Include synthetic delayed-response, cancellation, retained-work, native pipe,
   browser note-recovery and mobile-layout evidence. Keep physical timing separate.
2. Merge the passing PR. Build both native artifacts from that exact merged source
   with the existing pinned dependencies, staging configuration and identities.
3. Verify signatures, entitlements, source inventories and current installed
   versions. Preserve the previous Mac bundle and all application data. Do not
   uninstall the iPhone application.
4. Update each application only while idle. Reopen using the same identity and
   verify retained visits. Measure opening and recording readiness on each device
   using only an authorized synthetic visit and quiet-room conditions.
5. Report installed versions and measured outcomes. Virtual response times do not
   establish the owner's requested physical startup improvement or beta acceptance.

Release control is the owner-device native beta distribution. No broader cohort
activation is included. Review this limited rollout by 2026-10-07; expansion needs
its own qualification and existing owner authority.

## Recovery

Stop further updates if local validation, identity/configuration comparison or
retained-work checks fail. Retain the last verified installed build until fixed.
If an installed candidate regresses, restore the retained signed Mac bundle or
deliver a same-identity iPhone corrective update preserving its data. No schema,
account, key, queue, journal, recording or saved-note rollback is part of recovery.
