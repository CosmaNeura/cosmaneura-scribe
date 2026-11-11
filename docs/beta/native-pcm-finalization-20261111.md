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
  an otherwise valid 64-byte final tail. Native configuration notifications after
  **successful physical input freeze** no longer invalidate captured audio.
  Permission revocation, capture failures, and media-service failures remain hard
  events, including during a failed-deactivation retry. Active configuration
  changes and notifications before freeze confirmation remain hard events.

This does not suppress true processing backpressure or recover an incomplete
recording by uploading it as complete. Existing incomplete visits and saved audio
remain preserved. No storage format, source-authority rule, or consent gate changes.

## Validation and qualification

On the final code inputs:

- Both regressions failed before their respective fixes and passed afterward.
- Full PCM Release suite: 54 tests in 12 suites passed.
- Full native-recording Release suites: 133 XCTest tests passed, including two
  actual three-hour encrypted-PCM/short-lease continuation cases.
- Independent focused validation: 19 tests in five suites passed; independent
  source review reported no blocking findings.
- iOS device package compilation passed for `arm64-apple-ios17.0` using the
  current iPhoneOS SDK. Existing permission-API deprecation warnings remain.
- Diff whitespace checks passed. The retained Clerk source matches all 233 files
  in the current source lock; direct native-auth tests in an unassembled checkout
  were unavailable because its vendor directory was absent.

The unsigned local beta **98.1** validation candidate, its full-app build, signing,
installation, and physical QA are separate pending qualifications. Package-level
tests and compilation do not establish that the physical recorder is fixed.
Use only the existing qualified synthetic staging profile and invented data.
Do not enable new cohorts or use PHI in this rehearsal.

Before filming the final submission flow, test on the connected iPhone 12 with
native screen recording active and its microphone off. Confirm sustained capture
beyond the observed 2:30 failure, successful physical closure, complete final-tail
retention, upload, transcript review, and a saved note. Check short capture and
stop as well. Genuine input-consumption latency may still produce a fail-closed
overflow; a configuration notification synchronously inside a failed or
unconfirmed freeze remains intentionally unsuppressed.

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
