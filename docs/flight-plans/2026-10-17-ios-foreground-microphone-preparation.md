# Recover iOS microphone preparation after foreground loss

Tier2: preparation lifecycle and its join before consented recording admission.
Owner: John. Release control: the existing internal iPhone beta cohort, with
acceptance at the next beta recording check. This focused correction changes
only the iOS microphone-metadata adapter and regression tests.

Physical build71 showed “Microphone unavailable” and a disabled Record button
after native foreground loss ended its preparation owner. Reopening a fresh
synthetic visit recovered it and completed recording/input/release/save. The
JavaScript adapter could keep polling an ended native owner without reopening
it, requiring the provider to repeat setup.

Invalidate stale ready metadata on a visibility transition, serialize metadata
operations, and attempt one new metadata begin for a current visible unavailable
episode. Persistent unavailable/malformed/idle-rejected results do not spin or
steal another owner. Generation, foreground, local/account abort and native
idle/ownership guards remain. Close invalidates immediately, joins dispatched
metadata work, then ends native preparation before recording may be admitted.

Recovery never requests permission, selects hardware, activates audio, starts
capture, creates admission/authority/session, or changes consent. An explicit
permission request spanning background stays rejected and is never replayed.
Automatic ready metadata cannot clear the shared failed-permission latch; a
deliberate successful access check is still required. Native code, encryption,
upload, source authorization and API contracts are unchanged.

Validation includes25 focused regressions, capture typecheck, focused lint and
provider bundle build. The unchanged original adapter fails nine of the new
metadata checks, demonstrating the lifecycle defect. Independently review the
last substantive pushed commit and record SHA/findings/dispositions before
merge. GitHub Actions remains disabled under the owner's local-validation
decision. No schema migration or dependency/configuration change applies.

Build and deliver the next signed iPhone beta from merged source using the
existing native/signing/release process. Preserve current Apple account,
entitlements, provisioning, recording code and beta groups. Verify foreground
return recovers metadata, explicit permission-failure behavior stays correct,
and a fresh synthetic recording reaches native input, native stop and saved UI.
Repeat physical final-Record-to-native-ready timing; this lifecycle correction
does not establish the five-second target. If devices are locked, continue
source/build/review checks and queue physical UI verification until accessible.

Recovery restores the preceding beta candidate and reverts this adapter change
if lifecycle or admission custody regresses. Preserve recordings and notes;
no data deletion, schema rollback or production promotion is required.
