# Scribe mobile and desktop redesign rollout

Implement the supplied CosmaNeura design in the existing Lit, Capacitor and Electron applications. The owner authorized all eight implementation items on October 15 and internal subagents for this redesign. The design package is a reference; the owner's corrections govern consent, patient entry, day navigation and dashboard delivery.

## Required outcomes

1. Apply the shared typography, colors, spacing, responsive cards, readable controls and reduced-motion behavior.
2. Open on today's patients, refresh quietly, show one visit action per row, and provide unobtrusive day swipes and keyboard navigation.
3. Start from a name alone. Show the consent script and an unchecked “The patient said yes” gate with one “Start recording” action. Remember nonclinical settings.
4. Show recording status, a large timer, real microphone feedback, Pause and Finish visit. Keep recording details and private reminders secondary.
5. Explain confirmed recording save and ongoing note preparation clearly; permit a return to today's patients without inventing an ETA or promising an unconfirmed save.
6. Preserve template field order, autosave with encrypted recovery and optimistic versions, reveal the conversation when needed, and finish with “Save and review” in the CosmaNeura dashboard.
7. Save author-only private reminders separately from clinical fields, generation inputs, exports and shared views. Offer explicit patient matching later using name, DOB and identifying details; preserve immutable capture provenance.
8. Add real native microphone checks and named inputs, safe input changes, validated call reconnect, iPhone lock-screen recording activity, clear first-run setup and recovery.

Audio retention and existing review playback remain governed by the current implementation. This redesign does not delete existing audio or clinical records. Saving in Scribe sends the note to the CosmaNeura dashboard; there is no EHR delivery.

## Risk and delivery order

This is Tier 2 because it touches consent presentation, encrypted note recovery and author privacy. Split the changes into dependency-ordered PRs within 2,000 changed lines and 50 files. Keep Actions disabled. Every final substantive push needs an independent non-implementer review and local evidence tied to that commit.

First deploy the Core additive receiver and schema expansion after its separately authorized migration decision. Core work starts from `ef45b0e8`; migration `dd086d74a921` descends `35260adbf2ef` and adds separate reminder and identity structures. Old clients and old creation receipts retain their behavior. Rehearse only in the synthetic lab at `/private/tmp/scribe-redesign-core-lab-20261015`, PostgreSQL port 56015, owned by this redesign.

Then introduce the bounded Scribe transport/client additions, shared interface and native changes. Scribe work starts from `e7fb961`. Do not activate clients against a receiver lacking these operations. Finish with packaged Mac and iPhone candidates, visual checks at phone and small desktop sizes, and the local security and recording suites.

The Scribe stack is ordered as: (1) additive visit features and shared view foundations, (2) Mac microphone checks and cancellable recording continuations, (3) iPhone microphone checks and recording activity, and (4) the complete today/consent/recording/note workflow. Each layer remains within the repository change budget. Build and release the complete stack together after the Core receiver is available; intermediate UI foundations remain dormant. Local candidate profiles keep native-provider and receiver activation disabled. The founder owns any first cohort and release decision; review this candidate control by November 15, 2026.

## Verification and recovery

Verify the unchecked consent gate, one-click preparation, exact source/version saves, edits typed during an outstanding save, interrupted writes, retained retry keys, cross-device conflicts and cancellation after view teardown. Confirm private content cannot enter clinical fields, exports, support viewing, unauthorized actor responses or logs. Patient matching must not rewrite capture identity.

Native tests must prove preflight emits metadata only, its audio graph stops before capture acquisition, microphone changes retain saved chunks, reconnection uses the original selected process/window and fresh recording authority, silence never ends a visit, and recording indicators remain until stop is confirmed.

Recover application changes by retaining the previous packaged candidate. Leave additive Core tables dormant if the receiver/client rollout is withdrawn. Never drop their data as immediate rollback. Existing encrypted recordings, exact pending mutations, stop-confirmation barriers, native auth and capture-window limits remain in force. Production promotion, data migration and installing a clinical release require their applicable owner decision.
