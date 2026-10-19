# First Record to confirmed native Ready measurement

Tier 1: additive local diagnostic fields and fixed Desktop/Capacitor methods.
The initial explicit Record handler creates one renderer monotonic span before
admission and recorder creation. A Record queued during consent preparation
retains its original span. The bound capture view completes it only after that
Start command succeeds and its same native controller confirms recording.
Failed/cancelled starts, view replacement, revocation, Resume, recovered audio,
and repeated clicks cannot produce a successful observation.

This measures accepted handler entry to confirmed native Ready received by the
renderer, including pending preparation, admission, source setup and bridge
delivery. It does not measure OS touch/click dispatch latency, use native
`startRequested` as a Record timestamp, subtract clocks across processes, or
claim first-buffer/audio readiness or physical performance improvement.

Desktop writes the fixed `provider_record_to_native_ready` event and
`duration_ms` to its existing private runtime journal. Its actual build remains
bound by the signed package and observer receipt. iOS writes the fixed
`recordToNativeReady` event with `duration_ms` and optional native-derived
`build_number` to its existing private PCM startup journal. Duration is finite,
0–3,600,000 ms, rounded to 0.001 ms; build is an integer 1–2,147,483,647. No
identity, content, error text or arbitrary event name is accepted for export.
Existing lifecycle rows retain their two-field iOS format and existing journal
size/event/privacy limits. Native owners additionally require their current
confirmed recording state and accept at most one timing per owned recorder.

Frozen packages and observers remain unchanged. Future iOS observation must
explicitly admit this fixed event and its optional bounded numeric fields;
older strict decoders must not silently discard it. The new Capacitor method
needs full native product compilation in the future package qualification.
There is no authorization, consent, capture order, cache, label, helper lifetime
or microphone behavior change. The exact recovery is the prior qualified
client package; there is no server/schema/configuration rollout.

John Clemente owns the future staging Mac/iPhone beta qualification and
observation, with the owner's submission target tonight, 2026-10-19. Actual
package/device qualification and client/observer evidence are required before
broader distribution. Review the measurement on 2026-10-20 as follow-up; that
date does not require a next-day wait for submission. No package, sign, install
or physical test is part of this source change. Existing owner acceptance still
requires announced physical observation of the qualified builds.

Local evidence: 149 capture tests (including real workspace queued/initial/
cancel paths and synthetic native-controller races), 46 Desktop tests, five
Swift startup-journal tests, and both capture/Desktop TypeScript checks pass.
Swift syntax parsing covers the new plugin/bridge code; it is not a full
Capacitor/native product compilation. The synthetic tests use no OS microphone
or deployed service. Relevant lint and diff checks are recorded with the final
source receipt. Local checks are not hosted CI or physical latency evidence.
