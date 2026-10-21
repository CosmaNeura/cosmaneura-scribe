# Store microphone sandbox repair — October 21, 2026

Risk: Tier 2, native recording capability boundary. Owner scope: repair and test
Scribe recording and submit the native Mac app for App Store review. This is
synthetic-only development qualification until actual runtime acceptance.

## Problem and outcome

The Store Audio XPC service is App Sandbox enabled but its signed claims include
only `com.apple.security.device.audio-input`. Apple documents that key for
Hardened Runtime; App Sandbox microphone access uses the distinct
`com.apple.security.device.microphone` entitlement. Build118 microphone access
returned unavailable after its bounded permission wait. The missing entitlement
is a concrete packaging defect; it is not yet proven to explain that timeout.

Add `device.microphone=true` only to Audio, retaining `device.audio-input=true`.
Update its exact runtime role allowlist to require both real CFBooleans. Parent,
Auth, Presentation and inherited Bridge receive neither audio permission. Auth
retains the only Keychain group. Group, peer/parent generation fences, consent,
capture authority, deadlines and storage do not change.

Apple references:

- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.microphone
- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input
- https://developer.apple.com/forums/thread/825449

## Retained deployed baseline

Core main means the protected default branch `master`. Its retained source is
`69b0f05bd9222aab6f36674c86d3258a9b1542bd`, tree
`6c0791a4023c4f3a5b735fb0cede0b39ef957983`. Web, worker and scheduler use the
accepted current-main publication ending in image digest
`2becf547e83c7a49a04ea3f94230937718de09625a8401232b25d43d743bbde7`.
Retain Session Prep sources and all84 migration sources, including source head
`9bcaa341475f`. This change does not query or apply live database migrations,
change Core configuration or require another deployment pause. The owner's
instruction prohibits restoring older Core images, including8d84/b6fd.

## Acceptance and release sequence

1. Run existing packaging claim tests and focused native strict role tests,
   including missing/false/numeric microphone values and grants on other roles.
2. Build the changed native inputs and audit every signed role's actual XML/DER
   entitlements, CodeDirectory identity, Team and approved certificate/profile.
3. Use normal Mac launch and the normal recording access action. Actual UI
   readiness, normal patient-consent gate and actual Recording must be observed.
4. Record the synthetic110-second fixture while another window is foreground;
   Finish, save, inspect allfour late markers and play saved passages directly.
5. Only after independent source and physical runtime acceptance, sign and
   package the Store candidate, audit its actual five roles, upload, select the
   processed build and complete the already-authorized Mac review submission.

Keep iPhone79's existing formal submission and the installed desktop97 intact.
No production workflow, signing identity, profile, dependency or account
credential is created or changed by this source patch. No hosted CI result is
claimed; Actions remains disabled under the owner's local-validation decision.

## Recovery

If qualification fails, close only the owned temporary test app, retain the
failure evidence and leave the candidate unsubmitted. Keep the installed app
and current Core deployment, Session Prep changes and new migrations. Correct
and independently review the native failure before a new bounded test. Never
use a Core downgrade, broaden another role or bypass consent as recovery.
