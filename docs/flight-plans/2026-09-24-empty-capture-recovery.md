# Empty capture and stopped-error recovery — Tier 2

An offline fixture on merged `49d20a9a6a7605de97c3b304aa0727dd8dcfe40f`
reproduces an interrupted interval with no complete saved audio. The first
confirmed Stop rejects empty upload and changes the in-memory state to error;
another Stop succeeds without changing that error screen. Start and Resume are
unavailable. The original encrypted store remains recoverable by reopening the
same encounter. This explains a reproducible recovery defect, not the cause of
the installed Mac's initial recording failure, which remains unproven.

## Change and boundaries

- Configured provider capture with zero saved audio remains paused after its
  native stop and persistence barriers complete. It displays that no audio was
  saved and offers the existing explicit Resume action. No empty upload,
  completion, consent, session, key replacement or fresh authority is created.
  The unrelated synthetic-preview empty-capture behavior is unchanged.
- After confirmed native shutdown and original server-owner retirement, an
  existing error with the same durable paused session displays explicit
  same-encounter reopen instructions. Its error is not reset; the presentation
  reports stopped, so Stop no longer appears to be a working recovery action.
  Ordinary reopen performs the existing authorization and retained-state checks.
- Unconfirmed native stop or lost retirement acknowledgement keeps the existing
  retry path. Complete saved chunks retain their existing upload path. An
  interrupted partial tail remains discarded and coverage remains incomplete.
- The exact completed `15ac74f3f9e04edc7119e4c30838e9061e9a4cd4` lifecycle
  diagnostics change is imported to preserve the installed Mac host behavior.
  Its fixed event/UTC/PID allowlist accepts no capture content, identities,
  exception text, credentials or request values. It cannot establish the cause
  of a recording failure. No diagnostic file is read by the tests.

## Validation and acceptance

Run the flow integration and desktop provider suites with invented consent,
temporary encrypted storage and a stub PCM driver. Cover empty microphone and
mixed capture, delayed/failed stop, lost server retirement, retained complete
chunks, unknown persistence error, mismatched durable session, and explicit
same-operation reopen without acquiring recording authority. Run capture and
desktop types, applicable lint, the desktop host build, and existing native pipe
fixtures where available. Bind actual commands/results and final pushed SHA in
PR evidence. Independent source review follows the final substantive push.

The earlier failing-behavior reproduction is retained separately under the
release evidence `native/stop-recovery-probe/`; it is not an acceptance test for
the correction and does not prove physical recording. Tests never read live
journals, Keychain, userData, accounts or devices, and stub tests do not spawn
the native helper or operate OS audio/window capture.

The owner-controlled existing signed internal beta package is the release
control. Owner: John. Cohort: the approved staging provider's synthetic
encounter only. Acceptance window expires September 25, 2026; broader promotion
requires a separate decision. Build only reviewed merged source. Preserve the
existing bundle IDs, signing identity, profile, entitlements, issuer, endpoints,
permission setup and Mac audio cadence fix. Install only in a separately
confirmed window after normal source shutdown; never overwrite an active app.

Root owns installed acceptance: reopen the original encounter, verify retained
identity/session and explicit recovery, then use a deliberate synthetic
recording, confirmed stop, upload, transcript review and Core note save/reopen.
No recording acceptance is claimed until that installed path succeeds.

## Recovery and data boundary

Retain installed Mac build 5 and iPhone build 9 packages until replacement is
verified. If the new package fails, stop normally and restore the retained
same-identity application under the guarded installation procedure. Never
clear journals, ciphertext, keys, permission choices or custody to recover.
Reopening recovers saved work; it cannot reconstruct discarded audio.

This change has no schema/migration, Core/Scribe service image, receiver contract,
production, new dependency, credential or live-data mutation. The scope remains
staging synthetic acceptance. Actions stays disabled; owner-approved local tests
and independent review substitute for hosted statuses without inventing them.
