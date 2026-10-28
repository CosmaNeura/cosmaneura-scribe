# iOS lab paused-input reader latch

Risk: Tier 2, because this lab-only change touches a synthetic-input safety check. No product binary, receiver, consent, account, source audio, or deployment setting changes.

The full02 Simulator21 run started recording, then stopped its synthetic source at 16.70625 seconds for normal Pause. Complete current HAL snapshots showed no running input client. The idle inspection nevertheless forwarded the reader latched during recording, so the unchanged classifier returned `latched_input_reader_changed`. The next Resume was never dispatched. The actual failed journal and raw metadata are retained; this change does not qualify that full fixture.

Pass the expected reader only for a required active-input inspection. Keep the adapter's reader latch intact so the resumed recording must still use the same installed reader. Before Resume, retain the existing same-recorder paused/native checks, installed application verification, complete HAL bookends with every runningInput false, and silent source proof. The source cannot resume until the full recording watcher is established again.

Validation uses the production adapter method and HAL classifier against retained metadata-only actual snapshots. The prior source fails the idle-reader regression. Controls retain the reader during resumed recording and refuse changed or foreign readers. Existing pause cancellation, source silence, native identity and watcher tests also apply. Live full-fixture qualification remains open until a new maintained run succeeds.

Integrate only after an independent review at the final pushed head. No live runtime is changed in place. A future scenario selects the exact committed lab implementation and retains its failed predecessors. If the new runtime fails, stop its owned synthetic source, inspect the same capture, and use normal product terminal recovery. Reverting the one argument restores the prior conservative refusal without touching saved data.
