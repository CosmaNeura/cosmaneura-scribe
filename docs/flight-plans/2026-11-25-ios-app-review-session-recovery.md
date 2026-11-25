# Scribe iOS App Review session recovery

Tier 2. The shared provider renderer adds a deadline to native session-state reads. Build 98.2 could leave the retry disabled indefinitely when the bridge did not settle. An unchanged unavailable snapshot also left the same message on screen, although the tap had completed.

## Change and recovery

- Show progress immediately on a manual session check. If the native bridge returns the same unavailable state, direct the user to start a fresh sign-in. A four-second deadline releases the retry and reports the timeout.
- Treat a timed-out read like a rejected read for clinical access. Close the workspace and preserve recorder teardown and sign-out fences. An established unavailable state retains its explicit sign-in action. An unknown or invalid state requires a successful state read before offering that action.
- Keep the listener and snapshot ordering check. A late result from a timed-out read cannot reopen a workspace. Clerk authentication, token validation, Core access checks, and practice activation use the existing paths.
- To roll back, revert the renderer change and rebuild from a reviewed version. Hold any affected store candidate from release.

## Review candidate

Use the existing iOS staging realm and synthetic review practice. Verify the artifact’s bundle IDs, version, signing, native inputs, iPhone and iPad device families, and packaged recording Live Activity before upload. Keep manual release selected.

Check the dedicated review account from a fresh install and record access to the synthetic patient list. Verify email registration and resend against a controlled inbox, the equivalent Apple login through the Clerk-hosted screen and back into the app, and the Live Activity with an active recording. Exercise an unavailable session, a delayed reply, a fresh sign-in, and a full synthetic visit through saved-note reopening. Record the device, operating system, build, and result for each step.

The Apple social connection is configured in staging Clerk. Disabling it is the rollback for that settings change. Confirm alternate login remains usable and hold the store candidate if the Apple option is missing or its callback cannot complete. Email-delivery changes require tracing the active sender and checking inbox receipt after the change.
