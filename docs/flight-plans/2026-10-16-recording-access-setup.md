# Recording access setup and consent boundary repair

Risk: **Tier 2**, because this changes preparation at a native permission boundary. Owner: John Clemente. Implementation and release coordination remain within the owner-authorized Scribe beta rollout. Initial cohort: the owner's existing beta Mac and iPhone; review after the next physical acceptance round, by 2026-10-17.

## Outcome and deployed evidence

Installed Mac 84 could not list calls despite Screen Recording appearing enabled. Targeted TCC evidence identified the responsible parent as `com.cosmaneura.scribe.beta.desktop`: its saved ScreenCapture code requirement still described Apple Development signing by John Clemente (`86G53QQW94`), while the installed release uses Developer ID Application team `JVV65668U6`. The visible toggle was a stale approval. Microphone attribution also pointed to the parent and was allowed; helper identity changes are not supported by this evidence.

The owner subsequently started and stopped six seconds of an in-person recording in build 84 and confirmed that upload opened note review. That observation establishes recording entry, stop and the review transition; it does not qualify call discovery or clinical use. Earlier signed iPhone 69 packaging checks establish code/profile integrity, not clinical recording acceptance.

Preparation also automatically started native microphone engines and taps on both platforms before a consent record. `CLAUDE.md` requires a valid consent record before every audio-processing path. Preparation must therefore enumerate devices and read permission status without acquiring audio. The existing consent-authorized recorder remains the source of live input levels.

The measurable result is: no microphone samples during preparation, explicit access setup succeeds or reports actionable denial, call selection refreshes actual OS access, and recording starts only after validated Core consent/admission and existing native authority.

## Behavior and retained boundaries

- Opening preparation, choosing room/call, selecting a microphone and refreshing calls enumerate bounded metadata only. They never request permissions automatically, activate an audio session, create an engine/tap, emit meter samples, admit a capture session or allocate recording custody.
- The provider's **Check recording access** action uses existing native permission-request modes. macOS/iOS retain their own prompts and decisions. Screen denial has a closed status separate from lookup failure. If the Mac toggle is already on, the screen explains manual off/on in System Settings, reopening Scribe if macOS requests it, and checking again. No TCC reset, automatic approval or signing-identity workaround is introduced.
- Setup remains authorized-encounter scoped. Renderer input IDs are opaque; hardware UIDs and process/window identities remain trusted native/main inputs. Forged fields, unknown IDs, unknown statuses and obsolete pre-consent meter payloads fail closed.
- Closing or revoking preparation cancels and joins the non-recording helper before releasing its owner. A late permission/selection result cannot restart preparation or recording. Main cannot open a recorder while preparation remains owned.
- Actual recording still requires fresh Core consent, capability/lease, selected-window validation, source fence, visible indicator, OS permissions and confirmed-stop ownership. The existing recorder supplies live input levels after admission. Silence never implies an end, and no saved audio or queue data is removed.
- iOS may defer its system-default route until authorized Start when inactive device enumeration is empty. A named choice must still be an advertised physical UID; actual route switching and validation remain in the authorized recorder.

## Validation and review

Use invented device/window labels and patients only. Local JavaScript checks cover catalogue-only transport, denied hardware selection, exact scoped access IPC, screen-denial propagation, legacy-level rejection, explicit-request cancellation/close barriers, delayed-response fencing and the retained consent/Start continuation. A native metadata-only pipe test exercises the real Mac preparation command/output lifecycle with a fake catalogue and no OS/audio access; iOS has a pure permission/preparation state test. Compile the changed native packages and run their focused/full suites. Build the final provider renderer and inspect its real preparation controls before signing.

Local checks are not hosted CI, OS permission acceptance or physical recording qualification. Root records actual commands, final source hashes and candidate binding; a nonimplementer independently reviews the final substantive pushed head. Keep the combined repair below 2,000 changed lines and 50 files.

## Release, hold points and recovery

This is one source-only repair on merged Scribe main (`33d8834672d6e101a4c6f4585e34c1713e420a2c` before this change). No Core/native-receiver deployment, database schema, custody format, account, entitlement or credential change is required. The existing verified receiver/Core remain in place. OpenAPI regeneration is N/A: no service API changes. The closed local IPC contract travels with the matching renderer/main/native package.

Root owns exact-source builds, independent review, merges, signing/notarization and normal controlled install/distribution. New Mac/iPhone candidates must include the repaired preparation source; preserve signed Mac 84 and iPhone 69 as recovery artifacts. Use the existing owner beta cohort and local candidate channel. No feature flag is added: the consent boundary is mandatory, with candidate installation as the reversible release control.

Hold before install on failed compile/review, mismatched helper or renderer hashes, unconfirmed stop, active recording or unresolved saved-audio upload. Physical acceptance must first show no pre-consent listening or automatic prompt; then explicitly deny/check-again access, repair the stale Mac approval through the user's normal Settings flow, select the actual call, confirm consent and reach recording readiness. Record actual pause/resume/finish and upload results separately. Abort promotion on any audio before consent, authority bypass, loss of stop confirmation or unresolved access failure.

Recovery retains the previous signed app, settings, encrypted queues and Keychain custody. Confirm capture stopped and saved work remains available before restoring an app bundle. Never uninstall, clear user data, delete audio stores or reset TCC as recovery. A prior app with the pre-consent defect is retained for recovery evidence, not qualified clinical use. No irreversible cleanup is authorized; retain rollback artifacts through the physical acceptance observation window.
