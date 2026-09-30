# iPhone virtual performance lab

This lab measures the real provider JavaScript, native adapter, workspace,
creation-retry owner, input meter and native recording host with synthetic inputs.
It does **not** measure a physical iPhone or claim the four-second target is met
on a device. No microphone, installed Scribe app, account or clinical data is used.

The browser runs in isolated headless Chromium at 390 × 844. Native/Core responses
and their delays are explicit fixtures. A loopback server serves only the generated
HTML, JavaScript and CSS; other browser requests are blocked, and media APIs throw.
Swift runs on macOS with in-memory service/storage, an ephemeral non-persistent RSA
key and generated PCM. Its source and driver stand-ins never open audio hardware.

## Run

Use the repository's Node 24 runtime and installed dependencies. Pass a **fresh
output directory outside the checkout**; the JavaScript build refuses every existing output directory, even an empty one;
the native build refuses a prior Swift build directory. Symlink parents resolve
to physical paths before the checkout exclusion check. No dependency installation is required.

```sh
node apps/capture/test-tools/iphone-performance/build.mjs --output /tmp/scribe-iphone-performance-run1
node apps/capture/test-tools/iphone-performance/browser.mjs --output /tmp/scribe-iphone-performance-run1
node apps/capture/test-tools/iphone-performance/verify.mjs --output /tmp/scribe-iphone-performance-run1
```

All commands accept `--checkout /path/to/checkout`; the default is this checkout.
The browser supports `--filter recording` to replace just those result rows in an
existing report. A complete verification requires all 20 cases. Keep the generated
bundle and `SOURCE.json` together; the browser verifies JavaScript, CSS and HTML
hashes first. Verification also checks report/source equality and matching browser
and native source commits.

On macOS with Xcode, add the native host measurements:

```sh
python3 apps/capture/test-tools/iphone-performance/build-swift.py --output /tmp/scribe-iphone-performance-run1
node apps/capture/test-tools/iphone-performance/verify.mjs --output /tmp/scribe-iphone-performance-run1 --native
```

A restricted sandbox may need permission for the loopback listener/headless
browser and for macOS Security to generate the test RSA key. The RSA fixture sets
`kSecAttrIsPermanent: false`; recording key storage is in memory. Do not replace
these fixtures with a real device, microphone or service to work around a failure.

`build-swift.py` preserves command logs and checks, builds the unchanged product
sources used by the existing native lifecycle suite, exposes only the synthetic
fixture's private test owners, and runs seven timing scenarios. Each compilation
command has a 600-second deadline, and the timing executable has a 60-second
deadline. A timeout records a failed receipt and exit code 124. To repeat timings
without rebuilding, invoke the generated `swift/timing` executable and save stdout
as `swift/timing.log`. Preserve any older result if comparison is needed.

## What the gate means

The browser uses `performance.now()` and waits two animation frames after completed
UI state. Recording success requires the actual input meter to report converted
input. An armed engine, advancing timer, spinner or recording phase alone does not
pass. Error and cancellation screens are separate actionable outcomes; they never
count as successful recording. A retained creation request must reuse its original
creation key, and the pending journal clears only after the matching result.

Reports contain both measured elapsed times and injected milliseconds. “Cold” and
“repeat” browser service profiles are explicit simulations; their difference is
not a measured physical cache benefit. Resume additionally exercises the same
controller after a confirmed pause. Native open and start times are separate and
exclude generating the fixture's RSA wrapping key. Native timings include real
host custody, durable-intent logic and encryption of a generated packet, but omit
real transport, Keychain I/O, AVAudioSession and physical input startup.

The injected 4.5-second configuration, mount, create, start and lease cases are
expected to **fail** the four-second success gate. The no-input case also fails.
These failures remain visible in the JSON; they must not be relabeled as passing
because the harness itself passed its assertions. Cancellation and explicit
failure should still produce usable controls promptly.

The current and legacy opening cases assign the same synthetic service costs and
per-request latency. They verify the existing fused opening avoids one native RPC.
This establishes a structural saving for the fixture, not a staging speed claim.

`VERIFIED.json` hashes the evidence and tool inputs. `SOURCE.json` inventories the
bundled product files and records commit, working-tree status and tracked diff
hash. The builder compares these before and after building and rejects changed
source inputs. The native
source inventory is in `swift/SOURCE.json`. Later device acceptance still needs
actual cold/repeat/resume tests with start-to-first-converted-input evidence.

Run the focused CLI and evidence-integrity regressions with:

```sh
node --test apps/capture/test-tools/iphone-performance/cli.test.mjs
```
