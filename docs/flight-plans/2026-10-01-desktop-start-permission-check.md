# Desktop permission validation inside native startup

Risk: **Tier 2**, because this consolidates a platform permission boundary.
Owner: John Clemente; implementation/release coordination: the current Scribe task.

## Problem and change

The existing desktop path launches an availability helper after consuming current
source authority, then launches a capture helper. The capture helper checks the
same macOS microphone and screen-recording permissions before looking up windows
or creating audio sources. The slow dependency model charged both process paths;
interruption through immediate Resume took 4.56 seconds.

An explicit trusted-driver capability lets desktop native startup own that final
permission check. Initial/Resume UI probes remain. The shared PCM lifecycle keeps
the existing separate preflight for every bridge without that capability,
including the iPhone bridge. No probe result is cached or reused as authority.

The public MacMeetingAudio initializer still selects the actual macOS permission
function. An internal initializer permits denial-only synthetic testing of the
actual start method before any WindowServer or audio setup. This internal seam is
not an IPC field, a runtime setting, or a release permission bypass.

## Boundaries retained

- Physical stop, pending encrypted writes, durable pause and original Core source
  retirement complete before continuation renewal or new source authorization.
- Fresh current account/consent/lease decisions and consume-once capability
  validation remain unchanged. No Core/Scribe service or authentication changes.
- The main process rechecks unlocked-session state and the pinned helper's
  integrity in the owned startup path, after asynchronous selection verification.
- Native start checks current OS permissions before source setup; it also retains
  current selected-window/PID validation, capture deadlines and source fencing.
- Readiness denial or timeout retains the existing handle for discard/closure.
  No activation, PCM delivery or successful coverage precedes readiness.
- Stop/cancel can win while native readiness is pending; a late reply cannot
  activate the source. Existing uncertain-stop warnings and custody remain.

## Validation and limits

Run the existing synthetic Swift pipe fixture against current source, native
permission denial/disabled/stopped tests, desktop source/controller tests, iOS
bridge/lifecycle tests, type checks, lint and the provider build. The current
desktop model keeps all injected durations unchanged, models the permission check
inside native readiness, and checks the complete interruption-to-resume budget.
Record command receipts, source hashes, source commit/tree and small-sample
statistics in the PR evidence.

These tests use invented consent and controlled PCM. They do not record hardware,
read accounts, call external providers or qualify physical startup/GUI latency.
Actual deployment qualification still needs the content-free native timings and
observed first-audio/readiness from the matched Mac candidate. Opening latency is
a separate target and is not improved by this change.

## Release and recovery

Use the existing Mac staging-beta release control, initially the owner's single
test Mac. Root reviews the exact source before preparing a new matched package;
the already frozen Mac45/iPhone60 packages remain unchanged. Review the cohort
after the next physical acceptance round, by 2026-10-08. No automatic wider rollout.

This is backward-compatible with the current capture helper's existing native
permission guard, but packaging should continue binding renderer/main/native
inputs together. No schema, storage format, provisioning, API or migration change.
If denial, startup, cleanup or physical timing regresses, stop capture normally
and restore the previously qualified Mac package. Its duplicate preflight returns;
existing encrypted recordings and Keychain custody are retained. Never reset or
uninstall to perform rollback.
