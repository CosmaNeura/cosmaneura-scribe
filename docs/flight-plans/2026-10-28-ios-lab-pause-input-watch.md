# iOS lab input monitoring across a silent Pause/Resume boundary

Risk: Tier 2, because this changes the synthetic lab input-custody guard. No
product, consent, capture authorization, service, schema, or release change.

## Observed failure and scope

The Simulator21 run paused its owned BlackHole source at 16.7988125 seconds.
The recording-only HAL watcher then inspected the app during the ordinary
Pause transition and closed the source because the app was no longer in the
recording phase. The full 152.0943125-second fixture remains failed; normal
Finish/Save recovery of its partial capture does not change that result.

This change affects only the owned iOS simulator with its virtual microphone.
It leaves Record measurement and declared startup budgets unchanged.

## Change and retained boundaries

Before ordinary Pause, require fresh status from the same owned source:
paused, silent, unchanged offset and nonzero frame count, matching fixture and
BlackHole route, within the configured quiet window. Stop and drain the
recording-only watch only after that evidence is obtained. Retain that segment.

Before ordinary Resume, repeat the silent-source observation, prove the same
fresh paused recorder, verify the installed application, and require complete
idle HAL bookends. After Resume, establish the unchanged complete recording
input proof and a new watch before SourceGroup can schedule source audio.
Retain both watch segments and their aggregate. Failures or cancellation never
schedule more audio. Do not change or close foreign input clients.

## Validation and integration

The real watcher/adapter regression reproduces the old failure during native
Pause and passes with two retained segments after this change. Controls cover
source emission, changed fixture/route/offset, stale evidence, replaced recorder,
foreign readers, Pause/Resume failures and cancellation. The focused Appium,
HAL watcher, source and new boundary suites pass: 104 tests on Node 24.

New test lint passes. The adapter has three unchanged baseline lint findings
(two no-unsafe-finally and one no-useless-assignment); exact base/candidate
JSON findings were compared. No new lint finding is accepted.

Require independent review after the final substantive push. Select a new,
explicitly pinned lab runtime only after review. Preserve all old runtime,
journal, source, timing and failure receipts. Run the normal full fixture and
retain actual pause silence, both HAL segments, Resume, Finish and cleanup.
A source-only pass is not native acceptance or release readiness.

## Recovery

If the new runtime fails, close only its owned source through normal cleanup,
retain the target lease while any capture is unresolved, and inspect/recover
that exact recording without repeating Record. Keep the failed runtime and
receipts. Revert this commit or select the prior reviewed runtime for future
experiments; that prior runtime remains known to fail this iOS pause scenario.
Never overwrite a running scenario or its identity to make recovery pass.
