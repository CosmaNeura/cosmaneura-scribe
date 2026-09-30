# Desktop readiness benchmark

Run from the repository with its pinned Node 24 dependencies installed:

```sh
node apps/desktop-companion/test-tools/desktop-readiness-benchmark.mjs --output /tmp/scribe-readiness-run-1
```

The output directory must be new and its parent must exist. Add `--profile moderate-dependencies --runs 3` for repeated samples. Profiles are `local-zero-delay`, `moderate-dependencies` (remote boundary 300 ms, permission probe 700 ms, native-ready 400 ms), and `slow-dependencies` (900 ms per injected boundary). The default runs each profile once. This is an opt-in benchmark; normal unit tests do not run it.

`--preparation combined` (default) exercises the current fresh-visit client preparation with one public bind/issue/reserve operation. `--preparation legacy` exercises the older three-request path under the same inputs. The combined fixture executes the three mock primitives in sequence, retaining their exact request keys, with one injected public round trip. This proves the client dependency reduction and recovery path, not the elapsed time of real Core/Scribe authorization, HTTP or database work. Both paths keep key publication, fresh capabilities, durable custody and source-start authority checks.

`--continuation combined` (default) exercises the current paused Resume client with one public continuation operation. `--continuation legacy` retains separate capabilities/renew/reserve requests for a matched control. The combined fixture preserves the actual lease/reservation methods but models the server's batch selection for this one-chunk scenario; the Scribe transaction and replay policies have separate backend tests. Local custody, confirmed retirement, current creator/consent checks and fresh native start gates remain separate. It does not measure continuous mid-recording renewal. Schema 3 receipts predate continuation selection and used legacy Resume; schema 4 records both choices. Schema 5 settles interrupted owners automatically and reports the full interruption-through-immediate-resume time separately from the Resume click. Moving retirement earlier is not an improvement in that full elapsed time.

Choose the operation model independently of the delay profile:

| `--model` | Source start and Resume behavior |
| --- | --- |
| `modern-clean` (default) | Combined remote source preparation/authorization, followed by local consume-once. Successful Pause removes the real backend's source owner, so Resume retirement makes no request. |
| `modern-interrupted` | Same modern source contract; simulated device disconnection automatically settles the retained owner. Resume stays unavailable until physical stop, durable pause and original-owner retirement finish. Reports both Resume click time and the entire interruption-through-immediate-resume time. |
| `legacy-clean` | Explicit known-404 combined-route fallback, separate remote preparation and authorization. Clean Pause still makes Resume retirement a no-op. |
| `dependency-sensitivity` | Historical fixture: every trusted callback receives the injected API delay, including local authority consumption and empty-owner retirement. Retained for sensitivity comparisons; it does not model normal modern Mac round trips. |

For three modern clean samples at each nonzero profile, use separate new output directories:

```sh
node apps/desktop-companion/test-tools/desktop-readiness-benchmark.mjs --output /tmp/scribe-modern-moderate --model modern-clean --profile moderate-dependencies --runs 3
node apps/desktop-companion/test-tools/desktop-readiness-benchmark.mjs --output /tmp/scribe-modern-slow --model modern-clean --profile slow-dependencies --runs 3
```

The benchmark exercises the real recorder, capture flow, encrypted temporary SQLite storage and cloned recorder IPC with a loopback mock BFF. Each fresh store receives invented consent and synthetic identifiers. Only invented zero-valued PCM is supplied. Native helpers, microphone capture, installed applications, accounts and remote services are never used. Temporary databases and servers are closed by the test fixture. The runner also removes its owned temporary directory after exit; on macOS/Linux its deadline terminates the dedicated test process group.

`RESULT.json` records the selected model and preparation path, source hashes before and after the run, invocation, exit status and action times. A changed or missing input makes the runner fail even if its synthetic tests passed; the measurements remain available for diagnosis. Per-run JSON files contain spans, boundary classifications, injected delays, successful ordering assertions and state transitions using only fixed names and elapsed times. `benchmark.log` contains the synthetic test runner output. Existing receipts are never rewritten; schema 1 results from before model selection are the historical dependency-sensitivity fixture. Schema 2 predates combined preparation selection and uses legacy preparation.

Modern and legacy modes run `src/native-provider-backend.ts` for actual source ownership and removal/retry behavior. Only its native RPC boundary is replaced: the small synthetic owner follows `NativeSourceStartOwner.swift`'s known-404 fallback, 15-second decision and consume-once contract. It does not execute Swift or native IPC, measure token retrieval, or reproduce each HTTP request inside the receiver. `simulated-remote` means one modeled public/native operation, not an observed network request. `loopback-bff` timings include the injected delay and the local mock response; `local-consume-once` and `no-op` receive no artificial delay. `dependency-sensitivity` retains the earlier callback-delay behavior.

Regression tests exercise the modeling defect directly: premature/double start or consumption, expired decision, late cancelled preparation, same-owner retry after lost retirement, and known-404 legacy fallback. Timed scenarios assert picker → source preparation → decision consumption → fresh source probe → native start → ready → activation → Recording, plus physical stop before owner retirement. Interrupted Resume also checks retirement before lease renewal. Permission/start authority and native readiness remain separate gates.

- `cold-open-fresh-store` measures first recorder preparation after the fixture is initialized. It excludes app launch, sign-in, consent interaction and fixture setup.
- `repeat-open-retained-ready` reopens that same prepared synthetic visit from durable storage.
- `recording_snapshot_ms` ends when the real controller publishes Recording through the cloned IPC. It follows the **simulated** native-ready boundary and durable coverage write; it is not proof of physical audio capture.
- `first_state_update_ms` measures controller-to-view event delivery. It does not measure browser paint or a usable screen.
- Start uses an immediate synthetic window choice. Human selection time is excluded. Resume retains the same visit and saved work.

A run below four seconds proves only that dependency profile. The delays are explicit inputs, not measured staging/OS latency. Use physical capture-ready evidence, browser paint timings and content-free backend stage logs as separate acceptance gates; a fast spinner update does not satisfy recording readiness.
