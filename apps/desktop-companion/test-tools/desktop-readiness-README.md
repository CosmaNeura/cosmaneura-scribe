# Desktop readiness benchmark

Run from the repository with its pinned Node 24 dependencies installed:

```sh
node apps/desktop-companion/test-tools/desktop-readiness-benchmark.mjs --output /tmp/scribe-readiness-run-1
```

The output directory must be new. Add `--profile moderate-dependencies --runs 3` for repeated samples. Profiles are `local-zero-delay`, `moderate-dependencies` (API 300 ms, permission probe 700 ms, native-ready 400 ms), and `slow-dependencies` (900 ms per injected boundary). The default runs each profile once. This is an opt-in benchmark; normal unit tests do not run it.

The benchmark exercises the real recorder, capture flow, encrypted temporary SQLite storage and cloned recorder IPC with a loopback mock BFF. Each fresh store receives invented consent and synthetic identifiers. Only invented zero-valued PCM is supplied. Native helpers, microphone capture, installed applications, accounts and remote services are never used. Temporary databases and servers are closed by the test fixture. The runner also removes its owned temporary directory after exit; on macOS/Linux its deadline terminates the dedicated test process group.

`RESULT.json` records source hashes before and after the run, invocation, exit status and action times. A changed or missing input makes the runner fail even if its synthetic tests passed; the measurements remain available for diagnosis. Per-run JSON files contain spans and state transitions using only fixed phase/status names and elapsed times. `benchmark.log` contains the synthetic test runner output.

- `cold-open-fresh-store` measures first recorder preparation after the fixture is initialized. It excludes app launch, sign-in, consent interaction and fixture setup.
- `repeat-open-retained-ready` reopens that same prepared synthetic visit from durable storage.
- `recording_snapshot_ms` ends when the real controller publishes Recording through the cloned IPC. It follows the **simulated** native-ready boundary and durable coverage write; it is not proof of physical audio capture.
- `first_state_update_ms` measures controller-to-view event delivery. It does not measure browser paint or a usable screen.
- Start uses an immediate synthetic window choice. Human selection time is excluded. Resume retains the same visit and saved work.

A run below four seconds proves only that dependency profile. The delays are explicit inputs, not measured staging/OS latency. Use physical capture-ready evidence, browser paint timings and content-free backend stage logs as separate acceptance gates; a fast spinner update does not satisfy recording readiness.
