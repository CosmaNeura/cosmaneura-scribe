# Mac Chrome and Zoom window discovery

Risk: **Tier 2**, because this separates a macOS permission boundary and extends the existing native metadata contract. Owner: John Clemente. Implementation and release coordination: the current Scribe redesign task. Initial cohort: the owner’s beta Mac. Review the cohort after the next physical acceptance round, by 2026-10-17.

## Problem and behavior

Installed Mac build 83 reported “Calls could not be loaded” and disabled selection while Screen Recording and Microphone settings appeared enabled. The owner clarified that several ordinary, non-video Chrome tabs were open, yet the chooser offered no options. This physical failure is recorded; its cause is not established by the synthetic tests. A separate microphone-start failure (`device_changed` before `audio_ready`) has its own startup correction and is outside this discovery change.

The presentation helper previously checked both microphone and screen permissions before enumerating window metadata, although it owns no audio-input claim or audio source. This change checks ScreenCapture preflight only for enumeration. Denied access avoids lookup; lookup failure, cancellation and the existing 64-window limit retain closed outcomes.

Discovery enumerates on-screen Chrome or Zoom **windows**, using each window’s current native title. It has no video-call, URL, page-content or call-title predicate. An ordinary Chrome documentation window is eligible. Background tabs inside that window are not separate native window choices; minimized or off-screen windows are outside the current on-screen enumeration. The new synthetic ordinary-Chrome test asserts that a non-call title remains eligible at the metadata seam. It does not substitute for physical WindowServer enumeration.

## Boundaries retained

- Enumeration requests no permission, creates no audio source or screenshot, and does not start capture.
- Actual call capture still requires both ScreenCapture and Microphone permissions in the separate native capture owner. Existing consent, fresh source authorization, account/lease fencing, selection validation and confirmed-stop handling remain required.
- Only the existing version-3 window-list `unavailable` reply gains an optional diagnostic: `screen_access_denied`, `lookup_failed` or `window_limit_exceeded`. Older replies remain accepted. Extra fields and unknown codes fail closed.
- Main maps these codes to fixed local events. No raw native errors, window titles, process/window identifiers, URLs, credentials, patient data or audio enter diagnostics. Existing private-file and record-count bounds remain in force; observer failure cannot affect authority.
- No service route, cloud configuration, identity, credential, consent, lease, storage format or schema changes. Core and the native receiver remain on the already verified rollout.

## Validation and acceptance

Root executed the final native package successfully: **68 Swift tests and four XCTest cases passed**, including the ordinary non-video Chrome-window regression. The isolated full log and source/binary-bound receipt are recorded under `/private/tmp/scribe-mac84-call-window-final-native-20261016/`. The prior full desktop TypeScript check, focused lint with zero warnings and 26 focused JavaScript tests passed; their source inputs are unchanged by the added Swift test and this document. Local evidence is recorded in `/private/tmp/scribe-window-metadata-fix-20261016/`; it is not hosted CI or GitHub approval.

The source review covers denied/canceled metadata lookup, bounded discovery, compatible unavailable replies, unexpected-field rejection, diagnostic redaction and retention of the actual capture permission boundary. After the final substantive push, a nonimplementer must record the exact reviewed head and findings on the PR. Keep the change within 2,000 changed lines and 50 files.

Final physical acceptance is pending on the matched signed Mac candidate: ordinary visible Chrome windows and a synthetic active call should appear; chooser selection and cancel/refresh should behave correctly; no audio starts during enumeration or selection. Actual authorized Start must retain both permission gates and reach recording readiness. Pause, resume, finish and recovery must remain intact. Record only fixed failure codes and timings; use invented patients and nonclinical test speech. The installed build 83 observation and prior source/mock results do not establish success of this retest.

## Release and recovery

Root owns compilation, package binding, signing, notarization and controlled installation from the reviewed merged source. Preserve the previous qualified Mac package and match renderer/main/native inputs in the new candidate. Release authorization follows the current owner-approved beta rollout; this plan adds no workflow, environment or security-policy change.

If discovery, selection or capture regresses, confirm native stop, then restore the previous qualified package. Retain app identity, Keychain custody and encrypted work. Do not reset permissions, uninstall, clear user data or delete recording stores as recovery. There is no migration rung for this source-only change.
