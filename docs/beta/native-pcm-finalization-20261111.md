# Native PCM consumption and finalization

Risk: **Tier 2**, because the native encrypted recording graph controls audio
integrity and privacy. The single outcome is reliable consumption publication
and final drain. SOAP defaults, backend behavior, billing, and authentication or
consent policy are outside this change.

Tested code revision: `0090672179a912ab79000e1f554e170744e2ef29`, based on
the filmed build-98 source `f26b89d27b05716efd85a08cc271204057446228`.

## Evidence and change

Physical iPhone 12, Scribe build 98 (`f26b89d`), reproduced two failure sequences.
The latest take on iOS 27.2.1 recorded `driverAdmissionOverflow`, then capture
failure and physical closure. An earlier take reported a configuration change
after `inputFrozen`, followed by capture failure during shutdown.

Two deterministic regressions use invented PCM with explicit synthetic consent:

- The core finished consuming input, but its receipt stayed unconsumed until a
  driver's waiting task resumed. The consumer now couples release and consumed
  publication before returning. Waiters observe completion and cannot hold
  admission open. The single-unconsumed-buffer bound remains in force.
- A native audio-session configuration notification during deactivation discarded
  an otherwise valid 64-byte final tail. **New in this PR:** native configuration
  notifications after **successful physical input freeze** no longer invalidate
  captured audio. Permission revocation, capture failures, and media-service
  failures remain hard events, including during a failed-deactivation retry.
  Active configuration changes and notifications before freeze confirmation
  remain hard events.

This does not suppress true processing backpressure or recover an incomplete
recording by uploading it as complete. Existing incomplete visits and saved audio
remain preserved. No storage format, source-authority rule, or consent gate changes.

At most one in-flight tap buffer at the stop instant is not retained. That bound
is intentional: the gate admits one outstanding buffer of up to `frameCapacity`
(default **4,096 frames**), and a stop that races an unconsumed tap callback does
not keep that buffer after overflow or hard close.

## Validation and qualification

On the final code inputs:

- Both regressions failed before their respective fixes and passed afterward.
- macOS `swift test` result pending re-run at the new head (Debug and Release).
- Full native-recording Release suites: 133 XCTest tests passed, including two
  actual three-hour encrypted-PCM/short-lease continuation cases.
- Independent focused validation: 19 tests in five suites passed; Fable
  independent review rounds 1-3 returned HOLES, resolved in later commits;
  round 4 pending.
- iOS device package compilation passed for `arm64-apple-ios17.0` using the
  current iPhoneOS SDK. Existing permission-API deprecation warnings remain.
- Diff whitespace checks passed. The retained Clerk source matches all 233 files
  in the current source lock; direct native-auth tests in an unassembled checkout
  were unavailable because its vendor directory was absent.

Signing, installation, and physical QA of the local beta **98.1** staging
candidate are **unconfirmed** in this repository. The flight-plan commit
described them as pending; the PR description asserted a signed install and a
passed physical take. Neither claim is backed by a retained signed artifact,
device journal, or other independent evidence in the repo or PR history, so both
surfaces treat that state as unconfirmed rather than inventing one. Package-level
tests and compilation do not establish that the physical recorder is fixed.
Use only the existing qualified synthetic staging profile and invented data.
Do not enable new cohorts or use PHI in this rehearsal.

The post-freeze `configurationChanged` preservation branch is proven by
synthetic regression tests only. There is no device proof that a physical take
emitted `configurationChanged` after `inputFrozen` and retained its tail.

Before release filming, require several sustained takes on the connected
iPhone 12 with native screen recording active and its microphone off, and at
least one take whose journal shows `configurationChanged` after `inputFrozen`
with the final tail retained. Also confirm successful physical closure, upload,
transcript review, and a saved note, plus a short capture-and-stop. Genuine
input-consumption latency may still produce a fail-closed overflow; a
configuration notification synchronously inside a failed or unconfirmed freeze
remains intentionally unsuppressed.

Risk acceptance **pending John's sign-off:** a real audio-route or
session-configuration notice that Apple delivers on the `AppleAudioSystem` queue
just after freeze is confirmed can still be classified under this PR's new
post-freeze preservation rule. The width of that window depends on the queue
`AppleAudioSystem` delivers on; this change does not add a grace period or
second confirmation beyond physical freeze.

## Release and recovery

The owner controls any release after exact-revision independent review and
physical qualification. This work does not merge `main`, deploy a service,
dispatch hosted workflows, upload a build, or change App Store Connect.

For an unsuccessful local candidate, stop capture and preserve incomplete visits,
their encrypted queues, and diagnostics. Rebuild from the prior reviewed source
or restore the prior signed artifact in place using the same bundle and storage
identity. Do not uninstall the app or delete recording data as a rollback. The
prior artifact contains the known recording defects, so restoration is recovery
of the prior runtime, not evidence that this capture problem is resolved.
There is no schema migration, backfill, or data-cleanup rollback step.
