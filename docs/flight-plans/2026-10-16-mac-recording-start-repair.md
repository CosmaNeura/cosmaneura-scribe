# Mac recording startup repair

Risk: Tier 2. The owner authorized the Scribe redesign, merges and app rollout,
then reported that installed Mac build 83 could not start recording.

Two metadata-only startup traces showed the audio helper spawning, reporting
`audio_device_changed`, and confirming stop before `audio_ready`. Both failed
selection and engine-configuration notifications previously used this result.
The source also classified every engine notification as a device disconnect,
including notifications while its own microphone setup was still starting.

The repair keeps selection of an already selected input a no-op and verifies
the actual hardware device. Configuration notices now compare the selected
device UID and complete capture format on the source owner actor. Startup may
have a stopped engine only while that device and format remain identical;
before Ready and throughout recording the engine must also be running.
Changed or missing inputs, changed formats, sleep and session loss still stop
through the existing capture ownership and confirmed-stop path. Consent,
capture authority, duration limits, stored audio and automatic restart rules
are unchanged.

Validation: compile the frozen native package, run its full Swift tests and the
four startup/device/format/stopped-engine regression cases, independently review
the final commit, then check the signed replacement package and notarization.
A stopped-engine hardware probe observes metadata only and cannot establish
recording acceptance. Record actual installed recording behavior separately.

Release: build 84 replaces only the Mac audio helper and its hash pin in the
existing installed profile. Keep the app identity, Electron runtime, account,
keychain groups, renderer, auth and presentation helpers. Close through the
normal app flow and require no active app process before installation. Preserve
builds 83 and 82 for reversible recovery; never uninstall or reset user data.
No backend deployment or database change is needed for this repair.
