# iOS consumed-frame retirement

Tier 2: this change touches native PCM custody between the microphone driver
and capture core. It produces one outcome: a consumed frame no longer causes
a false driver admission overflow while its awaiting task is being scheduled.

## Observed failure and bounded cause

The physical build 88 synthetic run recorded, paused, resumed, and stopped
with an unsaved-tail warning. Its private numeric journal records
`driverAdmissionOverflow`, followed by capture failure and input freeze.
The earlier segments remain retained; the failed visit must not be reset or
replayed. Save, reopen, playback, and dashboard acceptance did not run.

Source inspection and the deterministic regression establish a narrower
race: the core can release a consumed frame before the driver's asynchronous
retirement completes. The original driver treats that scheduling gap as an
unconsumed frame. A controlled test seam holds retirement after consumption;
the old gate rejects the next frame, and the candidate accepts it. This does
not yet establish that the race caused the physical run's failure. A provider
request's completion timestamp alone is not evidence that network renewal
caused the overflow.

## Change and retained boundary

Observe the existing receipt's completed consumption and release before
allowing the next frame. Tag each frame so a late retirement cannot clear a
newer frame's admission. All copies of a receipt await the same completed core
release. Completion is awaited outside the receipt lock; the bounded synchronous
core admission release and consumed flag are published under the same lock used
by observers and copied waiters. This closes the release-to-publication interval
without creating an additional per-frame consumption task. At most one
unconsumed frame remains admitted. Actual unconsumed
overlap still fails capture and zeroizes the rejected frame; the regression
also verifies that behavior after a delayed old completion.

A second regression holds a nonempty admission release after its side effect,
then starts the next driver callback on a separate queue. The callback must wait
until consumption is published, then accept the next frame without a capture
failure. It also checks that copied receipt waits do not release admission twice.
The test wait is deliberately longer than the real synchronous flag clear; it
does not add a production hook or change the admission bound.

The deterministic retirement hook is internal and defaults to absent in
production. Consent, source authority, native generation fencing, storage,
encryption, input selection, and external contracts keep their existing
controls. This is source work only; it activates no production cohort.

## Validation and release sequence

1. Run both regressions and the existing native package. Initial candidate
   results: one focused regression and all 38 tests in nine suites passed. The
   controlled old-source regression compiles and fails the next-frame
   acceptance assertion. Its transparent test seam is retained in local
   evidence, rather than represented as an unmodified old package. For the
   final coupled-release revision, the full 39-test run passes both regressions
   and 36 other tests; the existing backup-exclusion metadata assertion fails
   under the command sandbox. A targeted rerun of that assertion and both
   regressions, using the unchanged compiled package outside that sandbox,
   passes all three checks. The pre-revision release-boundary negative control
   compiles and fails the intended assertion: a callback returns while the
   admission release is still held. All failed runs remain retained; these
   are local source checks, not live-phone or hosted-CI qualification.
2. Obtain independent review of the final pushed commit, publish its durable
   record, and merge through the owner's approved process.
3. Build a fresh signed iPhone candidate from merged main. Preserve the failed
   build 88 visit. Use a new explicitly consented synthetic visit for one
   recording of the 152-second fixture, one Pause/Resume, and one Finish.
4. Require a saved tail, Save confirmation, same-owner reopen, native Listen,
   audible playback, and matching dashboard content. Measure record-to-ready
   and first PCM separately. Keep release qualification open until those
   actual checks pass; package tests cannot supply the live result.

Owner: Scribe release operator in this chat. Initial cohort: owned synthetic
lab and attached test phone. Review the candidate before any wider release.
There is no schema, migration, receiver rollout, or new feature flag.

## Recovery

On a regression, hold candidate distribution and preserve the failed visit's
audio. Revert this source commit and rebuild the previous source while keeping
app data intact. The earlier build is a recovery source, not evidence that the
currently failed physical workflow has passed. Do not increase the queue,
skip consent or authorization, replay lost input, or repeatedly press Finish.
