# Native staging recovery — 2026-09-24

Tier 2 because this narrows configured recording key-conflict recovery. The owner requested these native fixes, preserved-data updates and synthetic acceptance in NATIVE_FIXES_PROMPT.md. Existing identities, consent, admission, immutable server keys and encrypted journals remain authoritative.

## Source reconciliation

The original clean native branch ended at ea4a9a57f140d0665afd843e46c5ea320f3594fc. Main 465d0ea already incorporated its permission setup and startup diagnostics, plus newer confirmed-Stop/empty-recording recovery. The remaining window-selection feedback from 77bce37 is integrated by content with that newer recovery. Historical docs and the already-run scope repair remain preserved in the original branch.

PR112's unchanged final head a20b000 passed independent review and its retained input/log hashes were reverified. It merged as 9c578734d165054e908b490403de795ed6c83248. This follow-up starts from that main. No service rebuild or provisioning is needed.

## Changes and evidence

- Pending discard callers previously failed when their child exited without a stop reply. Complete discard only after the owned child exit and packet work are observed. Preserve deadlines, failed drain semantics, server retirement and explicit start. The new real Swift pipe fixture fails on the old host at its close handler; the corrected suite passes 54 cases. No physical source is used.
- Retain the local window-selection message alongside main's empty-recording and same-encounter reopen recovery.
- Configured recording key-bind conflicts preserve the exact pending key and request. They no longer guess replacement keys. The ambiguity of a sanitized 409 is retained: the UI does not assert which device owns the key. Existing capturing sessions without local preparation, and missing configured local keys, expose the same actionable device-custody state. Cross-device continuation is not implemented.
- Encounter opening now shows progress and a retry action after failure. Fixed stage labels distinguish the encounter connection, journal recovery, recording status, device access and preparation. Auth closure continues to clear content immediately and requires explicit reopening; the returning ready state explains why the workspace closed.
- The external browser action is labeled Open Core dashboard and explains separate sign-in, assignment and return/refresh. It does not claim to create an encounter.

## Local validation

Node 24.19.0; existing locked dependencies, without upgrades:

- Capture workspace `vitest run`: 218 passed. The added two-device fixture models the real immutable-key 409 (the preview BFF itself permits rebinding), then reopens a new controller and verifies original custody plus exact pending intent are unchanged, with no phone lease or source start.
- Desktop workspace `vitest run`: 114 passed, 31 optional native cases skipped. Applicable real-pipe tests ran separately and passed all 54.
- `scripts/check-provider-application.mjs` against the built provider bundle: slow mount across a real five-second poll, failed mount, failed encrypted-journal read, explicit retry, stable consent/focus across another poll, truthful Core navigation, device-custody refusal, and retained existing lifecycle/Stop checks. AbortSignal.any is deliberately absent for the iOS 17 compatibility path.
- Capture and desktop TypeScript checks and changed-source ESLint pass. Provider renderer builds. Exact logs and source hashes are retained in the local scribe-native-acceptance-20260924 directory and summarized in PR evidence.

Independent review must cover the final pushed head; local evidence is not a GitHub approving review or hosted CI. Actions remains disabled under the owner's local-validation policy. Ordinary 2000-line/50-file limit applies.

## Release, recovery and remaining acceptance

Release control: owner-managed existing synthetic staging native cohort only; widen only after installed acceptance. Owner: founder; revisit at the next physical acceptance checkpoint. Build the reviewed merged source, retain signed Mac7/iPhone11 and all earlier packages, then use normal same-identity updates. Preserve app data, Keychain, journals, admissions and encrypted recordings. No uninstall, reset, grant or server-key replacement is a recovery action. A prior app package can be restored through the same guarded update path if needed, preserving all data; Mac7 cannot be used for another capture trial because its startup failure is known.

The iPhone cycling report is not yet reproduced against physical telemetry. Source inspection and local tests do not establish its cause or claim it is fixed. The updated screens narrow failures during the next device run. Mac physical ScreenCaptureKit success also remains unverified. Required acceptance: stable open; consent/preparation; deliberate synthetic Mac mixed audio and iPhone capture; confirmed stop; encrypted upload/processing; transcript; correct saved/reopened Core note; restart/interruption/revocation; correction invalidates stale review/Session Prep until explicit re-review.
