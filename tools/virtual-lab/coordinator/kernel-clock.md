# Owned kernel clock measurements

This optional, read-only helper supports prospective native timing measurements.
It does not change the coordinator, source playback, capture permissions or
product requests. Existing browser timing remains `UNKNOWN`. A clock mapping is
not a product performance, source synchronization or clinical acceptance gate.

The supported Node runtime is **24.22.1 / libuv 1.53.0**. Its Darwin
[`uv__hrtime`](https://github.com/nodejs/node/blob/ce7aaf1cee78b8cf0ce17364260535c418d3ed26/deps/uv/src/unix/darwin.c#L60)
scales `mach_continuous_time()` into nanoseconds with integer arithmetic.
Continuous time includes system sleep. Apple's
[`DispatchTime`](https://github.com/apple-oss-distributions/libdispatch/blob/2361ffb78a76f7ee488cd052eb0bc5c767118bf9/src/swift/Time.swift#L28)
uses uptime, excluding sleep; the Swift property converts raw ticks with integer
arithmetic. The underlying
[`_dispatch_uptime`](https://github.com/apple-oss-distributions/libdispatch/blob/2361ffb78a76f7ee488cd052eb0bc5c767118bf9/src/shims/time.h#L139)
uses `mach_absolute_time()`. These domains must not be treated as identical.
Those source references explain the contract; the helper also verifies the
actual raw-tick/Dispatch conversion and the Node bracket on each sample.

Compile in an owned output directory with the target's supported macOS SDK:

```sh
xcrun swiftc -swift-version 5 -parse-as-library \
  -module-cache-path "$OWNED_CLOCK_CACHE" \
  -o "$OWNED_CLOCK_HELPER" tools/virtual-lab/coordinator/kernel-clock.swift
```

The reviewed run operator must verify the owned target marker, hardware hash,
helper bytes, executable path, PID and process start. Start the helper with
`--scribe-virtual-lab-owner=<run-UUID>` and use its private stdin/stdout pipes.
For each request, mark `process.hrtime.bigint()` immediately before writing
`{"operation":"sample","nonce":"<fresh-UUID>"}` plus newline and immediately
after receiving that complete correlated reply. Enforce the full two-second
request deadline and abort on unexpected, extra or malformed output. Do not
substitute a cached native or helper response. The helper accepts at most 64
requests, exits on EOF or parent loss, and has a 15-minute lifetime. It does not
construct an audio graph or inspect audio devices. Output is nonblocking and
each response has a two-second write deadline with parent/lifetime checks, so
an alive parent that stops draining stdout cannot hold the helper indefinitely.
Run `kernel-clock-protocol.py <owned-compiled-helper>` for the actual pipe
saturation and EOF regressions.

Pass the raw response, both Node timestamps and the independently verified
identity to `projectKernelClockSample`. Retain those raw inputs for later
analysis. The projected object is immutable; serialized projections cannot be
used as trusted inputs without validating the original raw inputs again.

Collect a sample before and after the measured action using the same helper,
parent, boot session and hardware. `boundKernelClockWindow` retains a hull of
the continuous-minus-uptime bounds instead of erasing sleep with an
intersection. A resolved offset increase rejects performance classification.
The hull conservatively covers any smaller unresolved sleep change. Arithmetic
uses integers and outward rounding, with an explicit nanosecond allowance for
independent conversion truncation. API `clock_getres` values are reported as API
claims; they do not establish browser resolution or arbitrary physical-clock
accuracy. Clock frequency accuracy is not measured by this tool.

`boundNativeResponse` accepts only actions and native events inside the sampled
window. Use a bracket around the actual normal UI dispatch and independently
attribute the event to the current app, recorder, capture attempt and journal.
A conservative upper bound can be within the frozen budget; a lower bound can
exceed it. A threshold-crossing or unresolved action/event ordering remains
indeterminate. UI automation latency stays in the dispatch bracket; it is not
speculatively subtracted. Native buffer readiness and visible usable controls
remain separate required evidence.

The helper checks `AVAudioTime` conversion round trips but makes no global
floating-point error claim. The existing source helper's callback timestamp is
an output callback observation, not proof of acoustic arrival. Source frame
counts, signal thresholds, device custody and actual native input remain
separate gates. No existing run receives retroactive qualification.

Recovery is to stop the owned read-only helper and retain partial measurements
as unqualified. No app, device, clock, power, security or backend state needs to
be restored. Do not broaden this into a network-delay injector or use the
standalone Toxiproxy echo as native application latency evidence.

## Optional collector

`createKernelClockCollector` verifies an owned target marker, exact helper bytes,
current hardware/boot identity and the newly spawned child's executable/start.
Its target configuration must include the independently pinned `hardwareSHA256`.
The helper is confined to the target root. The collector starts no native app,
audio graph, browser, or product request and does not acquire a UI lease.

Call `sample({signal, deadlineNs})` with a current absolute Node `hrtime` deadline
no more than two seconds away. The collector records immediately before pipe
dispatch and after the complete reply, checks the deadline again on receipt,
and retains raw, correlated inputs. It accepts one outstanding request, at most
64 samples, and at most 8 KiB per reply. Malformed, extra, replayed or late
responses poison later samples. No request is retried. Lifetime cancellation
closes the owned helper; callers also await `close()` in their `finally` block.
EOF, TERM and KILL cleanup each have a one-second wait and signal only the owned
child. An unconfirmed close remains an error. Partial samples remain evidence,
not a qualified result.

Retain `launchReceipt` and `snapshot()` in a private run artifact, along with the
normal native app identity and owned-process journal export. A snapshot itself
is `NOT_ESTABLISHED`; `window(before, after)` separately validates two fresh
samples belonging to that collector. Native journal event parsing includes the
current fixed packet-persistence and terminal reason enums; unknown events are
still rejected. Parsing never establishes native process/session attribution.

The exported prospective budget table is cold launch 10 s, warm launch and
workspace 4 s, consent-to-ready preparation 7 s, and Record/Resume to confirmed
input 4 s. These prospectively reviewed engineering budgets are not user-agreed SLAs.
They must be frozen with the
actual client, backend cohort, action boundaries, and UI readiness assertions
before a run. They do not replace the engine's existing informational budget
log or qualify earlier runs. Record operator/tool waiting separately, and
report improvement only against a comparable measured baseline. This collector
does not dispatch or time actions on its own.
