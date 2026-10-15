# 0079 — Meter-only preparation, verified microphone changes and recording activity

The approved Scribe redesign adds a foreground microphone check before consent.
The native owner reads tap samples in place for a scalar RMS level and discards
them. It creates no PCM packet, clinical session, source grant, key or queue row.
The check lasts at most 60 seconds, closes on backgrounding, and participates in
the process-wide physical-idle barrier. Cancellation fences a late permission
response. A generation fence prevents old-route callbacks from publishing levels
under a newly selected device. Patient consent remains mandatory for the existing
admission and every recorded/stored capture path.

The selector uses actual available native ports and verifies the current route.
An exact UID never silently falls back to another accessory. Changing a microphone
in an active native recording closes and durably reconciles the existing interval
before obtaining a fresh source interval for the same encrypted session, key and
sequence. Pausing/starting feedback exposes the capture gap. A failed stop blocks
the restart, and a deliberate Pause or authentication change cancels a pending
input restart. Existing category-based callers remain compatible and cannot
overwrite an exact preflight device preference.

ActivityKit publishes only recording phase, elapsed time and its timer anchor.
The shared attributes module contains no patient, encounter, tenant, provider or
audio identifiers. The widget extension has no audio-engine dependency. Recording
starts its activity only after the native source is authorized and ready. Native
maintenance updates it while background audio continues; confirmed pause freezes
the timer, and final stop/close removes it. If maintenance stops updating, the
lock-screen content becomes “Check Scribe” after 15 seconds. A recording deep link
returns to the active recording; it grants no Start, Resume or consent action.
A bounded native pending bit retains a link that arrives before the renderer.
Read-only recorder metadata is revision-bound and mapped against a fresh authorized
catalog, with a second native read to fence a changed session. The UI focuses its
mounted recorder or uses the existing same-session recovery path. A revoked or
missing recorder does not authorize another visit or automatic recording.

Local Swift tests and simulator/device SDK builds verify software contracts and
package inclusion. They do not establish physical-device Bluetooth routing,
microphone quality, locked-device continuity or Dynamic Island behavior. Those
remain installed acceptance checks before a clinical release. Review candidates
are disabled and unsigned; this change enables no account or production rollout.
